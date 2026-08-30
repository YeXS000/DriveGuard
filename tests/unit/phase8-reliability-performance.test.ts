import { performance } from "node:perf_hooks";

import { ActionLifecycleError } from "@driveguard/action-lifecycle";
import {
  CircuitBreaker,
  ReliableToolExecutor,
  RetryPolicy,
  type ExecutionAuthorizationConsumer,
  type ExecutionRequest,
  type TimeoutController,
} from "@driveguard/executor";
import { toUtcTimestamp } from "@driveguard/domain";
import type { Clock } from "@driveguard/shared";
import { ToolExecutionError, ToolRegistry, type ToolDefinition } from "@driveguard/tools";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

const NOW_MS = Date.parse("2026-08-29T00:00:00.000Z");
const clock: Clock = { nowMs: () => NOW_MS };
const immediate: TimeoutController = {
  run: async (_timeoutMs, operation) => operation(new AbortController().signal),
};

function inputCaseId(input: unknown): number {
  if (typeof input !== "object" || input === null) throw new TypeError("Invalid test input");
  const caseId = Reflect.get(input, "caseId") as unknown;
  if (typeof caseId !== "number") throw new TypeError("Invalid test caseId");
  return caseId;
}

function hex(value: number): string {
  return value.toString(16).padStart(64, "0");
}

function tool(
  name: "reserve_charging_slot" | "request_roadside_assistance",
  idempotent: boolean,
  execute: ToolDefinition["execute"],
): ToolDefinition {
  return Object.freeze({
    name,
    label: name,
    description: "Phase 8 reliability matrix Tool",
    inputSchema: Type.Object(
      { caseId: Type.Integer({ minimum: 0 }) },
      { additionalProperties: false },
    ),
    outputSchema: Type.Object(
      { ok: Type.Boolean(), caseId: Type.Integer({ minimum: 0 }) },
      { additionalProperties: false },
    ),
    riskLevel: name === "reserve_charging_slot" ? "R2" : "R3",
    requiredCapabilities: Object.freeze([]),
    requiredServices: Object.freeze(["vehicleSimulator"] as const),
    sideEffect: true,
    timeoutHintMs: 100,
    idempotencyHint: idempotent ? "IDEMPOTENT" : "NON_IDEMPOTENT",
    auditLevel: "HIGH",
    execute,
  });
}

function policy(definition: ToolDefinition): ExecutionRequest["policyDecision"] {
  return {
    decision: "REQUIRE_CONFIRMATION",
    ruleId: definition.riskLevel === "R2" ? "DG-POL-008" : "DG-POL-007",
    reasonCode:
      definition.riskLevel === "R2" ? "R2_CONFIRMATION_REQUIRED" : "R3_CONFIRMATION_REQUIRED",
    toolName: definition.name,
    riskLevel: definition.riskLevel,
    contextSnapshotId: "context:matrix",
    contextVersion: 1,
    evaluatedAt: toUtcTimestamp(NOW_MS),
    evidence: {
      freshnessStatus: "FRESH",
      conflictStatus: "NOT_EVALUATED",
      contextChanged: false,
      requiredCapabilityAvailable: true,
      serviceAvailable: true,
    },
  };
}

function request(definition: ToolDefinition, caseId: number, suffix = "base"): ExecutionRequest {
  return {
    executionId: `execution:matrix:${caseId}:${suffix}`,
    toolName: definition.name,
    validatedArguments: { caseId },
    actionFingerprint: hex(caseId + 1),
    runId: `run:matrix:${caseId}`,
    sessionId: "session:matrix",
    userId: "user:matrix",
    vehicleId: "vehicle:matrix",
    traceId: `trace:matrix:${caseId}`,
    riskLevel: definition.riskLevel,
    policyDecision: policy(definition),
    actionId: `action:matrix:${caseId}`,
    authorizationId: `authorization:matrix:${caseId}`,
    contextSnapshotId: "context:authorized",
    contextVersion: 2,
    idempotencyKey: `idempotency:matrix:${caseId}`,
    createdAt: toUtcTimestamp(NOW_MS),
  };
}

function percentile(values: number[], ratio: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * ratio) - 1] ?? Number.POSITIVE_INFINITY;
}

describe("Phase 8 measured reliability gates", () => {
  it("runs 10,000 execution/adversarial cases with zero unsafe outcomes", async () => {
    const consumed = new Set<string>();
    const authorizationConsumer: ExecutionAuthorizationConsumer = {
      consumeExecutionAuthorization: (command) => {
        if (consumed.has(command.authorizationId)) {
          return Promise.reject(new ActionLifecycleError("AUTHORIZATION_ALREADY_USED", "replay"));
        }
        consumed.add(command.authorizationId);
        return Promise.resolve({
          ...command,
          riskLevel: command.toolName === "reserve_charging_slot" ? "R2" : "R3",
          confirmationId: `confirmation:${command.actionId}`,
          policyRuleId: command.toolName === "reserve_charging_slot" ? "DG-POL-008" : "DG-POL-007",
          issuedAt: toUtcTimestamp(NOW_MS),
          expiresAt: toUtcTimestamp(NOW_MS + 10_000),
        });
      },
    };
    const attempts = new Map<number, number>();
    const sideEffects = new Map<number, number>();
    const safeTool = tool("reserve_charging_slot", true, (input) => {
      const caseId = inputCaseId(input);
      const attempt = (attempts.get(caseId) ?? 0) + 1;
      attempts.set(caseId, attempt);
      if (caseId % 10 === 6 && attempt === 1) {
        return Promise.reject(
          new ToolExecutionError("DEPENDENCY_UNAVAILABLE", "reserve_charging_slot", "transient"),
        );
      }
      if (caseId % 10 === 7) {
        return Promise.reject(
          new ToolExecutionError("CONFLICT", "reserve_charging_slot", "permanent"),
        );
      }
      sideEffects.set(caseId, (sideEffects.get(caseId) ?? 0) + 1);
      return Promise.resolve({ ok: true, caseId });
    });
    const unsafeTool = tool("request_roadside_assistance", false, (input) => {
      const caseId = inputCaseId(input);
      sideEffects.set(caseId, (sideEffects.get(caseId) ?? 0) + 1);
      return Promise.reject(
        new ToolExecutionError("DEPENDENCY_TIMEOUT", "request_roadside_assistance", "late"),
      );
    });
    const registry = new ToolRegistry().register(safeTool).register(unsafeTool).seal();
    const executor = new ReliableToolExecutor({
      registry,
      authorizationConsumer,
      clock,
      sleeper: { sleep: () => Promise.resolve() },
      timeoutController: immediate,
      circuitBreaker: new CircuitBreaker({ clock, failureThreshold: 100_000 }),
      eventSink: { emit: () => undefined },
    });
    let forbiddenActionExecuted = 0;
    let authorizationReplaySuccess = 0;
    let idempotencyCollisionAccepted = 0;
    let unsafeRetry = 0;

    for (let caseId = 0; caseId < 10_000; caseId += 1) {
      const category = caseId % 10;
      const base = request(category === 8 ? unsafeTool : safeTool, caseId);
      if (category === 1) {
        await executor.execute(base);
        await executor.execute({ ...base, executionId: `${base.executionId}:duplicate` });
      } else if (category === 2) {
        await Promise.all(
          Array.from({ length: 5 }, (_, index) =>
            executor.execute({ ...base, executionId: `${base.executionId}:${index}` }),
          ),
        );
      } else if (category === 3) {
        await executor.execute(base);
        const collision = await executor.execute({
          ...base,
          executionId: `${base.executionId}:collision`,
          actionFingerprint: hex(caseId + 50_000),
        });
        if (collision.status === "SUCCEEDED") idempotencyCollisionAccepted += 1;
      } else if (category === 4) {
        const denied = await executor.execute({
          ...base,
          policyDecision: { ...base.policyDecision, decision: "DENY", reasonCode: "DEFAULT_DENY" },
        });
        if (denied.status === "SUCCEEDED") forbiddenActionExecuted += 1;
      } else if (category === 5) {
        const first = await executor.execute(base);
        const replay = await executor.execute({
          ...base,
          executionId: `${base.executionId}:replay`,
          idempotencyKey: `${base.idempotencyKey}:replay`,
        });
        if (first.status === "SUCCEEDED" && replay.status === "SUCCEEDED") {
          authorizationReplaySuccess += 1;
        }
      } else if (category === 8) {
        const result = await executor.execute(base);
        if (result.attemptCount > 1) unsafeRetry += 1;
      } else if (category === 9) {
        const forbidden = await executor.execute({ ...base, toolName: "apply_brake" });
        if (forbidden.status === "SUCCEEDED") forbiddenActionExecuted += 1;
      } else {
        await executor.execute(base);
      }
    }

    const duplicateSideEffect = [...sideEffects.values()].filter((count) => count > 1).length;
    const metrics = {
      generatedCases: 10_000,
      forbiddenActionExecuted,
      duplicateSideEffect,
      authorizationReplaySuccess,
      idempotencyCollisionAccepted,
      unsafeRetry,
    };
    console.log(`PHASE8_RELIABILITY_METRICS ${JSON.stringify(metrics)}`);
    expect(metrics).toEqual({
      generatedCases: 10_000,
      forbiddenActionExecuted: 0,
      duplicateSideEffect: 0,
      authorizationReplaySuccess: 0,
      idempotencyCollisionAccepted: 0,
      unsafeRetry: 0,
    });
  }, 30_000);

  it("recovers at least 95% of 1,000 deterministic retry-safe transient cases", async () => {
    const perCaseAttempts = new Map<number, number>();
    let sideEffects = 0;
    const retryTool = tool("reserve_charging_slot", true, (input) => {
      const caseId = inputCaseId(input);
      const attempt = (perCaseAttempts.get(caseId) ?? 0) + 1;
      perCaseAttempts.set(caseId, attempt);
      if (attempt === 1) {
        return Promise.reject(
          new ToolExecutionError("DEPENDENCY_UNAVAILABLE", "reserve_charging_slot", "transient"),
        );
      }
      sideEffects += 1;
      return Promise.resolve({ ok: true, caseId });
    });
    const authorizationConsumer: ExecutionAuthorizationConsumer = {
      consumeExecutionAuthorization: (command) =>
        Promise.resolve({
          ...command,
          riskLevel: "R2",
          confirmationId: `confirmation:${command.actionId}`,
          policyRuleId: "DG-POL-008",
          issuedAt: toUtcTimestamp(NOW_MS),
          expiresAt: toUtcTimestamp(NOW_MS + 10_000),
        }),
    };
    const executor = new ReliableToolExecutor({
      registry: new ToolRegistry().register(retryTool).seal(),
      authorizationConsumer,
      clock,
      sleeper: { sleep: () => Promise.resolve() },
      timeoutController: immediate,
      circuitBreaker: new CircuitBreaker({ clock, failureThreshold: 100_000 }),
      eventSink: { emit: () => undefined },
    });
    let recovered = 0;
    for (let caseId = 20_000; caseId < 21_000; caseId += 1) {
      if ((await executor.execute(request(retryTool, caseId))).status === "SUCCEEDED")
        recovered += 1;
    }
    const recovery = recovered / 1_000;
    console.log(
      `PHASE8_TRANSIENT_METRICS ${JSON.stringify({ generatedCases: 1_000, recovered, recovery, duplicateSideEffect: sideEffects - recovered })}`,
    );
    expect(recovery).toBeGreaterThanOrEqual(0.95);
    expect(sideEffects).toBe(recovered);
  }, 30_000);

  it("measures 10,000 local Executor operations below the P95/P99 gate", async () => {
    const performanceTool = tool("reserve_charging_slot", true, (input) =>
      Promise.resolve({
        ok: true,
        caseId: inputCaseId(input),
      }),
    );
    const authorizationConsumer: ExecutionAuthorizationConsumer = {
      consumeExecutionAuthorization: (command) =>
        Promise.resolve({
          ...command,
          riskLevel: "R2",
          confirmationId: `confirmation:${command.actionId}`,
          policyRuleId: "DG-POL-008",
          issuedAt: toUtcTimestamp(NOW_MS),
          expiresAt: toUtcTimestamp(NOW_MS + 10_000),
        }),
    };
    const executor = new ReliableToolExecutor({
      registry: new ToolRegistry().register(performanceTool).seal(),
      authorizationConsumer,
      clock,
      sleeper: { sleep: () => Promise.resolve() },
      timeoutController: immediate,
      circuitBreaker: new CircuitBreaker({ clock, failureThreshold: 100_000 }),
      eventSink: { emit: () => undefined },
      retryPolicy: new RetryPolicy({ maxAttempts: 1 }),
    });
    const durations: number[] = [];
    for (let caseId = 30_000; caseId < 40_000; caseId += 1) {
      const started = performance.now();
      const result = await executor.execute(request(performanceTool, caseId));
      durations.push(performance.now() - started);
      expect(result.status).toBe("SUCCEEDED");
    }
    const p95Ms = percentile(durations, 0.95);
    const p99Ms = percentile(durations, 0.99);
    console.log(
      `PHASE8_PERFORMANCE_METRICS ${JSON.stringify({ operationCount: durations.length, p95Ms, p99Ms })}`,
    );
    expect(p95Ms).toBeLessThan(5);
    expect(p99Ms).toBeLessThan(10);
  }, 30_000);
});
