import type { UtcTimestamp } from "@driveguard/domain";

import type { UrgentEventSeverity, UrgentEventType } from "./model.js";
import type { UrgentEventStatus } from "./repository.js";

export const URGENT_NOTIFICATION_TYPES = [
  "urgent.received",
  "urgent.action_required",
  "urgent.confirmation_required",
  "urgent.resolved",
  "urgent.failed",
] as const;
export type UrgentNotificationType = (typeof URGENT_NOTIFICATION_TYPES)[number];

export interface UrgentEventNotification {
  readonly notificationId: string;
  readonly notificationType: UrgentNotificationType;
  readonly eventId: string;
  readonly eventType: UrgentEventType;
  readonly vehicleId: string;
  readonly userId: string;
  readonly severity: UrgentEventSeverity;
  readonly status: UrgentEventStatus;
  readonly safeSummary: string;
  readonly runId: string;
  readonly traceId: string;
  readonly timestamp: UtcTimestamp;
  readonly actionId?: string;
  readonly sessionId?: string;
  readonly toolName?: string;
  readonly riskLevel?: "R2" | "R3";
  readonly expiresAt?: UtcTimestamp;
  readonly confirmationCredential?: string;
}

export interface UrgentEventNotificationSink {
  emit(notification: UrgentEventNotification): void | Promise<void>;
}

export type UrgentNotificationListener = (
  notification: UrgentEventNotification,
) => void | Promise<void>;

export class UrgentEventNotificationHub implements UrgentEventNotificationSink {
  readonly #listeners = new Set<UrgentNotificationListener>();

  subscribe(listener: UrgentNotificationListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async emit(notification: UrgentEventNotification): Promise<void> {
    await Promise.allSettled(
      [...this.#listeners].map((listener) => Promise.resolve(listener(notification))),
    );
  }
}
