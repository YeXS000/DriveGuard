import type { UtcTimestamp } from "@driveguard/domain";

export const EXECUTION_EVENT_TYPES = [
  "execution.started",
  "execution.attempt.started",
  "execution.attempt.failed",
  "execution.retry.scheduled",
  "execution.deduplicated",
  "circuit.opened",
  "circuit.half_open",
  "circuit.closed",
  "authorization.consumed",
  "execution.succeeded",
  "execution.failed",
  "execution.outcome_unknown",
] as const;
export type ExecutionEventType = (typeof EXECUTION_EVENT_TYPES)[number];

export interface ExecutionEvent {
  readonly eventType: ExecutionEventType;
  readonly executionId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly traceId: string;
  readonly actionId?: string;
  readonly toolName: string;
  readonly attempt: number;
  readonly timestamp: UtcTimestamp;
  readonly errorCode?: string;
  readonly delayMs?: number;
}

export interface ExecutionEventSink {
  emit(event: ExecutionEvent): void | Promise<void>;
}

export class InMemoryExecutionEventSink implements ExecutionEventSink {
  readonly #events: ExecutionEvent[] = [];

  emit(event: ExecutionEvent): void {
    this.#events.push(Object.freeze(structuredClone(event)));
  }

  slice(): readonly ExecutionEvent[] {
    return Object.freeze([...this.#events]);
  }
}
