import type { PolicyDecisionType } from "@driveguard/policy";
import type { UtcTimestamp } from "@driveguard/domain";

import type { UrgentEvent, UrgentEventSeverity, UrgentEventType } from "./model.js";

export const URGENT_EVENT_STATUSES = [
  "RECEIVED",
  "PROCESSING",
  "HANDLED",
  "REJECTED",
  "REPLAN_REQUIRED",
  "FAILED",
] as const;
export type UrgentEventStatus = (typeof URGENT_EVENT_STATUSES)[number];

export interface UrgentEventResultMetadata {
  readonly safeSummary: string;
  readonly toolName?: string;
  readonly policyDecision?: PolicyDecisionType;
  readonly actionId?: string;
  readonly executionId?: string;
  readonly requiresConfirmation?: boolean;
  readonly resultCode?: string;
}

export interface UrgentEventRecord {
  readonly eventId: string;
  readonly eventFingerprint: string;
  readonly eventType: UrgentEventType | "UNKNOWN";
  readonly vehicleId: string;
  readonly severity: UrgentEventSeverity;
  readonly status: UrgentEventStatus;
  readonly receivedAt: UtcTimestamp;
  readonly processedAt: UtcTimestamp | null;
  readonly correlationId: string;
  readonly processingOwner: string | null;
  readonly processingExpiresAt: UtcTimestamp | null;
  readonly attemptCount: number;
  readonly result: UrgentEventResultMetadata;
}

export type UrgentEventClaim =
  | Readonly<{ readonly kind: "CLAIMED"; readonly record: UrgentEventRecord }>
  | Readonly<{ readonly kind: "DUPLICATE"; readonly record: UrgentEventRecord }>
  | Readonly<{ readonly kind: "CONFLICT"; readonly record: UrgentEventRecord }>;

export interface UrgentEventRepository {
  claim(input: {
    readonly event: UrgentEvent;
    readonly severity: UrgentEventSeverity;
    readonly ownerId: string;
    readonly now: UtcTimestamp;
    readonly leaseMs: number;
  }): Promise<UrgentEventClaim>;
  complete(input: {
    readonly eventId: string;
    readonly ownerId: string;
    readonly status: Exclude<UrgentEventStatus, "RECEIVED" | "PROCESSING">;
    readonly processedAt: UtcTimestamp;
    readonly result: UrgentEventResultMetadata;
  }): Promise<UrgentEventRecord>;
  rejectInvalid(input: {
    readonly eventId: string;
    readonly eventType: string;
    readonly vehicleId: string;
    readonly receivedAt: UtcTimestamp;
    readonly correlationId: string;
    readonly processedAt: UtcTimestamp;
    readonly resultCode: string;
  }): Promise<UrgentEventRecord>;
  get(eventId: string): Promise<UrgentEventRecord | undefined>;
  listByVehicle(vehicleId: string, limit?: number): Promise<readonly UrgentEventRecord[]>;
}
