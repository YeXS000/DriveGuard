import { toUtcTimestamp, type UtcTimestamp } from "@driveguard/domain";
import type { Clock } from "@driveguard/shared";

export const RUNTIME_EVENT_TYPES = [
  "agent.run.started",
  "context.loaded",
  "capabilities.resolved",
  "model.started",
  "tool.requested",
  "policy.evaluation.started",
  "policy.decision.made",
  "policy.execution.blocked",
  "tool.completed",
  "model.resumed",
  "agent.run.completed",
  "agent.run.failed",
] as const;

export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number];

export interface RuntimeEventMetadata {
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly contextVersion?: number;
  readonly contextFreshness?: string;
  readonly availableToolCount?: number;
  readonly isError?: boolean;
  readonly errorCode?: string;
  readonly runtimeMode?: string;
  readonly boundary?: "PRE_POLICY" | "POLICY_GUARDED";
  readonly decision?: "ALLOW" | "DENY" | "REQUIRE_CONFIRMATION" | "REPLAN";
  readonly ruleId?: string;
}

export interface RuntimeEvent {
  readonly eventId: string;
  readonly eventType: RuntimeEventType;
  readonly runId: string;
  readonly sessionId: string;
  readonly traceId: string;
  readonly timestamp: UtcTimestamp;
  readonly metadata?: RuntimeEventMetadata;
}

export interface RuntimeEventSink {
  emit(event: RuntimeEvent): void | Promise<void>;
}

function cloneAndFreezeEvent(event: RuntimeEvent): RuntimeEvent {
  const clone = structuredClone(event);
  if (clone.metadata !== undefined) Object.freeze(clone.metadata);
  return Object.freeze(clone);
}

export class InMemoryRuntimeEventSink implements RuntimeEventSink {
  readonly #events: RuntimeEvent[] = [];

  emit(event: RuntimeEvent): void {
    this.#events.push(cloneAndFreezeEvent(event));
  }

  get size(): number {
    return this.#events.length;
  }

  slice(start = 0): readonly RuntimeEvent[] {
    return Object.freeze(this.#events.slice(start));
  }

  clear(): void {
    this.#events.length = 0;
  }
}

export interface RuntimeEventFactoryOptions {
  readonly clock: Clock;
  readonly eventIdFactory: () => string;
}

export class RuntimeEventFactory {
  readonly #clock: Clock;
  readonly #eventIdFactory: () => string;

  constructor(options: RuntimeEventFactoryOptions) {
    this.#clock = options.clock;
    this.#eventIdFactory = options.eventIdFactory;
  }

  create(
    eventType: RuntimeEventType,
    identity: { readonly runId: string; readonly sessionId: string; readonly traceId: string },
    metadata?: RuntimeEventMetadata,
  ): RuntimeEvent {
    return Object.freeze({
      eventId: this.#eventIdFactory(),
      eventType,
      runId: identity.runId,
      sessionId: identity.sessionId,
      traceId: identity.traceId,
      timestamp: toUtcTimestamp(this.#clock.nowMs()),
      ...(metadata === undefined ? {} : { metadata: Object.freeze({ ...metadata }) }),
    });
  }
}
