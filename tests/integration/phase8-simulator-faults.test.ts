import type { AddressInfo } from "node:net";

import { createActionFingerprint } from "@driveguard/action-lifecycle";
import {
  CircuitBreaker,
  InMemoryExecutionEventSink,
  ReliableToolExecutor,
  RetryPolicy,
  type ExecutionAuthorizationConsumer,
  type ExecutionRequest,
  type Sleeper,
} from "@driveguard/executor";
import { toUtcTimestamp } from "@driveguard/domain";
import { PolicyEngine } from "@driveguard/policy";
import type { Clock } from "@driveguard/shared";
import {
  createDriveGuardToolRegistry,
  DevelopmentEmergencySupportProvider,
  DevelopmentWeatherProvider,
  SimulatorClient,
  type FormalToolName,
  type ToolDefinition,
} from "@driveguard/tools";
import { buildVehicleSimulator } from "@driveguard/vehicle-simulator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PHASE6_EVALUATED_AT, policyInput } from "../fixtures/phase6-policy.js";

class MutableClock implements Clock {
  value = Date.parse("2026-08-29T00:00:00.000Z");
  nowMs(): number {
    return this.value;
  }
}

const authorizationConsumer: ExecutionAuthorizationConsumer = {
  consumeExecutionAuthorization: (command) =>
    Promise.resolve({
      ...command,
      riskLevel: "R2",
      confirmationId: "confirmation:phase8",
      policyRuleId: "DG-POL-008",
      issuedAt: toUtcTimestamp(Date.parse("2026-08-29T00:00:00.000Z")),
      expiresAt: toUtcTimestamp(Date.parse("2026-08-29T00:00:10.000Z")),
    }),
};

function policy(
  definition: ToolDefinition,
  validatedArguments: unknown,
  executionBinding: {
    readonly runId: string;
    readonly sessionId: string;
    readonly traceId: string;
    readonly actionFingerprint: string;
  },
): ExecutionRequest["policyDecision"] {
  return new PolicyEngine().evaluate(
    policyInput(definition.name as FormalToolName, {
      toolDefinition: definition,
      validatedArguments,
      executionBinding,
    }),
    PHASE6_EVALUATED_AT,
  );
}

describe("Phase 8 Simulator fault integration", () => {
  let app: ReturnType<typeof buildVehicleSimulator>;
  let baseUrl: string;
  let client: SimulatorClient;
  let registry: ReturnType<typeof createDriveGuardToolRegistry>;
  let sequence = 0;

  beforeEach(async () => {
    app = buildVehicleSimulator();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    client = new SimulatorClient({ baseUrl });
    registry = createDriveGuardToolRegistry({
      simulator: client,
      weatherProvider: new DevelopmentWeatherProvider(),
      emergencySupportProvider: new DevelopmentEmergencySupportProvider(),
    });
  });

  afterEach(async () => {
    await app.close();
  });

  function request(toolName: string, argumentsValue: unknown): ExecutionRequest {
    sequence += 1;
    const definition = registry.get(toolName);
    if (definition === undefined) throw new Error("Missing Tool");
    const runId = `run:fault:${sequence}`;
    const sessionId = "session:fault";
    const traceId = `trace:fault:${sequence}`;
    const input = policyInput(definition.name as FormalToolName, {
      toolDefinition: definition,
      validatedArguments: argumentsValue,
    });
    const actionFingerprint = createActionFingerprint({
      toolName,
      validatedArguments: argumentsValue,
      sessionId,
      userId: input.contextSnapshot.user.userId,
      vehicleId: input.contextSnapshot.vehicle.vehicleId,
      contextSnapshotId: input.contextSnapshot.snapshotId,
      contextVersion: input.contextSnapshot.contextVersion,
    });
    return {
      executionId: `execution:fault:${sequence}`,
      toolName,
      validatedArguments: argumentsValue,
      actionFingerprint,
      runId,
      sessionId,
      userId: input.contextSnapshot.user.userId,
      vehicleId: input.contextSnapshot.vehicle.vehicleId,
      traceId,
      riskLevel: definition.riskLevel,
      policyDecision: policy(definition, argumentsValue, {
        runId,
        sessionId,
        traceId,
        actionFingerprint,
      }),
      contextSnapshotId: input.contextSnapshot.snapshotId,
      contextVersion: input.contextSnapshot.contextVersion,
      ...(definition.riskLevel === "R2"
        ? {
            actionId: `action:fault:${sequence}`,
            authorizationId: `authorization:fault:${sequence}`,
          }
        : {}),
      idempotencyKey: `idempotency:fault:${sequence}`,
      createdAt: toUtcTimestamp(Date.parse("2026-08-29T00:00:00.000Z")),
    };
  }

  async function setFault(target: string, mode: string, delayMs = 0): Promise<void> {
    const response = await fetch(`${baseUrl}/simulator/faults`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target, mode, probability: 1, delayMs }),
    });
    expect(response.status).toBe(201);
  }

  async function clearFaults(): Promise<void> {
    const response = await fetch(`${baseUrl}/simulator/faults`, { method: "DELETE" });
    expect(response.status).toBe(204);
  }

  it("Case A retries a transient 503 read and succeeds", async () => {
    await setFault("vehicle.get_state", "http_503");
    const sleeper: Sleeper = { sleep: async () => clearFaults() };
    const clock = new MutableClock();
    const executor = new ReliableToolExecutor({
      registry,
      authorizationConsumer,
      clock,
      sleeper,
      eventSink: { emit: () => undefined },
    });
    const result = await executor.execute(request("get_vehicle_state", {}));
    expect(result.status).toBe("SUCCEEDED");
    expect(result.attemptCount).toBe(2);
  });

  it("Case B reconciles an applied reservation timeout without a blind retry", async () => {
    await setFault("charging.create_reservation", "timeout", 3_100);
    const clock = new MutableClock();
    const events = new InMemoryExecutionEventSink();
    const executor = new ReliableToolExecutor({
      registry,
      authorizationConsumer,
      clock,
      sleeper: { sleep: () => Promise.resolve() },
      eventSink: events,
      reconciler: {
        async reconcile(input) {
          const state = await client.getChargingStatus();
          const stationId = (input.validatedArguments as { stationId: string }).stationId;
          const reservation = state.reservations.find(
            (candidate) => candidate.stationId === stationId,
          );
          return reservation === undefined
            ? { status: "NOT_EXECUTED" }
            : { status: "EXECUTED", result: { reservation } };
        },
      },
    });
    const result = await executor.execute(
      request("reserve_charging_slot", { stationId: "station-pudong-001" }),
    );
    expect(result.status).toBe("SUCCEEDED");
    expect(result.attemptCount).toBe(1);
    expect(result.recovery?.reconciliationStatus).toBe("EXECUTED");
    expect(events.slice().map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "execution.outcome_unknown",
        "execution.reconciliation.started",
        "execution.reconciliation.completed",
      ]),
    );
    const state = (await (await fetch(`${baseUrl}/simulator/state`)).json()) as {
      charging: { reservations: unknown[] };
    };
    expect(state.charging.reservations).toHaveLength(1);
  });

  it("Case C does not retry a business/resource error", async () => {
    const clock = new MutableClock();
    const executor = new ReliableToolExecutor({
      registry,
      authorizationConsumer,
      clock,
      sleeper: { sleep: () => Promise.resolve() },
      eventSink: { emit: () => undefined },
    });
    const result = await executor.execute(
      request("reserve_charging_slot", { stationId: "station-does-not-exist" }),
    );
    expect(result.status).toBe("FAILED");
    expect(result.attemptCount).toBe(1);
  });

  it("only marks the downstream-deduplicated reservation mutation retry-safe", () => {
    const retrySafeMutations = registry
      .list()
      .filter((definition) => definition.sideEffect && definition.idempotencyHint === "IDEMPOTENT")
      .map((definition) => definition.name);
    expect(retrySafeMutations).toEqual(["reserve_charging_slot"]);
  });

  it("Case D opens, fails fast, half-opens, and recovers", async () => {
    await setFault("vehicle.get_state", "http_503");
    const clock = new MutableClock();
    const events = new InMemoryExecutionEventSink();
    const breaker = new CircuitBreaker({ clock, failureThreshold: 2, cooldownMs: 10 });
    const executor = new ReliableToolExecutor({
      registry,
      authorizationConsumer,
      clock,
      retryPolicy: new RetryPolicy({ maxAttempts: 1 }),
      circuitBreaker: breaker,
      sleeper: { sleep: () => Promise.resolve() },
      eventSink: events,
    });
    expect((await executor.execute(request("get_vehicle_state", {}))).status).toBe(
      "RETRY_EXHAUSTED",
    );
    expect((await executor.execute(request("get_vehicle_state", {}))).status).toBe(
      "RETRY_EXHAUSTED",
    );
    const fast = await executor.execute(request("get_vehicle_state", {}));
    expect(fast.error?.code).toBe("CIRCUIT_OPEN");
    expect(fast.attemptCount).toBe(0);
    await clearFaults();
    clock.value += 10;
    expect((await executor.execute(request("get_vehicle_state", {}))).status).toBe("SUCCEEDED");
    expect(events.slice().map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["circuit.opened", "circuit.half_open", "circuit.closed"]),
    );
  });

  it("executes within the Tool timeout under an injected delay", async () => {
    await setFault("vehicle.get_state", "delay", 2);
    const executor = new ReliableToolExecutor({
      registry,
      authorizationConsumer,
      clock: new MutableClock(),
      sleeper: { sleep: () => Promise.resolve() },
      eventSink: { emit: () => undefined },
    });
    const result = await executor.execute(request("get_vehicle_state", {}));
    expect(result.status).toBe("SUCCEEDED");
    expect(result.attemptCount).toBe(1);
  });

  it.each(["http_500", "connection_abort"] as const)(
    "recovers from injected %s after a safe retry",
    async (mode) => {
      await setFault("vehicle.get_state", mode);
      const executor = new ReliableToolExecutor({
        registry,
        authorizationConsumer,
        clock: new MutableClock(),
        sleeper: { sleep: async () => clearFaults() },
        eventSink: { emit: () => undefined },
      });
      const result = await executor.execute(request("get_vehicle_state", {}));
      expect(result.status).toBe("SUCCEEDED");
      expect(result.attemptCount).toBe(2);
    },
  );

  it("returns a schema-valid injected stale_response without manufacturing a retry", async () => {
    const changed = await fetch(`${baseUrl}/simulator/vehicle/soc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ soc: 50 }),
    });
    expect(changed.status).toBe(200);
    const current = (await (await fetch(`${baseUrl}/vehicle/state`)).json()) as { version: number };
    await setFault("vehicle.get_state", "stale_response");
    const executor = new ReliableToolExecutor({
      registry,
      authorizationConsumer,
      clock: new MutableClock(),
      sleeper: { sleep: () => Promise.resolve() },
      eventSink: { emit: () => undefined },
    });
    const result = await executor.execute(request("get_vehicle_state", {}));
    expect(result.status).toBe("SUCCEEDED");
    expect(result.attemptCount).toBe(1);
    expect((result.result as { version: number }).version).toBeLessThan(current.version);
  });
});
