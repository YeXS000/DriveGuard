import type {
  AfterToolCallContext,
  AfterToolCallResult,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";

export const PHASE_1_ALLOWED_TOOL_NAMES = ["get_vehicle_state", "get_trip_state"] as const;

export type Phase1AllowedToolName = (typeof PHASE_1_ALLOWED_TOOL_NAMES)[number];

export interface Phase1InstrumentationRecord {
  readonly stage: "beforeToolCall" | "afterToolCall";
  readonly toolName: string;
  readonly allowed: boolean;
  readonly isError?: boolean;
}

const phase1AllowedToolNames = new Set<string>(PHASE_1_ALLOWED_TOOL_NAMES);

/** Phase 1 instrumentation and allow-list boundary verification; this is not a Policy Engine. */
export class Phase1ToolInstrumentation {
  readonly #records: Phase1InstrumentationRecord[] = [];

  readonly beforeToolCall = (
    context: BeforeToolCallContext,
  ): Promise<BeforeToolCallResult | undefined> => {
    const allowed = phase1AllowedToolNames.has(context.toolCall.name);
    this.#records.push({ stage: "beforeToolCall", toolName: context.toolCall.name, allowed });

    if (!allowed) {
      return Promise.resolve({
        block: true,
        reason: "Tool is outside the Phase 1 read-only allow-list",
        terminate: true,
      });
    }

    return Promise.resolve(undefined);
  };

  readonly afterToolCall = (
    context: AfterToolCallContext,
  ): Promise<AfterToolCallResult | undefined> => {
    const allowed = phase1AllowedToolNames.has(context.toolCall.name);
    this.#records.push({
      stage: "afterToolCall",
      toolName: context.toolCall.name,
      allowed,
      isError: context.isError,
    });
    return Promise.resolve(undefined);
  };

  get size(): number {
    return this.#records.length;
  }

  slice(start = 0): readonly Phase1InstrumentationRecord[] {
    return this.#records.slice(start);
  }
}
