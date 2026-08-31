import type { UtcTimestamp } from "@driveguard/domain";
import type { PolicyDecisionType } from "@driveguard/policy";

import type { UrgentEventSeverity, UrgentEventType } from "./model.js";
import type { UrgentEventStatus } from "./repository.js";

export const URGENT_OBSERVATION_TYPES = [
  "urgent.event.received",
  "urgent.event.duplicate",
  "urgent.event.rejected",
  "urgent.event.processed",
  "urgent.event.failed",
  "urgent.context.load.started",
  "urgent.context.load.completed",
  "urgent.policy.evaluate.started",
  "urgent.policy.evaluate.completed",
  "urgent.executor.started",
  "urgent.executor.completed",
  "urgent.confirmation.required",
] as const;
export type UrgentObservationType = (typeof URGENT_OBSERVATION_TYPES)[number];

export interface UrgentEventObservation {
  readonly observationType: UrgentObservationType;
  readonly eventId: string;
  readonly eventType: UrgentEventType | "UNKNOWN";
  readonly severity: UrgentEventSeverity;
  readonly status: UrgentEventStatus;
  readonly runId: string;
  readonly traceId: string;
  readonly timestamp: UtcTimestamp;
  readonly toolName?: string;
  readonly actionId?: string;
  readonly executionId?: string;
  readonly policyDecision?: PolicyDecisionType;
  readonly errorCode?: string;
}

export interface UrgentEventObserver {
  observe(event: UrgentEventObservation): void;
}

export const NOOP_URGENT_EVENT_OBSERVER: UrgentEventObserver = Object.freeze({
  observe: () => undefined,
});
