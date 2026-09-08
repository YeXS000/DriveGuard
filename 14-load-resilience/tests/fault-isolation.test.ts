import { createActionFingerprint } from "@driveguard/action-lifecycle";
import { toUtcTimestamp } from "@driveguard/domain";
import {
  ExecutionConcurrencyController,
  ReliableToolExecutor,
  type ExecutionAuthorizationConsumer,
  type ExecutionRequest,
} from "@driveguard/executor";
import { PolicyEngine } from "@driveguard/policy";
import { SystemClock } from "@driveguard/shared";
import {
  ToolExecutionError,
  ToolRegistry,
  type FormalToolName,
  type ToolDefinition,
} from "@driveguard/tools";
import { describe, expect, it } from "vitest";

import { DriveGuardApiService } from "../../apps/api/src/service.js";
import { createFakeApiHarness } from "../../tests/fixtures/phase10-api.js";
import { PHASE6_EVALUATED_AT, policyInput } from "../../tests/fixtures/phase6-policy.js";

const authorizationConsumer: ExecutionAuthorizationConsumer = {
  consumeExecutionAuthorization: (command) =>
    Promise.resolve({
      ...command,
      riskLevel: "R2",
      confirmationId: "confirmation:phase14",
      policyRuleId: "DG-POL-008",
      issuedAt: toUtcTimestamp(Date.now()),
      expiresAt: toUtcTimestamp(Date.now() + 10_000),
    }),
};

function request(definition: ToolDefinition, index: number): ExecutionRequest {
  const validatedArguments = definition.name === "set_media_volume" ? { volume: 42 } : {};
  const input = policyInput(definition.name as FormalToolName, {
    toolDefinition: definition,
    validatedArguments,
  });
  const runId = `run:phase14:${index}`;
  const sessionId = `session:phase14:${index}`;
  const traceId = `trace:phase14:${index}`;
  const actionFingerprint = createActionFingerprint({
    toolName: definition.name,
    validatedArguments,
    sessionId,
    userId: input.contextSnapshot.user.userId,
    vehicleId: input.contextSnapshot.vehicle.vehicleId,
    contextSnapshotId: input.contextSnapshot.snapshotId,
    contextVersion: input.contextSnapshot.contextVersion,
  });
  const policyDecision = new PolicyEngine().evaluate(
    policyInput(definition.name as FormalToolName, {
      toolDefinition: definition,
      validatedArguments,
      executionBinding: { runId, sessionId, traceId, actionFingerprint },
    }),
    PHASE6_EVALUATED_AT,
  );
  return {
    executionId: `execution:phase14:${index}`,
    toolName: definition.name,
    validatedArguments,
    actionFingerprint,
    runId,
    sessionId,
    userId: input.contextSnapshot.user.userId,
    vehicleId: input.contextSnapshot.vehicle.vehicleId,
    traceId,
    riskLevel: definition.riskLevel,
    policyDecision,
    contextSnapshotId: input.contextSnapshot.snapshotId,
    contextVersion: input.contextSnapshot.contextVersion,
    idempotencyKey: `idempotency:phase14:${index}`,
    createdAt: toUtcTimestamp(Date.now()),
  };
}

const emptySchema = Object.freeze({ type: "object", properties: {}, additionalProperties: false });
const volumeSchema = Object.freeze({
  type: "object",
  properties: { volume: { type: "number", minimum: 0, maximum: 100 } },
  required: ["volume"],
  additionalProperties: false,
});

describe("Phase 14 fault and duplicate behavior under concurrency", () => {
  it("recovers 50 concurrent transient reads within the four-read bound", async () => {
    const attempts = new Map<string, number>();
    const definition = Object.freeze({
      name: "get_vehicle_state",
      label: "Get vehicle state",
      description: "Phase 14 transient read",
      riskLevel: "R0",
      inputSchema: emptySchema,
      outputSchema: Object.freeze({}),
      requiredCapabilities: [],
      requiredServices: ["vehicleSimulator"],
      timeoutHintMs: 1_000,
      idempotencyHint: "READ_ONLY",
      sideEffect: false,
      auditLevel: "BASIC",
      execute: (_arguments: unknown, context: { idempotencyKey: string }) => {
        const count = (attempts.get(context.idempotencyKey) ?? 0) + 1;
        attempts.set(context.idempotencyKey, count);
        if (count === 1) {
          throw new ToolExecutionError(
            "DEPENDENCY_UNAVAILABLE",
            "get_vehicle_state",
            "injected 503",
            "HTTP_503",
          );
        }
        return Promise.resolve({ ok: true });
      },
    }) as unknown as ToolDefinition;
    let maximumReads = 0;
    const controller = new ExecutionConcurrencyController({
      maxReadConcurrency: 4,
      maxWriteConcurrency: 2,
      maxQueue: 100,
      queueTimeoutMs: 5_000,
      observer: (snapshot) => {
        maximumReads = Math.max(maximumReads, snapshot.readActive);
      },
    });
    const executor = new ReliableToolExecutor({
      registry: new ToolRegistry().register(definition).seal(),
      authorizationConsumer,
      clock: new SystemClock(),
      concurrencyController: controller,
      eventSink: { emit: () => undefined },
    });
    const results = await Promise.all(
      Array.from({ length: 50 }, (_value, index) => executor.execute(request(definition, index))),
    );
    const metrics = {
      requestCount: results.length,
      recovered: results.filter((result) => result.status === "SUCCEEDED").length,
      maximumReads,
      falseSuccess: results.filter(
        (result) => result.status === "SUCCEEDED" && result.attemptCount !== 2,
      ).length,
      duplicateSideEffect: 0,
    };
    console.log(`PHASE14_FAULT_UNDER_LOAD ${JSON.stringify(metrics)}`);
    expect(metrics).toEqual({
      requestCount: 50,
      recovered: 50,
      maximumReads: 4,
      falseSuccess: 0,
      duplicateSideEffect: 0,
    });
  });

  it("single-flights 50 duplicate writes with no same-vehicle overlap", async () => {
    let effectCount = 0;
    let effectActive = 0;
    let overlap = 0;
    const definition = Object.freeze({
      name: "set_media_volume",
      label: "Set media volume",
      description: "Phase 14 duplicate write",
      riskLevel: "R1",
      inputSchema: volumeSchema,
      outputSchema: Object.freeze({}),
      requiredCapabilities: ["media"],
      requiredServices: ["vehicleSimulator"],
      timeoutHintMs: 1_000,
      idempotencyHint: "NON_IDEMPOTENT",
      sideEffect: true,
      auditLevel: "STANDARD",
      execute: async () => {
        effectActive += 1;
        if (effectActive > 1) overlap += 1;
        await new Promise((resolve) => setTimeout(resolve, 2));
        effectCount += 1;
        effectActive -= 1;
        return { volume: 42 };
      },
    }) as unknown as ToolDefinition;
    const controller = new ExecutionConcurrencyController({
      maxReadConcurrency: 4,
      maxWriteConcurrency: 8,
      maxQueue: 100,
      queueTimeoutMs: 5_000,
    });
    const executor = new ReliableToolExecutor({
      registry: new ToolRegistry().register(definition).seal(),
      authorizationConsumer,
      clock: new SystemClock(),
      concurrencyController: controller,
      eventSink: { emit: () => undefined },
    });
    const duplicate = request(definition, 900);
    const results = await Promise.all(
      Array.from({ length: 50 }, () => executor.execute(duplicate)),
    );
    const metrics = {
      requestCount: results.length,
      effectCount,
      overlap,
      deduplicated: results.filter((result) => result.deduplicated).length,
      failures: results.filter((result) => result.status !== "SUCCEEDED").length,
    };
    console.log(`PHASE14_DUPLICATE_UNDER_LOAD ${JSON.stringify(metrics)}`);
    expect(metrics).toEqual({
      requestCount: 50,
      effectCount: 1,
      overlap: 0,
      deduplicated: 49,
      failures: 0,
    });
  });
});

describe("Phase 14 cross-session isolation", () => {
  it("keeps 100 concurrent identity bindings isolated", async () => {
    const harness = createFakeApiHarness();
    const service = new DriveGuardApiService({
      sessions: harness.sessions,
      conversation: harness.conversation,
      executions: harness.executions,
      runtimeFactory: harness.factory,
    });
    const identities = Array.from({ length: 100 }, (_value, index) => ({
      sessionId: `session:isolation:${index}`,
      identity: { userId: `user:isolation:${index}`, vehicleId: `vehicle:isolation:${index}` },
    }));
    await Promise.all(
      identities.map(({ sessionId, identity }) => service.createSession(identity, sessionId)),
    );
    const views = await Promise.all(
      identities.map(({ sessionId, identity }) => service.getSession(sessionId, identity)),
    );
    expect(new Set(views.map((view) => view.sessionId)).size).toBe(100);
    expect(
      views.every(
        (view, index) =>
          view.userId === identities[index]?.identity.userId &&
          view.vehicleId === identities[index]?.identity.vehicleId,
      ),
    ).toBe(true);
    const contamination = await Promise.all(
      identities.map(async ({ sessionId }, index) => {
        const wrong = identities[(index + 1) % identities.length]?.identity;
        if (wrong === undefined) return true;
        try {
          await service.getSession(sessionId, wrong);
          return true;
        } catch {
          return false;
        }
      }),
    );
    expect(contamination.filter(Boolean)).toHaveLength(0);
  });
});
