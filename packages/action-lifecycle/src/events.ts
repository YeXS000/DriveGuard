import type { UtcTimestamp } from "@driveguard/domain";

import type { ActionState } from "./types.js";

export const ACTION_LIFECYCLE_EVENT_TYPES = [
  "action.pending.created",
  "confirmation.accepted",
  "confirmation.rejected",
  "confirmation.expired",
  "action.revalidation.started",
  "action.revalidation.failed",
  "action.ready_for_execution",
  "action.cancelled",
] as const;
export type ActionLifecycleEventType = (typeof ACTION_LIFECYCLE_EVENT_TYPES)[number];

export interface ActionLifecycleEvent {
  readonly eventId: string;
  readonly eventType: ActionLifecycleEventType;
  readonly runId: string;
  readonly sessionId: string;
  readonly traceId: string;
  readonly actionId: string;
  readonly toolName: string;
  readonly timestamp: UtcTimestamp;
  readonly state: ActionState;
  readonly reason?: string;
}

export interface ActionLifecycleEventSink {
  emit(event: ActionLifecycleEvent): void | Promise<void>;
}

export class InMemoryActionLifecycleEventSink implements ActionLifecycleEventSink {
  readonly #events: ActionLifecycleEvent[] = [];

  emit(event: ActionLifecycleEvent): void {
    this.#events.push(Object.freeze(structuredClone(event)));
  }

  slice(): readonly ActionLifecycleEvent[] {
    return Object.freeze([...this.#events]);
  }
}
