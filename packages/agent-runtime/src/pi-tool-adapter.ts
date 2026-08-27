import type { AgentTool } from "@earendil-works/pi-agent-core";
import { ToolExecutionError, type ToolDefinition } from "@driveguard/tools";
import type { Static, TSchema } from "typebox";
import Schema from "typebox/schema";

export type Phase5RuntimeMode = "read_only" | "development";

export const PHASE_5_PRE_POLICY_NOTICE =
  "Phase 5 execution path is pre-Policy and not production-safe for side-effect tools." as const;

export interface FormalToolDetails {
  readonly source: "FORMAL_TOOL_CONTRACT";
  readonly toolName: string;
  readonly result: unknown;
  readonly runtimeMode: Phase5RuntimeMode;
  readonly safetyBoundary: "PRE_POLICY";
  readonly productionSafety: "NON_PRODUCTION";
}

export interface FormalToolExecutionEvidence {
  readonly toolName: string;
  readonly outcome: "succeeded" | "failed";
  readonly completedAfterCancel: boolean;
  readonly result?: unknown;
}

export type FormalToolExecutionObserver = (evidence: FormalToolExecutionEvidence) => void;

function toolResultText(toolName: string, result: unknown): string {
  return JSON.stringify({ toolName, result });
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export class PiToolAdapter {
  readonly #runtimeMode: Phase5RuntimeMode;
  readonly #observer: FormalToolExecutionObserver | undefined;
  readonly #activeExecutions = new Set<Promise<void>>();

  constructor(runtimeMode: Phase5RuntimeMode, observer?: FormalToolExecutionObserver) {
    this.#runtimeMode = runtimeMode;
    this.#observer = observer;
  }

  adapt(definition: ToolDefinition): AgentTool<TSchema, FormalToolDetails> {
    const inputValidator = Schema.Compile(definition.inputSchema);
    const outputValidator = Schema.Compile(definition.outputSchema);
    const tool: AgentTool<TSchema, FormalToolDetails> = {
      name: definition.name,
      label: definition.label,
      description: definition.description,
      parameters: definition.inputSchema,
      execute: async (_toolCallId: string, parameters: Static<TSchema>, signal?: AbortSignal) => {
        if (signalAborted(signal)) {
          throw new ToolExecutionError(
            "DEPENDENCY_UNAVAILABLE",
            definition.name,
            "Tool execution was cancelled before dispatch",
          );
        }
        let safeInput: Static<TSchema>;
        try {
          safeInput = structuredClone(parameters);
        } catch {
          throw new ToolExecutionError(
            "TOOL_VALIDATION_ERROR",
            definition.name,
            "Tool input could not be cloned safely",
          );
        }
        if (!inputValidator.Check(safeInput)) {
          throw new ToolExecutionError(
            "TOOL_VALIDATION_ERROR",
            definition.name,
            "Tool input failed the formal schema",
          );
        }
        const execution = definition.execute(safeInput);
        const settled = execution.then(
          () => undefined,
          () => undefined,
        );
        this.#activeExecutions.add(settled);
        void settled.then(() => this.#activeExecutions.delete(settled));
        let result: unknown;
        try {
          result = await execution;
        } catch (error) {
          this.#observer?.(
            Object.freeze({
              toolName: definition.name,
              outcome: "failed",
              completedAfterCancel: signalAborted(signal),
            }),
          );
          throw error;
        }
        if (!outputValidator.Check(result)) {
          this.#observer?.(
            Object.freeze({
              toolName: definition.name,
              outcome: "failed",
              completedAfterCancel: signalAborted(signal),
            }),
          );
          throw new ToolExecutionError(
            "DEPENDENCY_RESPONSE_INVALID",
            definition.name,
            "Tool output failed the formal schema",
          );
        }
        let safeResult: unknown;
        try {
          safeResult = structuredClone(result);
        } catch {
          this.#observer?.(
            Object.freeze({
              toolName: definition.name,
              outcome: "failed",
              completedAfterCancel: signalAborted(signal),
            }),
          );
          throw new ToolExecutionError(
            "DEPENDENCY_RESPONSE_INVALID",
            definition.name,
            "Tool output could not be cloned safely",
          );
        }
        const completedAfterCancel = signalAborted(signal);
        this.#observer?.(
          Object.freeze({
            toolName: definition.name,
            outcome: "succeeded",
            completedAfterCancel,
            result: safeResult,
          }),
        );
        if (completedAfterCancel) {
          throw new ToolExecutionError(
            "DEPENDENCY_UNAVAILABLE",
            definition.name,
            "Tool execution was cancelled after dependency settlement",
          );
        }
        return {
          content: [{ type: "text" as const, text: toolResultText(definition.name, safeResult) }],
          details: {
            source: "FORMAL_TOOL_CONTRACT" as const,
            toolName: definition.name,
            result: safeResult,
            runtimeMode: this.#runtimeMode,
            safetyBoundary: "PRE_POLICY" as const,
            productionSafety: "NON_PRODUCTION" as const,
          },
        };
      },
    };
    return Object.freeze(tool);
  }

  adaptAll(definitions: readonly ToolDefinition[]): readonly AgentTool[] {
    return Object.freeze(definitions.map((definition) => this.adapt(definition)));
  }

  async waitForIdle(): Promise<void> {
    while (this.#activeExecutions.size > 0) {
      await Promise.all([...this.#activeExecutions]);
    }
  }
}
