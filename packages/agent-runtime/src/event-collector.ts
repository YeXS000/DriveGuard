import type { AgentEvent } from "@earendil-works/pi-agent-core";

import { PHASE_1_ALLOWED_TOOL_NAMES } from "./instrumentation.js";

export type Phase1ObservedEventType = AgentEvent["type"];

export interface Phase1ObservedEvent {
  readonly type: Phase1ObservedEventType;
  readonly messageRole?: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly isError?: boolean;
}

/**
 * Minimal Phase 1 event collector. It intentionally retains lifecycle metadata only:
 * no message content, tool arguments, tool results, headers, or credentials.
 */
export class Phase1EventCollector {
  readonly #events: Phase1ObservedEvent[] = [];
  readonly #toolCallIds = new Map<string, string>();
  #nextToolCallId = 1;

  #safeToolCallId(rawId: string): string {
    const existing = this.#toolCallIds.get(rawId);
    if (existing !== undefined) return existing;
    const safeId = `phase1-tool-call-${this.#nextToolCallId}`;
    this.#nextToolCallId += 1;
    this.#toolCallIds.set(rawId, safeId);
    return safeId;
  }

  #safeToolName(rawName: string): string {
    return PHASE_1_ALLOWED_TOOL_NAMES.includes(
      rawName as (typeof PHASE_1_ALLOWED_TOOL_NAMES)[number],
    )
      ? rawName
      : "unregistered_tool";
  }

  readonly observe = (event: AgentEvent): void => {
    switch (event.type) {
      case "message_start":
      case "message_update":
      case "message_end":
        this.#events.push({ type: event.type, messageRole: event.message.role });
        return;
      case "tool_execution_start":
      case "tool_execution_update":
        this.#events.push({
          type: event.type,
          toolCallId: this.#safeToolCallId(event.toolCallId),
          toolName: this.#safeToolName(event.toolName),
        });
        return;
      case "tool_execution_end":
        this.#events.push({
          type: event.type,
          toolCallId: this.#safeToolCallId(event.toolCallId),
          toolName: this.#safeToolName(event.toolName),
          isError: event.isError,
        });
        return;
      default:
        this.#events.push({ type: event.type });
    }
  };

  get size(): number {
    return this.#events.length;
  }

  slice(start = 0): readonly Phase1ObservedEvent[] {
    return this.#events.slice(start);
  }

  clear(): void {
    this.#events.length = 0;
    this.#toolCallIds.clear();
    this.#nextToolCallId = 1;
  }
}
