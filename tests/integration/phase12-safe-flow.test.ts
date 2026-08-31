import { createHash } from "node:crypto";

import { ContextLoader, type ContextProvider } from "@driveguard/agent-runtime";
import {
  ContextFreshnessEvaluator,
  ContextSnapshotBuilder,
  ContextSnapshotIdAllocator,
  ContextVersionAllocator,
} from "@driveguard/context";
import { toUtcTimestamp, type ContextSnapshot } from "@driveguard/domain";
import {
  ReliableToolExecutor,
  type ExecutionEvent,
  type ExecutionRequest,
  type ExecutionResult,
} from "@driveguard/executor";
import { InMemorySessionCoordinator, InMemorySessionRepository } from "@driveguard/memory";
import { createDefaultToolPolicyProfileRegistry, PolicyEngine } from "@driveguard/policy";
import { FixedClock } from "@driveguard/shared";
import type { ToolRegistry } from "@driveguard/tools";
import {
  UrgentActionDispatcher,
  UrgentEventPermanentError,
  UrgentEventTransientError,
  parseUrgentEvent,
} from "@driveguard/urgent-events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InMemoryPendingActionRepository } from "../../packages/action-lifecycle/src/repository.js";
import {
  createCapabilitiesInput,
  createSnapshotBuilder,
  createUserInput,
  createValidTripInput,
  createValidVehicleInput,
  createWeatherInput,
  PHASE_2_NOW_MS,
} from "../fixtures/phase2-domain.js";
import { createPhase4Harness } from "../fixtures/phase4-tools.js";

function urgentEvent(eventType: "LOW_SOC" | "CHARGING_INTERRUPTED") {
  return parseUrgentEvent({
    eventId: `event-${eventType.toLowerCase()}`,
    schemaVersion: 1,
    eventType,
    source: "SIMULATOR",
    vehicleId: "vehicle-001",
    occurredAt: "2026-08-25T09:59:59.000Z",
    receivedAt: "2026-08-25T10:00:00.000Z",
    severity: "HIGH",
    payload: eventType === "LOW_SOC" ? { reportedSoc: 5 } : { reasonCode: "POWER_LOSS" },
    correlationId: `correlation-${eventType.toLowerCase()}`,
  });
}

function snapshot(soc = 5): ContextSnapshot {
  return createSnapshotBuilder().create({
    vehicle: { ...createValidVehicleInput(), soc },
    trip: createValidTripInput(),
    weather: createWeatherInput(),
    user: createUserInput(),
    capabilities: createCapabilitiesInput(),
  });
}

function contextLoader(clock: FixedClock, currentSoc = 5): ContextLoader {
  const current = snapshot(currentSoc);
  const provider: ContextProvider = {
    loadVehicleState: () => Promise.resolve(structuredClone(current.vehicle)),
    loadTripState: () => Promise.resolve(structuredClone(current.trip)),
    loadWeatherState: () => Promise.resolve(structuredClone(current.weather)),
    loadUser: () => Promise.resolve(structuredClone(current.user)),
    loadCapabilities: () => Promise.resolve(structuredClone(current.capabilities)),
    loadServiceAvailability: () =>
      Promise.resolve({ vehicleSimulator: true, weather: true, emergencySupport: true }),
  };
  return new ContextLoader({
    provider,
    snapshotBuilder: new ContextSnapshotBuilder({
      clock,
      versionAllocator: new ContextVersionAllocator(),
      snapshotIdAllocator: new ContextSnapshotIdAllocator("phase12-current"),
    }),
    freshnessEvaluator: new ContextFreshnessEvaluator(clock),
  });
}

describe("Phase 12 formal Policy / Confirmation / Executor integration", () => {
  let harness: Awaited<ReturnType<typeof createPhase4Harness>>;

  beforeEach(async () => {
    harness = await createPhase4Harness();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  function dispatcher(
    options: {
      readonly registry?: ToolRegistry;
      readonly currentSoc?: number;
      readonly executionEvents?: ExecutionEvent[];
      readonly recoveredExecution?: Readonly<{
        readonly request: ExecutionRequest;
        readonly result: ExecutionResult | null;
      }>;
    } = {},
  ) {
    const clock = new FixedClock(PHASE_2_NOW_MS);
    const registry = options.registry ?? harness.registry;
    const pending = new InMemoryPendingActionRepository();
    const executionEvents = options.executionEvents ?? [];
    const executor = new ReliableToolExecutor({
      registry,
      authorizationConsumer: {
        consumeExecutionAuthorization: () => Promise.reject(new Error("not used by R0/R1")),
      },
      clock,
      eventSink: {
        emit: (event) => {
          executionEvents.push(event);
        },
      },
    });
    const profiles = createDefaultToolPolicyProfileRegistry();
    return {
      pending,
      executionEvents,
      subject: new UrgentActionDispatcher({
        contextLoader: contextLoader(clock, options.currentSoc ?? 5),
        registry,
        policyEngine: new PolicyEngine({ profiles }),
        policyProfiles: profiles,
        pendingActionRepository: pending,
        reliableExecutor: executor,
        sessionRepository: new InMemorySessionRepository(),
        sessionCoordinator: new InMemorySessionCoordinator(),
        executionRecovery: {
          get: () => Promise.resolve(options.recoveredExecution),
        },
        clock,
        userId: "user-001",
        confirmationSecret: "phase12-test-confirmation-secret-000000000000",
      }),
    };
  }

  it("routes LOW_SOC R2 through Policy to one PendingAction without Executor", async () => {
    const subject = dispatcher();
    const result = await subject.subject.dispatch({
      event: urgentEvent("LOW_SOC"),
      severity: "CRITICAL",
      planningContext: snapshot(5),
      candidate: {
        toolName: "reroute_to_charger",
        arguments: { stationId: "station-pudong-001" },
        safeSummary: "reroute",
      },
    });
    expect(result).toMatchObject({
      outcome: "CONFIRMATION_REQUIRED",
      policyDecision: { decision: "REQUIRE_CONFIRMATION" },
      action: { state: "AWAITING_CONFIRMATION", riskLevel: "R2" },
    });
    expect(subject.executionEvents).toHaveLength(0);
  });

  it("recovers the same durable action and deterministic credential after a retry", async () => {
    const subject = dispatcher();
    const input = {
      event: urgentEvent("LOW_SOC"),
      severity: "CRITICAL" as const,
      planningContext: snapshot(5),
      candidate: {
        toolName: "reroute_to_charger" as const,
        arguments: { stationId: "station-pudong-001" },
        safeSummary: "reroute",
      },
    };
    const first = await subject.subject.dispatch(input);
    const second = await subject.subject.dispatch(input);
    expect(first.outcome).toBe("CONFIRMATION_REQUIRED");
    expect(second.outcome).toBe("CONFIRMATION_REQUIRED");
    if (first.outcome === "CONFIRMATION_REQUIRED" && second.outcome === "CONFIRMATION_REQUIRED") {
      expect(second.action.actionId).toBe(first.action.actionId);
      expect(second.confirmationCredential).toBe(first.confirmationCredential);
    }
  });

  it("detects a refreshed relevant SOC conflict and produces REPLAN with no side effect", async () => {
    const subject = dispatcher({ currentSoc: 20 });
    const result = await subject.subject.dispatch({
      event: urgentEvent("LOW_SOC"),
      severity: "CRITICAL",
      planningContext: snapshot(5),
      candidate: {
        toolName: "reroute_to_charger",
        arguments: { stationId: "station-pudong-001" },
        safeSummary: "reroute",
      },
    });
    expect(result).toMatchObject({
      outcome: "REPLAN_REQUIRED",
      policyDecision: { reasonCode: "CONTEXT_RELEVANT_STATE_CHANGED" },
    });
    expect(subject.executionEvents).toHaveLength(0);
  });

  it("routes an R0 status read through Policy ALLOW and Reliable Executor", async () => {
    const subject = dispatcher();
    const result = await subject.subject.dispatch({
      event: urgentEvent("CHARGING_INTERRUPTED"),
      severity: "HIGH",
      planningContext: snapshot(5),
      candidate: {
        toolName: "get_charging_status",
        arguments: {},
        safeSummary: "read charging status",
      },
    });
    expect(result).toMatchObject({
      outcome: "EXECUTED",
      policyDecision: { decision: "ALLOW" },
      execution: { status: "SUCCEEDED" },
    });
    expect(subject.executionEvents.some((event) => event.eventType === "execution.started")).toBe(
      true,
    );
    expect(subject.executionEvents.some((event) => event.eventType === "execution.succeeded")).toBe(
      true,
    );
  });

  it("does not reinterpret a recovered failed execution as handled", async () => {
    const event = urgentEvent("CHARGING_INTERRUPTED");
    const suffix = createHash("sha256").update(event.eventId, "utf8").digest("hex");
    const sessionId = `urgent-session:${suffix.slice(0, 40)}`;
    const executionId = `urgent-execution:${suffix.slice(0, 40)}`;
    const now = toUtcTimestamp(PHASE_2_NOW_MS);
    const failed: ExecutionResult = Object.freeze({
      executionId,
      toolName: "get_charging_status",
      status: "FAILED",
      attemptCount: 1,
      deduplicated: false,
      startedAt: now,
      completedAt: now,
      error: {
        code: "TOOL_EXECUTION_FAILED" as const,
        message: "failed safely",
        retryable: false,
      },
    });
    const decision = Object.freeze({
      decision: "ALLOW" as const,
      ruleId: "R0_READ_ONLY_ALLOW",
      reasonCode: "R0_ALLOWED" as const,
      toolName: "get_charging_status",
      riskLevel: "R0" as const,
      contextSnapshotId: "snapshot-recovered",
      contextVersion: 1,
      evaluatedAt: now,
      evidence: {
        freshnessStatus: "FRESH" as const,
        conflictStatus: "NOT_EVALUATED" as const,
        contextChanged: false,
        requiredCapabilityAvailable: true,
        serviceAvailable: true,
      },
    });
    const request: ExecutionRequest = Object.freeze({
      executionId,
      toolName: "get_charging_status",
      validatedArguments: {},
      actionFingerprint: "a".repeat(64),
      runId: `urgent-run:${suffix.slice(0, 40)}`,
      sessionId,
      userId: "user-001",
      vehicleId: event.vehicleId,
      traceId: "1".repeat(32),
      riskLevel: "R0",
      policyDecision: decision,
      contextSnapshotId: "snapshot-recovered",
      contextVersion: 1,
      idempotencyKey: `urgent-idempotency:${suffix.slice(0, 40)}`,
      createdAt: now,
    });
    const subject = dispatcher({ recoveredExecution: { request, result: failed } });
    await expect(
      subject.subject.dispatch({
        event,
        severity: "HIGH",
        planningContext: snapshot(5),
        candidate: {
          toolName: "get_charging_status",
          arguments: {},
          safeSummary: "read charging status",
        },
      }),
    ).rejects.toBeInstanceOf(UrgentEventTransientError);
    expect(subject.executionEvents).toHaveLength(0);
  });

  it.each(["apply_brake", "control_steering", "set_throttle", "disable_aeb", "disable_esc"])(
    "has no executable RX path for %s",
    async (toolName) => {
      const subject = dispatcher();
      await expect(
        subject.subject.dispatch({
          event: urgentEvent("LOW_SOC"),
          severity: "CRITICAL",
          planningContext: snapshot(5),
          candidate: {
            toolName: toolName as "reroute_to_charger",
            arguments: {},
            safeSummary: "forbidden",
          },
        }),
      ).rejects.toBeInstanceOf(UrgentEventPermanentError);
      expect(subject.executionEvents).toHaveLength(0);
    },
  );

  it("fails closed before Policy and Executor when the refreshed Context is unavailable", async () => {
    const clock = new FixedClock(PHASE_2_NOW_MS);
    const profiles = createDefaultToolPolicyProfileRegistry();
    const current = snapshot(5);
    const failing = new UrgentActionDispatcher({
      contextLoader: new ContextLoader({
        provider: {
          loadVehicleState: () => Promise.reject(new Error("offline")),
          loadTripState: () => Promise.resolve(structuredClone(current.trip)),
          loadWeatherState: () => Promise.resolve(structuredClone(current.weather)),
          loadUser: () => Promise.resolve(structuredClone(current.user)),
          loadCapabilities: () => Promise.resolve(structuredClone(current.capabilities)),
          loadServiceAvailability: () =>
            Promise.resolve({ vehicleSimulator: true, weather: true, emergencySupport: true }),
        },
        snapshotBuilder: new ContextSnapshotBuilder({
          clock,
          versionAllocator: new ContextVersionAllocator(),
          snapshotIdAllocator: new ContextSnapshotIdAllocator("unavailable"),
        }),
        freshnessEvaluator: new ContextFreshnessEvaluator(clock),
      }),
      registry: harness.registry,
      policyEngine: new PolicyEngine({ profiles }),
      policyProfiles: profiles,
      pendingActionRepository: new InMemoryPendingActionRepository(),
      reliableExecutor: new ReliableToolExecutor({
        registry: harness.registry,
        authorizationConsumer: {
          consumeExecutionAuthorization: () => Promise.reject(new Error("unused")),
        },
        clock,
      }),
      sessionRepository: new InMemorySessionRepository(),
      sessionCoordinator: new InMemorySessionCoordinator(),
      executionRecovery: { get: () => Promise.resolve(undefined) },
      clock,
      userId: "user-001",
      confirmationSecret: "phase12-test-confirmation-secret-000000000000",
    });
    await expect(
      failing.dispatch({
        event: urgentEvent("LOW_SOC"),
        severity: "CRITICAL",
        planningContext: snapshot(5),
        candidate: {
          toolName: "reroute_to_charger",
          arguments: { stationId: "station-pudong-001" },
          safeSummary: "reroute",
        },
      }),
    ).rejects.toBeInstanceOf(UrgentEventTransientError);
  });
});
