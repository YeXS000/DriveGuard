import { Writable } from "node:stream";

import { toUtcTimestamp } from "@driveguard/domain";
import { DriveGuardMetrics, DriveGuardObservability } from "@driveguard/observability";
import {
  UrgentEventNotificationHub,
  type UrgentEventNotification,
  type UrgentEventRecord,
  type UrgentEventRepository,
} from "@driveguard/urgent-events";
import { afterEach, describe, expect, it } from "vitest";

import { UrgentApiService } from "../../apps/api/src/urgent.js";

const now = toUtcTimestamp(Date.now());

function discardLogs(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

function observation(
  observationType:
    | "urgent.event.received"
    | "urgent.context.load.started"
    | "urgent.context.load.completed"
    | "urgent.policy.evaluate.started"
    | "urgent.policy.evaluate.completed"
    | "urgent.event.processed",
) {
  return {
    observationType,
    eventId: "urgent-observed-1",
    eventType: "LOW_SOC" as const,
    severity: "CRITICAL" as const,
    status:
      observationType === "urgent.event.processed" ? ("HANDLED" as const) : ("PROCESSING" as const),
    runId: "urgent-run:observed",
    traceId: "1".repeat(32),
    timestamp: now,
    ...(observationType === "urgent.policy.evaluate.completed"
      ? { policyDecision: "REQUIRE_CONFIRMATION" as const }
      : {}),
  };
}

const systems: DriveGuardObservability[] = [];

afterEach(async () => {
  await Promise.all(systems.splice(0).map((system) => system.shutdown()));
});

describe("Phase 12 urgent observability", () => {
  it("records required metrics with bounded labels and no identifiers", async () => {
    const metrics = new DriveGuardMetrics({ collectProcessMetrics: false });
    metrics.observeUrgent(observation("urgent.event.received"));
    metrics.observeUrgent(observation("urgent.event.processed"));
    const text = await metrics.metrics();
    expect(text).toContain("driveguard_urgent_events_total");
    expect(text).toContain("driveguard_urgent_event_processing_duration_seconds");
    expect(text).toContain("driveguard_urgent_event_duplicates_total");
    expect(text).toContain('event_type="LOW_SOC",severity="CRITICAL",status="HANDLED"');
    expect(text).not.toMatch(/urgent-observed-1|vehicle-001|urgent-run:observed/u);
  });

  it("creates the required NATS to Context to Policy trace chain", async () => {
    const system = new DriveGuardObservability({
      service: "phase12-test",
      logDestination: discardLogs(),
      collectProcessMetrics: false,
      captureInMemoryTracing: true,
    });
    systems.push(system);
    for (const type of [
      "urgent.event.received",
      "urgent.context.load.started",
      "urgent.context.load.completed",
      "urgent.policy.evaluate.started",
      "urgent.policy.evaluate.completed",
      "urgent.event.processed",
    ] as const) {
      system.urgentEventObserver.observe(observation(type));
    }
    await system.tracing.forceFlush();
    const spans = system.tracing.finishedSpans();
    const consume = spans.find((span) => span.name === "nats.consume");
    const process = spans.find((span) => span.name === "urgent.process");
    const context = spans.find((span) => span.name === "context.load");
    const policy = spans.find((span) => span.name === "policy.evaluate");
    expect(process?.parentSpanContext?.spanId).toBe(consume?.spanContext().spanId);
    expect(context?.parentSpanContext?.spanId).toBe(process?.spanContext().spanId);
    expect(policy?.parentSpanContext?.spanId).toBe(process?.spanContext().spanId);
  });
});

class ApiRepository implements UrgentEventRepository {
  readonly record: UrgentEventRecord = Object.freeze({
    eventId: "api-event-1",
    eventFingerprint: "a".repeat(64),
    eventType: "VEHICLE_FAULT",
    vehicleId: "vehicle-001",
    severity: "CRITICAL",
    status: "HANDLED",
    receivedAt: now,
    processedAt: now,
    correlationId: "correlation-api-1",
    processingOwner: null,
    processingExpiresAt: null,
    attemptCount: 1,
    result: Object.freeze({
      safeSummary: "User confirmation is required.",
      actionId: "action-api-1",
      requiresConfirmation: true,
      toolName: "request_roadside_assistance",
    }),
  });

  claim(): Promise<never> {
    return Promise.reject(new Error("not used"));
  }

  complete(): Promise<never> {
    return Promise.reject(new Error("not used"));
  }

  rejectInvalid(): Promise<never> {
    return Promise.reject(new Error("not used"));
  }

  get(eventId: string) {
    return Promise.resolve(eventId === this.record.eventId ? this.record : undefined);
  }

  listByVehicle(vehicleId: string) {
    return Promise.resolve(vehicleId === this.record.vehicleId ? [this.record] : []);
  }
}

function notification(overrides: Partial<UrgentEventNotification> = {}): UrgentEventNotification {
  return Object.freeze({
    notificationId: "notification-1",
    notificationType: "urgent.confirmation_required",
    eventId: "api-event-1",
    eventType: "VEHICLE_FAULT",
    vehicleId: "vehicle-001",
    userId: "user-001",
    severity: "CRITICAL",
    status: "HANDLED",
    safeSummary: "User confirmation is required.",
    runId: "urgent-run:api",
    traceId: "2".repeat(32),
    timestamp: now,
    actionId: "action-api-1",
    sessionId: "session-api-1",
    toolName: "request_roadside_assistance",
    riskLevel: "R3",
    expiresAt: now,
    confirmationCredential: "trusted-credential",
    ...overrides,
  });
}

describe("Phase 12 urgent API safety boundary", () => {
  it("returns safe history without a raw event payload", async () => {
    const service = new UrgentApiService({
      repository: new ApiRepository(),
      hub: new UrgentEventNotificationHub(),
      userId: "user-001",
    });
    const result = await service.list({ userId: "user-001", vehicleId: "vehicle-001" });
    expect(result[0]).toMatchObject({
      eventId: "api-event-1",
      safeSummary: "User confirmation is required.",
      actionId: "action-api-1",
    });
    expect(JSON.stringify(result)).not.toMatch(/faultCode|critical|payload/u);
  });

  it("fails closed for another user or vehicle", async () => {
    const service = new UrgentApiService({
      repository: new ApiRepository(),
      hub: new UrgentEventNotificationHub(),
      userId: "user-001",
    });
    await expect(service.list({ userId: "other", vehicleId: "vehicle-001" })).rejects.toMatchObject(
      {
        statusCode: 404,
      },
    );
    await expect(
      service.get("api-event-1", { userId: "user-001", vehicleId: "other" }),
    ).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("filters live notifications by both user and vehicle identity", async () => {
    const hub = new UrgentEventNotificationHub();
    const service = new UrgentApiService({
      repository: new ApiRepository(),
      hub,
      userId: "user-001",
    });
    const received: unknown[] = [];
    const unsubscribe = service.subscribe(
      { userId: "user-001", vehicleId: "vehicle-001" },
      (event) => received.push(event),
    );
    await hub.emit(notification({ vehicleId: "other" }));
    await hub.emit(notification());
    unsubscribe();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ event_type: "urgent.confirmation_required" });
  });
});
