import { Agent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import { createModels, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";

import { Phase1EventCollector, type Phase1ObservedEvent } from "./event-collector.js";
import {
  PHASE_1_ALLOWED_TOOL_NAMES,
  Phase1ToolInstrumentation,
  type Phase1InstrumentationRecord,
} from "./instrumentation.js";
import { createPhase1Tools } from "./phase1-tools.js";

const PHASE_1_PREFERRED_DEEPSEEK_MODEL_ID = "deepseek-v4-flash";

const PHASE_1_SYSTEM_PROMPT = `You are the minimal DriveGuard Phase 1 read-only assistant.
Only use get_vehicle_state for current vehicle or battery state and get_trip_state for current navigation or trip state.
Use a tool only when the user needs its fixture data. Do not invent tool results.
Never claim to control the vehicle or perform an external side effect.
The two tool results are explicitly PHASE_1_FIXTURE_ONLY.`;

export type Phase1RunStatus = "succeeded" | "failed";

export interface Phase1RunError {
  readonly code: "AGENT_ERROR";
  readonly message: string;
}

export interface Phase1RunResult {
  readonly status: Phase1RunStatus;
  readonly response: string;
  readonly events: readonly Phase1ObservedEvent[];
  readonly instrumentation: readonly Phase1InstrumentationRecord[];
  readonly terminalState: "idle" | "busy";
  readonly error?: Phase1RunError;
}

export interface CreatePhase1RuntimeOptions {
  readonly model: Model<string>;
  readonly streamFn: StreamFn;
  readonly sessionId?: string;
  readonly sensitiveValues?: readonly string[];
}

export interface Phase1ToolResultState {
  readonly toolName: string;
  readonly isError: boolean;
  readonly fixtureResult: boolean;
}

export interface Phase1AgentStateSnapshot {
  readonly isStreaming: boolean;
  readonly messageCount: number;
  readonly userMessageCount: number;
  readonly registeredToolNames: readonly string[];
  readonly toolResults: readonly Phase1ToolResultState[];
}

export interface DeepSeekPhase1Selection {
  readonly models: MutableModels;
  readonly model: Model<string>;
  readonly modelId: string;
  readonly providerId: "deepseek";
  readonly api: string;
}

export interface LivePhase1Runtime {
  readonly runtime: Phase1Runtime;
  readonly selection: DeepSeekPhase1Selection;
}

export class Phase1ConfigurationError extends Error {
  readonly code: "PHASE1_CONFIGURATION_ERROR";
  readonly variable: "DEEPSEEK_API_KEY" | "DEEPSEEK_MODEL";

  constructor(variable: Phase1ConfigurationError["variable"], message: string) {
    super(message);
    this.name = "Phase1ConfigurationError";
    this.code = "PHASE1_CONFIGURATION_ERROR";
    this.variable = variable;
  }

  toJSON(): { code: string; variable: string; message: string } {
    return { code: this.code, variable: this.variable, message: this.message };
  }
}

function assistantText(messages: readonly AgentMessage[]): string {
  const message = messages.findLast((candidate) => candidate.role === "assistant");
  if (message?.role !== "assistant") {
    return "";
  }

  return message.content
    .filter(
      (content): content is Extract<(typeof message.content)[number], { type: "text" }> =>
        content.type === "text",
    )
    .map((content) => content.text)
    .join("");
}

function sanitize(value: string, sensitiveValues: readonly string[]): string {
  let sanitized = value.replace(/authorization\s*:\s*bearer\s+\S+/giu, "[REDACTED]");

  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue.length > 0) {
      sanitized = sanitized.replaceAll(sensitiveValue, "[REDACTED]");
    }
  }

  return sanitized;
}

export class Phase1Runtime {
  readonly events = new Phase1EventCollector();
  readonly instrumentation = new Phase1ToolInstrumentation();
  readonly #agent: Agent;
  readonly #sensitiveValues: readonly string[];

  constructor(options: CreatePhase1RuntimeOptions) {
    this.#sensitiveValues = options.sensitiveValues ?? [];
    this.#agent = new Agent({
      initialState: {
        systemPrompt: PHASE_1_SYSTEM_PROMPT,
        model: options.model,
        thinkingLevel: "off",
        tools: createPhase1Tools(),
        messages: [],
      },
      streamFn: options.streamFn,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      toolExecution: "parallel",
      beforeToolCall: this.instrumentation.beforeToolCall,
      afterToolCall: this.instrumentation.afterToolCall,
    });
    this.#agent.subscribe(this.events.observe);
  }

  getStateSnapshot(): Phase1AgentStateSnapshot {
    return {
      isStreaming: this.#agent.state.isStreaming,
      messageCount: this.#agent.state.messages.length,
      userMessageCount: this.#agent.state.messages.filter((message) => message.role === "user")
        .length,
      registeredToolNames: this.#agent.state.tools.map((tool) => tool.name),
      toolResults: this.#agent.state.messages.flatMap((message) => {
        if (message.role !== "toolResult") return [];
        const details = message.details as unknown;
        const fixtureResult =
          typeof details === "object" &&
          details !== null &&
          "source" in details &&
          details.source === "PHASE_1_FIXTURE_ONLY";
        return [
          {
            toolName: PHASE_1_ALLOWED_TOOL_NAMES.includes(
              message.toolName as (typeof PHASE_1_ALLOWED_TOOL_NAMES)[number],
            )
              ? message.toolName
              : "unregistered_tool",
            isError: message.isError,
            fixtureResult,
          },
        ];
      }),
    };
  }

  #terminalState(): Phase1RunResult["terminalState"] {
    return this.#agent.state.isStreaming ? "busy" : "idle";
  }

  async run(prompt: string): Promise<Phase1RunResult> {
    if (this.#agent.state.isStreaming) {
      return {
        status: "failed",
        response: "",
        events: [],
        instrumentation: [],
        terminalState: "busy",
        error: { code: "AGENT_ERROR", message: "Agent is already processing a prompt" },
      };
    }

    const eventStart = this.events.size;
    const instrumentationStart = this.instrumentation.size;

    try {
      await this.#agent.prompt(prompt);
      const errorMessage = this.#agent.state.errorMessage;
      const response = sanitize(assistantText(this.#agent.state.messages), this.#sensitiveValues);

      if (errorMessage !== undefined) {
        return {
          status: "failed",
          response,
          events: this.events.slice(eventStart),
          instrumentation: this.instrumentation.slice(instrumentationStart),
          terminalState: this.#terminalState(),
          error: { code: "AGENT_ERROR", message: sanitize(errorMessage, this.#sensitiveValues) },
        };
      }

      return {
        status: "succeeded",
        response,
        events: this.events.slice(eventStart),
        instrumentation: this.instrumentation.slice(instrumentationStart),
        terminalState: this.#terminalState(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown agent error";
      return {
        status: "failed",
        response: "",
        events: this.events.slice(eventStart),
        instrumentation: this.instrumentation.slice(instrumentationStart),
        terminalState: this.#terminalState(),
        error: { code: "AGENT_ERROR", message: sanitize(message, this.#sensitiveValues) },
      };
    }
  }
}

export function createDeepSeekPhase1Selection(
  requestedModelId = process.env.DEEPSEEK_MODEL,
): DeepSeekPhase1Selection {
  const models = createModels();
  models.setProvider(deepseekProvider());
  const catalog = models.getModels("deepseek");
  const selectedId = requestedModelId ?? PHASE_1_PREFERRED_DEEPSEEK_MODEL_ID;
  const selected = models.getModel("deepseek", selectedId);

  if (selected === undefined) {
    throw new Phase1ConfigurationError(
      "DEEPSEEK_MODEL",
      `DEEPSEEK_MODEL must match the installed Pi DeepSeek catalog. Available model IDs: ${catalog
        .map((model) => model.id)
        .join(", ")}`,
    );
  }

  return {
    models,
    model: selected,
    modelId: selected.id,
    providerId: "deepseek",
    api: selected.api,
  };
}

export function createLivePhase1Runtime(): LivePhase1Runtime {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new Phase1ConfigurationError(
      "DEEPSEEK_API_KEY",
      "DEEPSEEK_API_KEY is required for the Phase 1 live DeepSeek runtime",
    );
  }

  const selection = createDeepSeekPhase1Selection();
  const runtime = new Phase1Runtime({
    model: selection.model,
    streamFn: selection.models.streamSimple.bind(selection.models),
    sessionId: "driveguard-phase1-live",
    sensitiveValues: [apiKey],
  });

  return { runtime, selection };
}
