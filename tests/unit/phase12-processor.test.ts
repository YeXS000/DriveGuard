import type { PendingAction } from "@driveguard/action-lifecycle";
import type { ExecutionResult } from "@driveguard/executor";
import { toUtcTimestamp } from "@driveguard/domain";
import type { PolicyDecision } from "@driveguard/policy";
import { FixedClock } from "@driveguard/shared";
import type {
  UrgentActionDispatchPort,
  UrgentActionDispatchResult,
  UrgentEventNotification,
  UrgentEventRecord,
  UrgentEventRepository,
} from "@driveguard/urgent-events";
import {
  UrgentEventPermanentError,
  UrgentEventProcessor,
  UrgentEventTransientError,
  parseUrgentEvent,
  urgentEventFingerprint,
} from "@driveguard/urgent-events";
import { describe, expect, it, vi } from "vitest";

import { createValidSnapshot, PHASE_2_NOW_MS } from "../fixtures/phase2-domain.js";

function rawEvent(
  eventType: string,
  payload: unknown,
  eventId = `event-${eventType.toLowerCase()}`,
) {
  return {
    eventId,
    schemaVersion: 1,
    eventType,
    source: "SIMULATOR",
    vehicleId: "vehicle-001",
    occurredAt: "2026-08-25T09:59:59.000Z",
    receivedAt: "2026-08-25T10:00:00.000Z",
    severity: "INFO",
    payload,
    correlationId: `correlation-${eventId}`,
  };
}

function policyDecision(
  decision: "ALLOW" | "DENY" | "REQUIRE_CONFIRMATION" | "REPLAN",
): PolicyDecision {
  return Object.freeze({
    decision,
    ruleId: "phase12-test",
    reasonCode:
      decision === "ALLOW"
        ? ("R0_ALLOWED" as const)
        : decision === "DENY"
          ? ("DEFAULT_DENY" as const)
          : decision === "REPLAN"
            ? ("CONTEXT_RELEVANT_STATE_CHANGED" as const)
            : ("R3_CONFIRMATION_REQUIRED" as const),
    toolName: "request_roadside_assistance",
    riskLevel: decision === "ALLOW" ? ("R0" as const) : ("R3" as const),
    contextSnapshotId: "snapshot-1",
    contextVersion: 1,
    evaluatedAt: toUtcTimestamp(PHASE_2_NOW_MS),
    evidence: {
      freshnessStatus: "FRESH" as const,
      conflictStatus: "NO_CONFLICT" as const,
      contextChanged: false,
      requiredCapabilityAvailable: true,
      serviceAvailable: true,
    },
  });
}

class MemoryUrgentRepository implements UrgentEventRepository {
  readonly records = new Map<string, UrgentEventRecord>();

  claim(input: Parameters<UrgentEventRepository["claim"]>[0]) {
    const existing = this.records.get(input.event.eventId);
    if (existing !== undefined && existing.status !== "FAILED") {
      if (existing.eventFingerprint !== urgentEventFingerprint(input.event)) {
        return Promise.resolve(Object.freeze({ kind: "CONFLICT" as const, record: existing }));
      }
      return Promise.resolve(Object.freeze({ kind: "DUPLICATE" as const, record: existing }));
    }
    const record = Object.freeze({
      eventId: input.event.eventId,
      eventFingerprint: urgentEventFingerprint(input.event),
      eventType: input.event.eventType,
      vehicleId: input.event.vehicleId,
      severity: input.severity,
      status: "PROCESSING" as const,
      receivedAt: input.event.receivedAt,
      processedAt: null,
      correlationId: input.event.correlationId,
      processingOwner: input.ownerId,
      processingExpiresAt: input.now,
      attemptCount: (existing?.attemptCount ?? 0) + 1,
      result: { safeSummary: "processing" },
    });
    this.records.set(record.eventId, record);
    return Promise.resolve(Object.freeze({ kind: "CLAIMED" as const, record }));
  }

  complete(input: Parameters<UrgentEventRepository["complete"]>[0]) {
    const existing = this.records.get(input.eventId);
    if (existing?.processingOwner !== input.ownerId) return Promise.reject(new Error("owner"));
    const record = Object.freeze({
      ...existing,
      status: input.status,
      processedAt: input.processedAt,
      processingOwner: null,
      processingExpiresAt: null,
      result: Object.freeze(structuredClone(input.result)),
    });
    this.records.set(record.eventId, record);
    return Promise.resolve(record);
  }

  rejectInvalid(input: Parameters<UrgentEventRepository["rejectInvalid"]>[0]) {
    const record = Object.freeze({
      eventId: input.eventId,
      eventFingerprint: "f".repeat(64),
      eventType: "UNKNOWN" as const,
      vehicleId: input.vehicleId,
      severity: "WARNING" as const,
      status: "REJECTED" as const,
      receivedAt: input.receivedAt,
      processedAt: input.processedAt,
      correlationId: input.correlationId,
      processingOwner: null,
      processingExpiresAt: null,
      attemptCount: 1,
      result: Object.freeze({ safeSummary: "invalid", resultCode: input.resultCode }),
    });
    this.records.set(record.eventId, record);
    return Promise.resolve(record);
  }

  get(eventId: string) {
    return Promise.resolve(this.records.get(eventId));
  }

  listByVehicle(vehicleId: string) {
    return Promise.resolve([...this.records.values()].filter((row) => row.vehicleId === vehicleId));
  }
}

function loadedContext() {
  const snapshot = createValidSnapshot();
  return Object.freeze({
    snapshot,
    services: { vehicleSimulator: true, weather: true, emergencySupport: true },
    freshness: {
      status: "FRESH" as const,
      context: {
        status: "FRESH" as const,
        ageMs: 0,
        maxAgeMs: 5_000,
        snapshotVersion: snapshot.contextVersion,
        latestVersion: snapshot.contextVersion,
      },
      vehicle: {
        status: "FRESH" as const,
        ageMs: 0,
        maxAgeMs: 5_000,
        snapshotVersion: snapshot.contextVersion,
      },
      trip: {
        status: "FRESH" as const,
        ageMs: 0,
        maxAgeMs: 5_000,
        snapshotVersion: snapshot.contextVersion,
      },
    },
  });
}

function executedResult(): UrgentActionDispatchResult {
  const execution: ExecutionResult = Object.freeze({
    executionId: "urgent-execution:test",
    toolName: "get_charging_status",
    status: "SUCCEEDED",
    attemptCount: 1,
    deduplicated: false,
    startedAt: toUtcTimestamp(PHASE_2_NOW_MS),
    completedAt: toUtcTimestamp(PHASE_2_NOW_MS),
    result: { chargingState: "fault" },
  });
  return Object.freeze({
    outcome: "EXECUTED",
    policyDecision: policyDecision("ALLOW"),
    execution,
    runId: "urgent-run:test",
    sessionId: "urgent-session:test",
    traceId: "11111111111111111111111111111111",
    toolName: "get_charging_status",
  });
}

function confirmationResult(): UrgentActionDispatchResult {
  const action: PendingAction = Object.freeze({
    actionId: "urgent-action:test",
    sessionId: "urgent-session:test",
    runId: "urgent-run:test",
    traceId: "11111111111111111111111111111111",
    userId: "user-001",
    vehicleId: "vehicle-001",
    toolName: "request_roadside_assistance",
    validatedArguments: { reason: "Vehicle fault TEST" },
    riskLevel: "R3",
    policyDecision: policyDecision("REQUIRE_CONFIRMATION"),
    policyRuleId: "phase12-test",
    contextSnapshotId: "snapshot-1",
    contextVersion: 1,
    createdAt: toUtcTimestamp(PHASE_2_NOW_MS),
    expiresAt: toUtcTimestamp(PHASE_2_NOW_MS + 60_000),
    actionFingerprint: "a".repeat(64),
    confirmationSummary: "Confirm roadside assistance",
    state: "AWAITING_CONFIRMATION",
    updatedAt: toUtcTimestamp(PHASE_2_NOW_MS),
    stateHistory: [],
  });
  return Object.freeze({
    outcome: "CONFIRMATION_REQUIRED",
    policyDecision: policyDecision("REQUIRE_CONFIRMATION"),
    action,
    safeResult: {
      actionId: action.actionId,
      toolName: action.toolName,
      riskLevel: action.riskLevel,
      expiresAt: action.expiresAt,
      summary: action.confirmationSummary,
    },
    confirmationCredential: "credential-safe-for-hmi",
    runId: action.runId,
    sessionId: action.sessionId,
    traceId: action.traceId,
    toolName: action.toolName,
  });
}

function harness(dispatchResult: UrgentActionDispatchResult = confirmationResult()) {
  const repository = new MemoryUrgentRepository();
  const notifications: UrgentEventNotification[] = [];
  const dispatch = vi.fn<UrgentActionDispatchPort["dispatch"]>().mockResolvedValue(dispatchResult);
  const contextLoader = { load: vi.fn().mockResolvedValue(loadedContext()) };
  const processor = new UrgentEventProcessor({
    repository,
    contextLoader,
    dispatcher: { dispatch },
    clock: new FixedClock(PHASE_2_NOW_MS),
    userId: "user-001",
    notificationSink: {
      emit: (notification) => {
        notifications.push(notification);
      },
    },
    ownerIdFactory: () => "owner-1",
  });
  return { repository, notifications, dispatch, contextLoader, processor };
}

describe("Phase 12 urgent-event processing and durable deduplication", () => {
  it("creates one confirmation action and stores only safe result metadata", async () => {
    const subject = harness();
    const result = await subject.processor.process(
      rawEvent("VEHICLE_FAULT", { faultCode: "TEST", critical: true }),
    );
    expect(result.record).toMatchObject({
      status: "HANDLED",
      result: {
        actionId: "urgent-action:test",
        requiresConfirmation: true,
        policyDecision: "REQUIRE_CONFIRMATION",
      },
    });
    expect(JSON.stringify(result.record)).not.toContain("credential-safe-for-hmi");
    expect(subject.notifications.at(-1)).toMatchObject({
      notificationType: "urgent.confirmation_required",
      confirmationCredential: "credential-safe-for-hmi",
    });
  });

  it("deduplicates repeated eventId before a second business dispatch", async () => {
    const subject = harness();
    const input = rawEvent("VEHICLE_FAULT", { faultCode: "TEST", critical: false });
    await subject.processor.process(input);
    const duplicate = await subject.processor.process(input);
    expect(duplicate.disposition).toBe("DUPLICATE");
    expect(subject.dispatch).toHaveBeenCalledTimes(1);
  });

  it("rejects an eventId collision with different validated content", async () => {
    const subject = harness();
    const first = rawEvent(
      "VEHICLE_FAULT",
      { faultCode: "FIRST", critical: false },
      "event-collision",
    );
    const collision = rawEvent(
      "VEHICLE_FAULT",
      { faultCode: "SECOND", critical: true },
      "event-collision",
    );
    await subject.processor.process(first);
    const result = await subject.processor.process(collision);
    expect(result).toMatchObject({ disposition: "REJECTED", invalidEventId: "event-collision" });
    expect(subject.dispatch).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent identical events", async () => {
    const subject = harness();
    const input = rawEvent("VEHICLE_FAULT", { faultCode: "TEST", critical: false });
    const results = await Promise.allSettled([
      subject.processor.process(input),
      subject.processor.process(input),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const retry = await subject.processor.process(input);
    expect(retry.disposition).toBe("DUPLICATE");
    expect(subject.dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not ACK away a redelivery while the durable processing lease is active", async () => {
    const subject = harness();
    const input = rawEvent("VEHICLE_FAULT", { faultCode: "TEST", critical: false });
    const parsedReceivedAt = input.receivedAt as ReturnType<typeof toUtcTimestamp>;
    subject.repository.records.set(
      input.eventId,
      Object.freeze({
        eventId: input.eventId,
        eventFingerprint: urgentEventFingerprint(
          parseUrgentEvent(rawEvent("VEHICLE_FAULT", { faultCode: "TEST", critical: false })),
        ),
        eventType: "VEHICLE_FAULT",
        vehicleId: input.vehicleId,
        severity: "HIGH",
        status: "PROCESSING",
        receivedAt: parsedReceivedAt,
        processedAt: null,
        correlationId: input.correlationId,
        processingOwner: "crashed-owner",
        processingExpiresAt: toUtcTimestamp(PHASE_2_NOW_MS + 30_000),
        attemptCount: 1,
        result: Object.freeze({ safeSummary: "processing" }),
      }),
    );
    await expect(subject.processor.process(input)).rejects.toMatchObject({
      retryDelayMs: 30_100,
    });
    expect(subject.dispatch).not.toHaveBeenCalled();
  });

  it("rejects invalid input with zero business dispatch", async () => {
    const subject = harness();
    const result = await subject.processor.process({
      ...rawEvent("LOW_SOC", { reportedSoc: 5 }),
      schemaVersion: 999,
    });
    expect(result.disposition).toBe("REJECTED");
    expect(subject.dispatch).not.toHaveBeenCalled();
  });

  it("fails closed as REPLAN_REQUIRED when Context is unavailable", async () => {
    const subject = harness();
    subject.contextLoader.load.mockRejectedValueOnce(new Error("offline"));
    const result = await subject.processor.process(
      rawEvent("VEHICLE_FAULT", { faultCode: "TEST", critical: true }),
    );
    expect(result.record).toMatchObject({
      status: "REPLAN_REQUIRED",
      result: { resultCode: "CONTEXT_UNAVAILABLE" },
    });
    expect(subject.dispatch).not.toHaveBeenCalled();
  });

  it("uses refreshed state to resolve stale LOW_SOC without dispatch", async () => {
    const subject = harness();
    const result = await subject.processor.process(rawEvent("LOW_SOC", { reportedSoc: 5 }));
    expect(result.record).toMatchObject({
      status: "HANDLED",
      result: { resultCode: "NO_ACTION_REQUIRED" },
    });
    expect(subject.dispatch).not.toHaveBeenCalled();
  });

  it("persists a successful R0 execution ID", async () => {
    const subject = harness(executedResult());
    const loaded = loadedContext();
    subject.contextLoader.load.mockResolvedValue({
      ...loaded,
      snapshot: Object.freeze({
        ...loaded.snapshot,
        vehicle: Object.freeze({ ...loaded.snapshot.vehicle, chargingState: "fault" }),
      }),
    });
    const result = await subject.processor.process(
      rawEvent("CHARGING_INTERRUPTED", { reasonCode: "POWER_LOSS" }),
    );
    expect(result.record?.result).toMatchObject({
      executionId: "urgent-execution:test",
      policyDecision: "ALLOW",
    });
  });

  it.each([
    ["DENIED", "REJECTED"],
    ["REPLAN_REQUIRED", "REPLAN_REQUIRED"],
  ] as const)("maps dispatcher %s to %s", async (outcome, expectedStatus) => {
    const result: UrgentActionDispatchResult = Object.freeze({
      outcome,
      policyDecision: policyDecision(outcome === "DENIED" ? "DENY" : "REPLAN"),
      runId: "urgent-run:test",
      sessionId: "urgent-session:test",
      traceId: "11111111111111111111111111111111",
      toolName: "request_roadside_assistance",
    });
    const subject = harness(result);
    const processed = await subject.processor.process(
      rawEvent("VEHICLE_FAULT", { faultCode: "TEST", critical: false }),
    );
    expect(processed.record?.status).toBe(expectedStatus);
  });

  it("marks permanent dispatcher failure REJECTED without retry", async () => {
    const subject = harness();
    subject.dispatch.mockRejectedValueOnce(new UrgentEventPermanentError());
    const result = await subject.processor.process(
      rawEvent("VEHICLE_FAULT", { faultCode: "TEST", critical: false }),
    );
    expect(result).toMatchObject({ disposition: "REJECTED", record: { status: "REJECTED" } });
  });

  it("marks transient dispatcher failure FAILED and requests redelivery", async () => {
    const subject = harness();
    subject.dispatch.mockRejectedValueOnce(new UrgentEventTransientError());
    await expect(
      subject.processor.process(rawEvent("VEHICLE_FAULT", { faultCode: "TEST", critical: false })),
    ).rejects.toBeInstanceOf(UrgentEventTransientError);
    expect(subject.repository.records.get("event-vehicle_fault")?.status).toBe("FAILED");
  });
});
