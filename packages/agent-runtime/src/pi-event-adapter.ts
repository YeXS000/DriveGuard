import type { AgentEvent } from "@earendil-works/pi-agent-core";

import { AgentRun } from "./agent-run.js";
import { AgentRuntimeError } from "./runtime-errors.js";
import type { RuntimeEvent, RuntimeEventFactory } from "./runtime-events.js";

export interface PiEventAdapterOptions {
  readonly run: AgentRun;
  readonly exposedToolNames: readonly string[];
  readonly eventFactory: Pick<RuntimeEventFactory, "create">;
  readonly emit: (event: RuntimeEvent) => void | Promise<void>;
  readonly boundary?: "PRE_POLICY" | "POLICY_GUARDED";
  readonly assistantTextDelta?: (delta: string) => void | Promise<void>;
  readonly modelUsage?: (usage: ModelUsageEvent) => void | Promise<void>;
}

export interface ModelUsageEvent {
  readonly modelName: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cost: number;
  readonly isError: boolean;
}

export class PiEventAdapter {
  readonly #run: AgentRun;
  readonly #exposedToolNames: ReadonlySet<string>;
  readonly #eventFactory: Pick<RuntimeEventFactory, "create">;
  readonly #emit: (event: RuntimeEvent) => void | Promise<void>;
  readonly #boundary: "PRE_POLICY" | "POLICY_GUARDED";
  readonly #assistantTextDelta: ((delta: string) => void | Promise<void>) | undefined;
  readonly #modelUsage: ((usage: ModelUsageEvent) => void | Promise<void>) | undefined;
  readonly #toolCallIds = new Map<string, string>();
  readonly #activeToolCalls = new Map<string, string>();
  readonly #completedToolCalls = new Set<string>();
  #nextToolCallId = 1;
  #toolErrors = 0;

  constructor(options: PiEventAdapterOptions) {
    this.#run = options.run;
    this.#exposedToolNames = new Set(options.exposedToolNames);
    this.#eventFactory = options.eventFactory;
    this.#emit = options.emit;
    this.#boundary = options.boundary ?? "PRE_POLICY";
    this.#assistantTextDelta = options.assistantTextDelta;
    this.#modelUsage = options.modelUsage;
  }

  get toolErrorCount(): number {
    return this.#toolErrors;
  }

  assertComplete(): void {
    if (this.#activeToolCalls.size > 0) {
      throw new AgentRuntimeError(
        "INTERNAL_ERROR",
        "Pi event stream ended with incomplete Tool executions",
      );
    }
  }

  #safeToolName(name: string): string {
    return this.#exposedToolNames.has(name) ? name : "unregistered_tool";
  }

  #safeToolCallId(rawId: string): string {
    const existing = this.#toolCallIds.get(rawId);
    if (existing !== undefined) return existing;
    const safeId = `tool-call:${this.#nextToolCallId}`;
    this.#nextToolCallId += 1;
    this.#toolCallIds.set(rawId, safeId);
    return safeId;
  }

  async #runtimeEvent(
    eventType: RuntimeEvent["eventType"],
    metadata?: RuntimeEvent["metadata"],
  ): Promise<void> {
    await this.#emit(this.#eventFactory.create(eventType, this.#run, metadata));
  }

  readonly observe = async (event: AgentEvent): Promise<void> => {
    switch (event.type) {
      case "message_update":
        if (
          this.#assistantTextDelta !== undefined &&
          event.assistantMessageEvent?.type === "text_delta"
        ) {
          await this.#assistantTextDelta(event.assistantMessageEvent.delta);
        }
        return;
      case "turn_start":
        if (this.#run.status === "MODEL_RESUMED") {
          this.#run.transition("MODEL_RUNNING");
          await this.#runtimeEvent("model.started", { boundary: this.#boundary });
        }
        return;
      case "tool_execution_start": {
        if (
          this.#run.status !== "MODEL_RUNNING" &&
          this.#run.status !== "MODEL_RESUMED" &&
          this.#run.status !== "TOOL_PROCESSING"
        ) {
          throw new AgentRuntimeError(
            "INTERNAL_ERROR",
            "Pi event stream requested a Tool outside model execution",
          );
        }
        if (
          this.#activeToolCalls.has(event.toolCallId) ||
          this.#completedToolCalls.has(event.toolCallId)
        ) {
          throw new AgentRuntimeError("INTERNAL_ERROR", "Pi event stream repeated a Tool start");
        }
        this.#activeToolCalls.set(event.toolCallId, event.toolName);
        if (this.#run.status !== "TOOL_PROCESSING") {
          this.#run.transition("TOOL_REQUESTED");
          this.#run.transition("TOOL_PROCESSING");
        }
        await this.#runtimeEvent("tool.requested", {
          toolName: this.#safeToolName(event.toolName),
          toolCallId: this.#safeToolCallId(event.toolCallId),
          boundary: this.#boundary,
        });
        return;
      }
      case "tool_execution_end": {
        const startedToolName = this.#activeToolCalls.get(event.toolCallId);
        if (startedToolName === undefined) {
          throw new AgentRuntimeError(
            "INTERNAL_ERROR",
            "Pi event stream completed an unknown Tool call",
          );
        }
        if (startedToolName !== event.toolName) {
          throw new AgentRuntimeError(
            "INTERNAL_ERROR",
            "Pi event stream changed the Tool name for an active call",
          );
        }
        if (event.isError) this.#toolErrors += 1;
        await this.#runtimeEvent("tool.completed", {
          toolName: this.#safeToolName(event.toolName),
          toolCallId: this.#safeToolCallId(event.toolCallId),
          isError: event.isError,
          boundary: this.#boundary,
        });
        this.#activeToolCalls.delete(event.toolCallId);
        this.#completedToolCalls.add(event.toolCallId);
        return;
      }
      case "turn_end":
        if (event.message.role === "assistant") {
          await this.#modelUsage?.({
            modelName: event.message.model,
            inputTokens: event.message.usage.input,
            outputTokens: event.message.usage.output,
            cost: event.message.usage.cost.total,
            isError: event.message.stopReason === "error",
          });
        }
        if (event.toolResults.length > 0 && this.#run.status !== "TOOL_PROCESSING") {
          throw new AgentRuntimeError(
            "INTERNAL_ERROR",
            "Pi event stream reported Tool results outside Tool processing",
          );
        }
        if (event.toolResults.length > 0) {
          this.assertComplete();
          this.#run.transition("MODEL_RESUMED");
          await this.#runtimeEvent("model.resumed", { boundary: this.#boundary });
        }
        return;
      default:
        return;
    }
  };
}
