import { ActionLifecycleError, createActionFingerprint } from "@driveguard/action-lifecycle";
import {
  CircuitBreaker,
  AbortTimeoutController,
  classifyToolError,
  ExecutorFault,
  ExecutionRecordStore,
  IdempotencyManager,
  InMemoryExecutionEventSink,
  ReliableToolExecutor,
  RetryPolicy,
  SystemSleeper,
  authorizationErrorCode,
  type ExecutionAuthorizationConsumer,
  type ExecutionRequest,
  type Sleeper,
  type TimeoutController,
} from "@driveguard/executor";
import { toUtcTimestamp } from "@driveguard/domain";
import {
  createDefaultToolPolicyProfileRegistry,
  PolicyEngine,
  type PolicyEvaluationInput,
} from "@driveguard/policy";
import type { Clock } from "@driveguard/shared";
import {
  ToolExecutionError,
  ToolRegistry,
  type FormalToolName,
  type ToolDefinition,
  type ToolRiskLevel,
} from "@driveguard/tools";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import { PHASE6_EVALUATED_AT, availabilityWith, policyInput } from "../fixtures/phase6-policy.js";

class MutableClock implements Clock {
  value = Date.parse("2026-08-29T00:00:00.000Z");
  nowMs(): number {
    return this.value;
  }
}

const immediateTimeout: TimeoutController = {
  run: async (_timeoutMs, operation) => operation(new AbortController().signal),
};
const noSleep: Sleeper = { sleep: () => Promise.resolve() };
const allowAll: ExecutionAuthorizationConsumer = {
  consumeExecutionAuthorization: (command) =>
    Promise.resolve({
      authorizationId: command.authorizationId,
      actionId: command.actionId,
      actionFingerprint: command.actionFingerprint,
      toolName: command.toolName,
      riskLevel: "R2",
      confirmationId: "confirmation:test",
      policyRuleId: "DG-POL-008",
      contextSnapshotId: command.contextSnapshotId,
      contextVersion: command.contextVersion,
      issuedAt: toUtcTimestamp(Date.parse("2026-08-29T00:00:00.000Z")),
      expiresAt: toUtcTimestamp(Date.parse("2026-08-29T00:00:10.000Z")),
    }),
};

function inputValue(input: unknown): number {
  if (typeof input !== "object" || input === null) throw new TypeError("Invalid test input");
  const value = Reflect.get(input, "value") as unknown;
  if (typeof value !== "number") throw new TypeError("Invalid test value");
  return value;
}

function fingerprint(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function definition(
  riskLevel: ToolRiskLevel,
  execute: ToolDefinition["execute"],
  options: { readonly sideEffect?: boolean; readonly idempotent?: boolean } = {},
): ToolDefinition {
  const name =
    riskLevel === "R0"
      ? "get_vehicle_state"
      : riskLevel === "R1"
        ? "set_cabin_temperature"
        : riskLevel === "R2"
          ? "reserve_charging_slot"
          : "request_roadside_assistance";
  const profile = createDefaultToolPolicyProfileRegistry().get(name);
  if (profile === undefined) throw new Error("Missing test Policy profile");
  return Object.freeze({
    name,
    label: "Phase 8 test Tool",
    description: "Deterministic executor test Tool",
    inputSchema: Type.Object(
      { value: Type.Integer({ minimum: 0 }) },
      { additionalProperties: false },
    ),
    outputSchema: Type.Object(
      { ok: Type.Boolean(), value: Type.Integer({ minimum: 0 }) },
      { additionalProperties: false },
    ),
    riskLevel,
    requiredCapabilities: profile.requiredCapabilities,
    requiredServices: profile.requiredServices,
    sideEffect: options.sideEffect ?? profile.sideEffect,
    timeoutHintMs: 100,
    idempotencyHint: options.idempotent === false ? "NON_IDEMPOTENT" : "IDEMPOTENT",
    auditLevel: "HIGH",
    execute,
  });
}

function policy(
  tool: ToolDefinition,
  validatedArguments: unknown,
  executionBinding: NonNullable<PolicyEvaluationInput["executionBinding"]>,
) {
  return new PolicyEngine().evaluate(
    policyInput(tool.name as FormalToolName, {
      toolDefinition: tool,
      validatedArguments,
      executionBinding,
    }),
    PHASE6_EVALUATED_AT,
  );
}

function request(
  tool: ToolDefinition,
  index: number,
  overrides: Partial<ExecutionRequest> = {},
): ExecutionRequest {
  const actionFingerprint = overrides.actionFingerprint ?? fingerprint(index + 1);
  const validatedArguments = overrides.validatedArguments ?? { value: index };
  const runId = overrides.runId ?? `run:${index}`;
  const sessionId = overrides.sessionId ?? "session:test";
  const traceId = overrides.traceId ?? `trace:${index}`;
  const input = policyInput(tool.name as FormalToolName, {
    toolDefinition: tool,
    validatedArguments,
  });
  const contextSnapshotId = overrides.contextSnapshotId ?? input.contextSnapshot.snapshotId;
  const contextVersion = overrides.contextVersion ?? input.contextSnapshot.contextVersion;
  return {
    executionId: `execution:${index}`,
    toolName: tool.name,
    validatedArguments,
    actionFingerprint,
    runId,
    sessionId,
    traceId,
    riskLevel: tool.riskLevel,
    policyDecision:
      overrides.policyDecision ??
      policy(tool, validatedArguments, {
        runId,
        sessionId,
        traceId,
        actionFingerprint,
      }),
    contextSnapshotId,
    contextVersion,
    ...(tool.riskLevel === "R2"
      ? {
          actionId: `action:${index}`,
          authorizationId: `authorization:${index}`,
        }
      : {}),
    idempotencyKey: `idem:${index}`,
    createdAt: toUtcTimestamp(Date.parse("2026-08-29T00:00:00.000Z")),
    ...overrides,
  };
}

function harness(
  tool: ToolDefinition,
  options: {
    readonly authorizationConsumer?: ExecutionAuthorizationConsumer;
    readonly retryPolicy?: RetryPolicy;
    readonly circuitBreaker?: CircuitBreaker;
    readonly timeoutController?: TimeoutController;
  } = {},
) {
  const registry = new ToolRegistry().register(tool).seal();
  const clock = new MutableClock();
  return {
    clock,
    executor: new ReliableToolExecutor({
      registry,
      clock,
      authorizationConsumer: options.authorizationConsumer ?? allowAll,
      sleeper: noSleep,
      timeoutController: options.timeoutController ?? immediateTimeout,
      ...(options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy }),
      ...(options.circuitBreaker === undefined ? {} : { circuitBreaker: options.circuitBreaker }),
      eventSink: { emit: () => undefined },
    }),
  };
}

describe("Phase 8 ReliableToolExecutor parameterized behavior", () => {
  it.each(Array.from({ length: 50 }, (_, index) => index))(
    "executes validated R0 case %i through one formal entry",
    async (index) => {
      let calls = 0;
      const tool = definition("R0", (input) => {
        calls += 1;
        return Promise.resolve({ ok: true, value: inputValue(input) });
      });
      const { executor } = harness(tool);
      const result = await executor.execute(request(tool, index));
      expect(result.status).toBe("SUCCEEDED");
      expect(result.attemptCount).toBe(1);
      expect(calls).toBe(1);
    },
  );

  it.each(Array.from({ length: 50 }, (_, index) => index + 100))(
    "single-flights concurrent duplicate case %i",
    async (index) => {
      let calls = 0;
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tool = definition("R0", async (input) => {
        calls += 1;
        await gate;
        return { ok: true, value: inputValue(input) };
      });
      const { executor } = harness(tool);
      const base = request(tool, index);
      const executions = Array.from({ length: 8 }, (_, duplicate) =>
        executor.execute({ ...base, executionId: `execution:${index}:${duplicate}` }),
      );
      release();
      const results = await Promise.all(executions);
      expect(calls).toBe(1);
      expect(results.filter((result) => result.deduplicated)).toHaveLength(7);
    },
  );

  it.each(Array.from({ length: 50 }, (_, index) => index + 200))(
    "rejects idempotency collision case %i",
    async (index) => {
      let calls = 0;
      const tool = definition("R0", (input) => {
        calls += 1;
        return Promise.resolve({ ok: true, value: inputValue(input) });
      });
      const { executor } = harness(tool);
      const first = request(tool, index);
      await executor.execute(first);
      const conflict = await executor.execute(
        request(tool, index, {
          executionId: `execution:${index}:conflict`,
          actionFingerprint: fingerprint(index + 10_000),
          idempotencyKey: first.idempotencyKey,
        }),
      );
      expect(conflict.status).toBe("REJECTED");
      expect(conflict.error?.code).toBe("IDEMPOTENCY_CONFLICT");
      expect(calls).toBe(1);
    },
  );

  it.each(Array.from({ length: 50 }, (_, index) => index + 300))(
    "recovers retry-safe transient case %i",
    async (index) => {
      const failures = (index % 2) + 1;
      let calls = 0;
      const tool = definition("R0", (input) => {
        calls += 1;
        if (calls <= failures) {
          throw new ToolExecutionError("DEPENDENCY_UNAVAILABLE", "get_vehicle_state", "transient");
        }
        return Promise.resolve({ ok: true, value: inputValue(input) });
      });
      const { executor } = harness(tool);
      const result = await executor.execute(request(tool, index));
      expect(result.status).toBe("SUCCEEDED");
      expect(result.attemptCount).toBe(failures + 1);
      expect(calls).toBe(failures + 1);
    },
  );
});

describe("Phase 8 authorization and side-effect safety", () => {
  it("consumes one R2 authorization and executes once", async () => {
    let consumed = 0;
    let sideEffects = 0;
    const consumer: ExecutionAuthorizationConsumer = {
      consumeExecutionAuthorization: async (command) => {
        consumed += 1;
        return allowAll.consumeExecutionAuthorization(command);
      },
    };
    const tool = definition("R2", (input) => {
      sideEffects += 1;
      return Promise.resolve({ ok: true, value: inputValue(input) });
    });
    const { executor } = harness(tool, { authorizationConsumer: consumer });
    expect((await executor.execute(request(tool, 1))).status).toBe("SUCCEEDED");
    expect(consumed).toBe(1);
    expect(sideEffects).toBe(1);
  });

  it.each([
    ["AUTHORIZATION_EXPIRED", "AUTHORIZATION_EXPIRED"],
    ["AUTHORIZATION_ALREADY_USED", "AUTHORIZATION_ALREADY_USED"],
    ["AUTHORIZATION_MISMATCH", "AUTHORIZATION_MISMATCH"],
  ] as const)("maps %s and never dispatches", async (lifecycleCode, expected) => {
    let sideEffects = 0;
    const tool = definition("R2", (input) => {
      sideEffects += 1;
      return Promise.resolve({ ok: true, value: inputValue(input) });
    });
    const consumer: ExecutionAuthorizationConsumer = {
      consumeExecutionAuthorization: () =>
        Promise.reject(new ActionLifecycleError(lifecycleCode, "blocked")),
    };
    const { executor } = harness(tool, { authorizationConsumer: consumer });
    const result = await executor.execute(request(tool, 2));
    expect(result.error?.code).toBe(expected);
    expect(sideEffects).toBe(0);
  });

  it("serializes concurrent consumption of one authorization", async () => {
    let used = false;
    let sideEffects = 0;
    const consumer: ExecutionAuthorizationConsumer = {
      consumeExecutionAuthorization: async (command) => {
        await Promise.resolve();
        if (used) throw new ActionLifecycleError("AUTHORIZATION_ALREADY_USED", "used");
        used = true;
        return allowAll.consumeExecutionAuthorization(command);
      },
    };
    const tool = definition("R2", (input) => {
      sideEffects += 1;
      return Promise.resolve({ ok: true, value: inputValue(input) });
    });
    const { executor } = harness(tool, { authorizationConsumer: consumer });
    const base = request(tool, 3);
    const results = await Promise.all([
      executor.execute(base),
      executor.execute({ ...base, executionId: "execution:3:other", idempotencyKey: "idem:other" }),
    ]);
    expect(results.filter((result) => result.status === "SUCCEEDED")).toHaveLength(1);
    expect(results.find((result) => result.status !== "SUCCEEDED")?.error?.code).toBe(
      "AUTHORIZATION_ALREADY_USED",
    );
    expect(sideEffects).toBe(1);
  });

  it("does not retry an ambiguous non-idempotent side effect", async () => {
    let calls = 0;
    const tool = definition(
      "R2",
      () => {
        calls += 1;
        return Promise.reject(
          new ToolExecutionError("DEPENDENCY_TIMEOUT", "reserve_charging_slot", "late"),
        );
      },
      { idempotent: false },
    );
    const { executor } = harness(tool);
    const result = await executor.execute(request(tool, 4));
    expect(result.status).toBe("OUTCOME_UNKNOWN");
    expect(result.attemptCount).toBe(1);
    expect(calls).toBe(1);
  });

  it("retries a downstream-deduplicated side effect without duplicating it", async () => {
    const downstream = new Map<string, { ok: true; value: number }>();
    let attempts = 0;
    let sideEffects = 0;
    const tool = definition("R2", (input, context) => {
      attempts += 1;
      const key = context?.idempotencyKey ?? "missing";
      let result = downstream.get(key);
      if (result === undefined) {
        sideEffects += 1;
        result = { ok: true, value: inputValue(input) };
        downstream.set(key, result);
      }
      if (attempts === 1) {
        return Promise.reject(
          new ToolExecutionError("DEPENDENCY_TIMEOUT", "reserve_charging_slot", "late"),
        );
      }
      return Promise.resolve(result);
    });
    const { executor } = harness(tool);
    const result = await executor.execute(request(tool, 5));
    expect(result.status).toBe("SUCCEEDED");
    expect(result.attemptCount).toBe(2);
    expect(sideEffects).toBe(1);
  });
});

describe("Phase 8 timeout, breaker, and lifecycle boundaries", () => {
  it("bounds an attempt timeout and aborts the handler", async () => {
    let observedAbort = false;
    const timeout: TimeoutController = {
      run: (_timeoutMs, operation) => {
        const controller = new AbortController();
        const pending = operation(controller.signal);
        controller.abort();
        observedAbort = controller.signal.aborted;
        void pending.catch(() => undefined);
        return Promise.reject(new ExecutorFault("DEPENDENCY_TIMEOUT", "timeout"));
      },
    };
    const tool = definition("R0", async (_input, context) => {
      if (context?.signal.aborted === true) throw new Error("aborted");
      return new Promise(() => undefined);
    });
    const { executor } = harness(tool, {
      timeoutController: timeout,
      retryPolicy: new RetryPolicy({ maxAttempts: 1 }),
    });
    const result = await executor.execute(request(tool, 6));
    expect(result.status).toBe("RETRY_EXHAUSTED");
    expect(observedAbort).toBe(true);
  });

  it("opens, half-opens, and closes one dependency circuit", () => {
    const clock = new MutableClock();
    const breaker = new CircuitBreaker({ clock, failureThreshold: 2, cooldownMs: 100 });
    expect(breaker.acquire("dep")).toEqual({ allowed: true, state: "CLOSED" });
    breaker.failed("dep");
    expect(breaker.failed("dep").current).toBe("OPEN");
    expect(breaker.acquire("dep")).toEqual({ allowed: false, state: "OPEN" });
    clock.value += 100;
    expect(breaker.acquire("dep")).toEqual({ allowed: true, state: "HALF_OPEN" });
    expect(breaker.acquire("dep")).toEqual({ allowed: false, state: "OPEN" });
    expect(breaker.succeeded("dep")).toEqual({ previous: "HALF_OPEN", current: "CLOSED" });
  });

  it("fails closed and preserves state on illegal transition", () => {
    const store = new ExecutionRecordStore();
    const tool = definition("R0", () => Promise.resolve({ ok: true, value: 0 }));
    const value = request(tool, 7);
    store.create(value, value.createdAt);
    expect(() => store.transition(value.executionId, "SUCCEEDED", value.createdAt)).toThrow(
      ExecutorFault,
    );
    expect(store.get(value.executionId)?.state).toBe("CREATED");
  });

  it("uses action fingerprints bound to identity and context", () => {
    const first = createActionFingerprint({
      toolName: "reserve_charging_slot",
      validatedArguments: { stationId: "station-1" },
      sessionId: "session:test",
      userId: "user:test",
      vehicleId: "vehicle:test",
      contextSnapshotId: "context:1",
      contextVersion: 1,
    });
    const second = createActionFingerprint({
      toolName: "reserve_charging_slot",
      validatedArguments: { stationId: "station-1" },
      sessionId: "session:test",
      userId: "user:test",
      vehicleId: "vehicle:test",
      contextSnapshotId: "context:2",
      contextVersion: 2,
    });
    expect(first).not.toBe(second);
  });
});

describe("Phase 8 defensive and utility boundaries", () => {
  it("runs the default abort timeout controller on success and timeout", async () => {
    const controller = new AbortTimeoutController();
    await expect(controller.run(20, () => Promise.resolve("ok"))).resolves.toBe("ok");
    let aborted = false;
    await expect(
      controller.run(1, async (signal) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        aborted = signal.aborted;
        throw new Error("late");
      }),
    ).rejects.toMatchObject({ code: "DEPENDENCY_TIMEOUT" });
    expect(aborted).toBe(true);
  });

  it("covers default sleeper and RetryPolicy validation/fallback", async () => {
    await expect(new SystemSleeper().sleep(0)).resolves.toBeUndefined();
    expect(() => new RetryPolicy({ maxAttempts: 0 })).toThrow(TypeError);
    expect(() => new RetryPolicy({ maxAttempts: 11 })).toThrow(TypeError);
    expect(() => new RetryPolicy({ backoffMs: [-1] })).toThrow(TypeError);
    expect(new RetryPolicy({ backoffMs: [] }).delayForRetry(1)).toBe(0);
  });

  it("covers CircuitBreaker invalid configuration, failed probe, and state", () => {
    const localClock = new MutableClock();
    expect(() => new CircuitBreaker({ clock: localClock, failureThreshold: 0 })).toThrow(TypeError);
    expect(() => new CircuitBreaker({ clock: localClock, cooldownMs: 0 })).toThrow(TypeError);
    const breaker = new CircuitBreaker({ clock: localClock, failureThreshold: 1, cooldownMs: 1 });
    breaker.failed("dep");
    localClock.value += 1;
    expect(breaker.acquire("dep").state).toBe("HALF_OPEN");
    expect(breaker.failed("dep")).toEqual({ previous: "HALF_OPEN", current: "OPEN" });
    expect(breaker.state("dep")).toBe("OPEN");
  });

  it("stores immutable execution events", () => {
    const sink = new InMemoryExecutionEventSink();
    sink.emit({
      eventType: "execution.started",
      executionId: "execution:event",
      runId: "run:event",
      sessionId: "session:event",
      traceId: "trace:event",
      toolName: "get_vehicle_state",
      attempt: 0,
      timestamp: toUtcTimestamp(Date.parse("2026-08-29T00:00:00.000Z")),
    });
    expect(sink.slice()).toHaveLength(1);
    expect(Object.isFrozen(sink.slice()[0])).toBe(true);
  });

  it("settles an idempotency owner only once", async () => {
    const manager = new IdempotencyManager();
    const owner = manager.acquire("key", fingerprint(1), "binding");
    if (owner.kind !== "OWNER") throw new Error("Expected owner");
    const result = {
      executionId: "execution:idem",
      toolName: "get_vehicle_state",
      status: "SUCCEEDED" as const,
      attemptCount: 1,
      deduplicated: false,
      startedAt: toUtcTimestamp(Date.parse("2026-08-29T00:00:00.000Z")),
      completedAt: toUtcTimestamp(Date.parse("2026-08-29T00:00:00.000Z")),
    };
    owner.complete(result);
    owner.complete({ ...result, status: "FAILED" });
    const duplicate = manager.acquire("key", fingerprint(1), "binding");
    if (duplicate.kind !== "DUPLICATE") throw new Error("Expected duplicate");
    await expect(duplicate.result).resolves.toEqual(result);
  });

  it("covers error classification fallback and non-transient paths", () => {
    expect(authorizationErrorCode(new Error("unknown"))).toBe("EXECUTION_NOT_AUTHORIZED");
    expect(authorizationErrorCode(new ActionLifecycleError("INVALID_COMMAND", "invalid"))).toBe(
      "EXECUTION_NOT_AUTHORIZED",
    );
    expect(classifyToolError(new Error("business"), false, false)).toEqual({
      classification: "NON_RETRYABLE",
      code: "TOOL_EXECUTION_FAILED",
    });
    expect(
      classifyToolError(new ExecutorFault("DEPENDENCY_UNAVAILABLE", "down"), false, false),
    ).toEqual({ classification: "RETRYABLE", code: "DEPENDENCY_UNAVAILABLE" });
  });

  it("rejects duplicate/missing/invalid ExecutionRecord operations", () => {
    const store = new ExecutionRecordStore();
    const value = request(
      definition("R0", () => Promise.resolve({ ok: true, value: 0 })),
      800,
    );
    store.create(value, value.createdAt);
    expect(() => store.create(value, value.createdAt)).toThrow(ExecutorFault);
    expect(() =>
      store.addAttempt(value.executionId, {
        attempt: 1,
        startedAt: value.createdAt,
        completedAt: value.createdAt,
        outcome: "SUCCEEDED",
      }),
    ).toThrow(ExecutorFault);
    expect(() => store.transition("execution:missing", "RUNNING", value.createdAt)).toThrow(
      ExecutorFault,
    );
  });

  it.each([
    ["null request", null],
    ["bad execution id", { executionId: "bad id" }],
    ["bad fingerprint", { actionFingerprint: "bad" }],
    ["bad timestamp", { createdAt: "not-a-time" }],
    ["unknown tool", { toolName: "unknown_tool" }],
    ["RX tool", { toolName: "apply_brake" }],
    ["risk mismatch", { riskLevel: "R1" }],
    ["invalid arguments", { validatedArguments: { value: -1 } }],
    ["policy tool mismatch", { policyDecision: { toolName: "get_trip_state" } }],
  ])("fails closed for %s", async (_name, mutation) => {
    const tool = definition("R0", () => Promise.resolve({ ok: true, value: 0 }));
    const { executor } = harness(tool);
    const base = request(tool, 900);
    let forged: unknown;
    if (mutation === null) {
      forged = null;
    } else if ("policyDecision" in mutation) {
      forged = { ...base, policyDecision: { ...base.policyDecision, ...mutation.policyDecision } };
    } else {
      forged = { ...base, ...mutation };
    }
    const result = await executor.execute(forged as ExecutionRequest);
    expect(result.status).toBe("REJECTED");
    expect(result.attemptCount).toBe(0);
  });

  it("rejects uncloneable arguments, non-ALLOW R0, and incomplete R2", async () => {
    const r0 = definition("R0", () => Promise.resolve({ ok: true, value: 0 }));
    const { executor: r0Executor } = harness(r0);
    const cyclic: { value: number; self?: unknown } = { value: 1 };
    cyclic.self = cyclic;
    expect(
      (await r0Executor.execute({ ...request(r0, 910), validatedArguments: cyclic })).status,
    ).toBe("REJECTED");
    const cloneFailure = new Proxy({ value: 1 }, {});
    expect(
      (await r0Executor.execute({ ...request(r0, 915), validatedArguments: cloneFailure })).status,
    ).toBe("REJECTED");
    const deniedArguments = { value: 916 };
    const issuedDenial = new PolicyEngine().evaluate(
      policyInput(r0.name as FormalToolName, {
        toolDefinition: r0,
        validatedArguments: deniedArguments,
        availability: availabilityWith({}, { vehicleSimulator: false }),
      }),
      PHASE6_EVALUATED_AT,
    );
    expect(
      (
        await r0Executor.execute({
          ...request(r0, 916),
          validatedArguments: deniedArguments,
          policyDecision: issuedDenial,
        })
      ).error?.code,
    ).toBe("EXECUTION_NOT_AUTHORIZED");
    expect(
      (
        await r0Executor.execute({
          ...request(r0, 911),
          policyDecision: {
            ...request(r0, 911).policyDecision,
            decision: "DENY",
            reasonCode: "DEFAULT_DENY",
          },
        })
      ).error?.code,
    ).toBe("EXECUTION_NOT_AUTHORIZED");
    const r2 = definition("R2", () => Promise.resolve({ ok: true, value: 1 }));
    const { executor: r2Executor } = harness(r2);
    const incomplete = request(r2, 912);
    Reflect.deleteProperty(incomplete, "authorizationId");
    expect((await r2Executor.execute(incomplete)).error?.code).toBe("EXECUTION_NOT_AUTHORIZED");
  });

  it("rejects forged or argument-reused R0 Policy decisions before dispatch", async () => {
    let calls = 0;
    const tool = definition("R0", (input) => {
      calls += 1;
      return Promise.resolve({ ok: true, value: inputValue(input) });
    });
    const { executor } = harness(tool);
    const issued = request(tool, 913);
    const forged = await executor.execute({
      ...issued,
      executionId: "execution:913:forged",
      policyDecision: { ...issued.policyDecision },
      idempotencyKey: "idem:913:forged",
    });
    expect(forged.error?.code).toBe("EXECUTION_NOT_AUTHORIZED");
    const rebound = await executor.execute({
      ...issued,
      executionId: "execution:913:rebound",
      validatedArguments: { value: 914 },
      idempotencyKey: "idem:913:rebound",
    });
    expect(rebound.error?.code).toBe("EXECUTION_NOT_AUTHORIZED");
    expect(calls).toBe(0);
  });

  it("deduplicates a rejected result and exposes immutable records", async () => {
    const tool = definition("R2", () => Promise.resolve({ ok: true, value: 0 }));
    const { executor } = harness(tool);
    const base = { ...request(tool, 920) };
    Reflect.deleteProperty(base, "authorizationId");
    expect((await executor.execute(base)).status).toBe("REJECTED");
    const duplicate = await executor.execute({ ...base, executionId: "execution:920:duplicate" });
    expect(duplicate.deduplicated).toBe(true);
    expect(duplicate.status).toBe("REJECTED");
    expect(executor.record("execution:920:duplicate")?.state).toBe("REJECTED");
  });

  it("fails safely when execution event delivery or sleeper fails", async () => {
    const tool = definition("R0", () =>
      Promise.reject(
        new ToolExecutionError("DEPENDENCY_UNAVAILABLE", "get_vehicle_state", "temporary"),
      ),
    );
    const registry = new ToolRegistry().register(tool).seal();
    const eventFailure = new ReliableToolExecutor({
      registry,
      authorizationConsumer: allowAll,
      clock: new MutableClock(),
      timeoutController: immediateTimeout,
      eventSink: { emit: () => Promise.reject(new Error("sink")) },
    });
    expect((await eventFailure.execute(request(tool, 930))).error?.code).toBe(
      "INTERNAL_EXECUTION_ERROR",
    );
    const sleeperFailure = new ReliableToolExecutor({
      registry,
      authorizationConsumer: allowAll,
      clock: new MutableClock(),
      timeoutController: immediateTimeout,
      sleeper: { sleep: () => Promise.reject(new Error("sleep")) },
      eventSink: { emit: () => undefined },
    });
    expect((await sleeperFailure.execute(request(tool, 931))).error?.code).toBe(
      "INTERNAL_EXECUTION_ERROR",
    );
    const throwingBreaker = new CircuitBreaker({ clock: new MutableClock() });
    Reflect.set(throwingBreaker, "acquire", () => {
      throw new Error("breaker");
    });
    const breakerFailure = new ReliableToolExecutor({
      registry,
      authorizationConsumer: allowAll,
      clock: new MutableClock(),
      timeoutController: immediateTimeout,
      circuitBreaker: throwingBreaker,
      eventSink: { emit: () => undefined },
    });
    expect((await breakerFailure.execute(request(tool, 942))).error?.code).toBe(
      "INTERNAL_EXECUTION_ERROR",
    );
  });

  it("keeps terminal records consistent when success or deduplication audit delivery fails", async () => {
    const readTool = definition("R0", () => Promise.resolve({ ok: true, value: 1 }));
    const readExecutor = new ReliableToolExecutor({
      registry: new ToolRegistry().register(readTool).seal(),
      authorizationConsumer: allowAll,
      clock: new MutableClock(),
      timeoutController: immediateTimeout,
      eventSink: {
        emit: (event) => {
          if (event.eventType === "execution.succeeded") throw new Error("terminal sink");
        },
      },
    });
    const readResult = await readExecutor.execute(request(readTool, 932));
    expect(readResult.status).toBe("FAILED");
    expect(readResult.error?.code).toBe("INTERNAL_EXECUTION_ERROR");
    expect(readExecutor.record(readResult.executionId)?.state).toBe("FAILED");

    const sideEffectTool = definition("R2", () => Promise.resolve({ ok: true, value: 1 }));
    const sideEffectExecutor = new ReliableToolExecutor({
      registry: new ToolRegistry().register(sideEffectTool).seal(),
      authorizationConsumer: allowAll,
      clock: new MutableClock(),
      timeoutController: immediateTimeout,
      eventSink: {
        emit: (event) => {
          if (event.eventType === "execution.succeeded") throw new Error("terminal sink");
        },
      },
    });
    const sideEffectResult = await sideEffectExecutor.execute(request(sideEffectTool, 933));
    expect(sideEffectResult.status).toBe("OUTCOME_UNKNOWN");
    expect(sideEffectResult.error?.code).toBe("OUTCOME_UNKNOWN");
    expect(sideEffectExecutor.record(sideEffectResult.executionId)?.state).toBe("OUTCOME_UNKNOWN");

    const dedupeExecutor = new ReliableToolExecutor({
      registry: new ToolRegistry().register(readTool).seal(),
      authorizationConsumer: allowAll,
      clock: new MutableClock(),
      timeoutController: immediateTimeout,
      eventSink: {
        emit: (event) => {
          if (event.eventType === "execution.deduplicated") throw new Error("dedupe sink");
        },
      },
    });
    const originalRequest = request(readTool, 934);
    expect((await dedupeExecutor.execute(originalRequest)).status).toBe("SUCCEEDED");
    const duplicateRequest = {
      ...originalRequest,
      executionId: "execution:934:duplicate",
    };
    const duplicateResult = await dedupeExecutor.execute(duplicateRequest);
    expect(duplicateResult.status).toBe("FAILED");
    expect(duplicateResult.error?.code).toBe("INTERNAL_EXECUTION_ERROR");
    expect(dedupeExecutor.record(duplicateRequest.executionId)?.state).toBe("FAILED");
  });

  it("fails audit boundaries without corrupting attempt counts or HALF_OPEN state", async () => {
    const transientTool = definition("R0", () =>
      Promise.reject(
        new ToolExecutionError("DEPENDENCY_UNAVAILABLE", "get_vehicle_state", "temporary"),
      ),
    );
    const transientExecutor = new ReliableToolExecutor({
      registry: new ToolRegistry().register(transientTool).seal(),
      authorizationConsumer: allowAll,
      clock: new MutableClock(),
      timeoutController: immediateTimeout,
      eventSink: {
        emit: (event) => {
          if (event.eventType === "execution.attempt.failed") throw new Error("attempt sink");
        },
      },
    });
    const failed = await transientExecutor.execute(request(transientTool, 935));
    expect(failed.status).toBe("FAILED");
    expect(failed.attemptCount).toBe(1);
    expect(transientExecutor.record(failed.executionId)?.attempts).toHaveLength(1);

    const clock = new MutableClock();
    const breaker = new CircuitBreaker({ clock, failureThreshold: 1, cooldownMs: 1 });
    breaker.failed("vehicleSimulator");
    clock.value += 1;
    let calls = 0;
    const probeTool = definition("R0", () => {
      calls += 1;
      return Promise.resolve({ ok: true, value: 1 });
    });
    const probeExecutor = new ReliableToolExecutor({
      registry: new ToolRegistry().register(probeTool).seal(),
      authorizationConsumer: allowAll,
      clock,
      circuitBreaker: breaker,
      timeoutController: immediateTimeout,
      eventSink: {
        emit: (event) => {
          if (event.eventType === "circuit.half_open") throw new Error("half-open sink");
        },
      },
    });
    const probe = await probeExecutor.execute(request(probeTool, 936));
    expect(probe.status).toBe("FAILED");
    expect(probe.attemptCount).toBe(0);
    expect(calls).toBe(0);
    expect(breaker.state("vehicleSimulator")).toBe("OPEN");

    const startBreaker = new CircuitBreaker({ clock, failureThreshold: 1, cooldownMs: 1 });
    startBreaker.failed("vehicleSimulator");
    clock.value += 1;
    const startExecutor = new ReliableToolExecutor({
      registry: new ToolRegistry().register(probeTool).seal(),
      authorizationConsumer: allowAll,
      clock,
      circuitBreaker: startBreaker,
      timeoutController: immediateTimeout,
      eventSink: {
        emit: (event) => {
          if (event.eventType === "execution.attempt.started") throw new Error("start sink");
        },
      },
    });
    const startFailure = await startExecutor.execute(request(probeTool, 937));
    expect(startFailure.attemptCount).toBe(0);
    expect(startBreaker.state("vehicleSimulator")).toBe("OPEN");

    const closeBreaker = new CircuitBreaker({ clock, failureThreshold: 1, cooldownMs: 1 });
    closeBreaker.failed("vehicleSimulator");
    clock.value += 1;
    const closeExecutor = new ReliableToolExecutor({
      registry: new ToolRegistry().register(probeTool).seal(),
      authorizationConsumer: allowAll,
      clock,
      circuitBreaker: closeBreaker,
      timeoutController: immediateTimeout,
      eventSink: {
        emit: (event) => {
          if (event.eventType === "circuit.closed") throw new Error("close sink");
        },
      },
    });
    const closeFailure = await closeExecutor.execute(request(probeTool, 938));
    expect(closeFailure.status).toBe("FAILED");
    expect(closeFailure.attemptCount).toBe(1);
    expect(closeExecutor.record(closeFailure.executionId)?.attempts).toHaveLength(1);

    const openBreaker = new CircuitBreaker({ clock, failureThreshold: 1, cooldownMs: 1 });
    const openExecutor = new ReliableToolExecutor({
      registry: new ToolRegistry().register(transientTool).seal(),
      authorizationConsumer: allowAll,
      clock,
      circuitBreaker: openBreaker,
      timeoutController: immediateTimeout,
      eventSink: {
        emit: (event) => {
          if (event.eventType === "circuit.opened") throw new Error("open sink");
        },
      },
    });
    const openFailure = await openExecutor.execute(request(transientTool, 939));
    expect(openFailure.status).toBe("FAILED");
    expect(openFailure.attemptCount).toBe(1);
    expect(openBreaker.state("vehicleSimulator")).toBe("OPEN");

    let authorizedDispatches = 0;
    const authorizedTool = definition("R2", () => {
      authorizedDispatches += 1;
      return Promise.resolve({ ok: true, value: 1 });
    });
    const authorizationAuditExecutor = new ReliableToolExecutor({
      registry: new ToolRegistry().register(authorizedTool).seal(),
      authorizationConsumer: allowAll,
      clock,
      timeoutController: immediateTimeout,
      eventSink: {
        emit: (event) => {
          if (event.eventType === "authorization.consumed") throw new Error("auth sink");
        },
      },
    });
    const authorizationAuditFailure = await authorizationAuditExecutor.execute(
      request(authorizedTool, 941),
    );
    expect(authorizationAuditFailure.status).toBe("REJECTED");
    expect(authorizationAuditFailure.error?.code).toBe("INTERNAL_EXECUTION_ERROR");
    expect(authorizedDispatches).toBe(0);
  });

  it("uses safe defaults and a per-tool circuit key when no service is declared", async () => {
    const base = definition("R2", (input) =>
      Promise.resolve({
        ok: true,
        value: inputValue(input),
      }),
    );
    const noService = Object.freeze({ ...base, requiredServices: Object.freeze([]) });
    const executor = new ReliableToolExecutor({
      registry: new ToolRegistry().register(noService).seal(),
      authorizationConsumer: allowAll,
      clock: new MutableClock(),
    });
    expect((await executor.execute(request(base, 940))).status).toBe("SUCCEEDED");
    expect(executor.record("execution:940")?.state).toBe("SUCCEEDED");
  });

  it("reuses an exact execution replay while rejecting altered trusted bindings", async () => {
    let calls = 0;
    const read = definition("R0", (input) => {
      calls += 1;
      return Promise.resolve({ ok: true, value: inputValue(input) });
    });
    const { executor: readExecutor } = harness(read);
    const exact = request(read, 950);
    expect((await readExecutor.execute(exact)).status).toBe("SUCCEEDED");
    const replay = await readExecutor.execute(exact);
    expect(replay.status).toBe("SUCCEEDED");
    expect(replay.deduplicated).toBe(true);
    expect(calls).toBe(1);

    const sideEffect = definition("R2", (input) =>
      Promise.resolve({ ok: true, value: inputValue(input) }),
    );
    const { executor: sideEffectExecutor } = harness(sideEffect);
    const authorized = request(sideEffect, 951);
    expect((await sideEffectExecutor.execute(authorized)).status).toBe("SUCCEEDED");
    const altered = await sideEffectExecutor.execute({
      ...authorized,
      executionId: "execution:951:altered",
      validatedArguments: { value: 952 },
      authorizationId: "authorization:951:forged",
    });
    expect(altered.status).toBe("REJECTED");
    expect(altered.error?.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("single-flights an exact concurrent executionId replay", async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tool = definition("R0", async (input) => {
      calls += 1;
      await gate;
      return { ok: true, value: inputValue(input) };
    });
    const { executor } = harness(tool);
    const exact = request(tool, 953);
    const first = executor.execute(exact);
    const second = executor.execute(exact);
    release();
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.status)).toEqual(["SUCCEEDED", "SUCCEEDED"]);
    expect(results.filter((result) => result.deduplicated)).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it("does not let a same-executionId idempotency conflict corrupt an R2 owner", async () => {
    let releaseAuthorization: () => void = () => undefined;
    let signalAuthorizationStarted: () => void = () => undefined;
    const authorizationGate = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    const authorizationStarted = new Promise<void>((resolve) => {
      signalAuthorizationStarted = resolve;
    });
    const gatedAuthorization: ExecutionAuthorizationConsumer = {
      consumeExecutionAuthorization: async (command) => {
        signalAuthorizationStarted();
        await authorizationGate;
        return {
          authorizationId: command.authorizationId,
          actionId: command.actionId,
          actionFingerprint: command.actionFingerprint,
          toolName: command.toolName,
          riskLevel: "R2",
          confirmationId: "confirmation:gated",
          policyRuleId: "DG-POL-008",
          contextSnapshotId: command.contextSnapshotId,
          contextVersion: command.contextVersion,
          issuedAt: toUtcTimestamp(Date.parse("2026-08-29T00:00:00.000Z")),
          expiresAt: toUtcTimestamp(Date.parse("2026-08-29T00:00:10.000Z")),
        };
      },
    };
    let calls = 0;
    const tool = definition("R2", (input) => {
      calls += 1;
      return Promise.resolve({ ok: true, value: inputValue(input) });
    });
    const { executor } = harness(tool, { authorizationConsumer: gatedAuthorization });
    const ownerRequest = request(tool, 9_550);
    const owner = executor.execute(ownerRequest);
    await authorizationStarted;
    const conflict = await executor.execute({
      ...ownerRequest,
      validatedArguments: { value: 9_551 },
      authorizationId: "authorization:9550:conflict",
    });
    expect(conflict.error?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(executor.record(ownerRequest.executionId)?.state).toBe("CREATED");
    releaseAuthorization();
    expect((await owner).status).toBe("SUCCEEDED");
    expect(executor.record(ownerRequest.executionId)?.state).toBe("SUCCEEDED");
    expect(calls).toBe(1);
  });

  it("binds R0/R1 permits once to run, session, trace, fingerprint, and Context", async () => {
    let calls = 0;
    const tool = definition("R1", (input) => {
      calls += 1;
      return Promise.resolve({ ok: true, value: inputValue(input) });
    });
    const mutations: readonly Partial<ExecutionRequest>[] = [
      { runId: "run:other" },
      { sessionId: "session:other" },
      { traceId: "trace:other" },
      { actionFingerprint: fingerprint(9_999) },
      { contextSnapshotId: "context:other" },
      { contextVersion: 2 },
    ];
    for (const [offset, mutation] of mutations.entries()) {
      const { executor: mismatchExecutor } = harness(tool);
      const issuedForField = request(tool, 9_600 + offset);
      const mismatch = await mismatchExecutor.execute({ ...issuedForField, ...mutation });
      expect(mismatch.error?.code).toBe("EXECUTION_NOT_AUTHORIZED");
    }
    const { executor } = harness(tool);
    const issued = request(tool, 954);
    expect((await executor.execute(issued)).status).toBe("SUCCEEDED");
    const reuse = await executor.execute({
      ...issued,
      executionId: "execution:954:reuse",
      idempotencyKey: "idem:954:reuse",
    });
    expect(reuse.error?.code).toBe("EXECUTION_NOT_AUTHORIZED");
    expect(calls).toBe(1);
  });

  it("uses Executor time and deeply freezes stored attempts", async () => {
    const tool = definition("R0", (input) =>
      Promise.resolve({ ok: true, value: inputValue(input) }),
    );
    const { executor, clock } = harness(tool);
    const future = request(tool, 955, {
      createdAt: toUtcTimestamp(clock.value + 86_400_000),
    });
    const result = await executor.execute(future);
    expect(result.startedAt).toBe(toUtcTimestamp(clock.value));
    expect(Date.parse(result.startedAt)).toBeLessThanOrEqual(Date.parse(result.completedAt));
    const attempt = executor.record(result.executionId)?.attempts[0];
    expect(Object.isFrozen(attempt)).toBe(true);
  });

  it("rejects every malformed low-risk Context execution binding branch", async () => {
    const tool = definition("R0", (input) =>
      Promise.resolve({ ok: true, value: inputValue(input) }),
    );
    for (const mutation of [
      { contextSnapshotId: undefined },
      { contextVersion: undefined },
      { contextSnapshotId: "bad id" },
      { contextVersion: 1.5 },
      { contextVersion: 0 },
    ]) {
      const { executor } = harness(tool);
      const result = await executor.execute({
        ...request(tool, 958),
        ...mutation,
      } as unknown as ExecutionRequest);
      expect(result.error?.code).toBe("EXECUTION_NOT_AUTHORIZED");
    }
  });

  it("rejects reusing one executionId with a different idempotency owner", async () => {
    const tool = definition("R0", (input) =>
      Promise.resolve({ ok: true, value: inputValue(input) }),
    );
    const { executor } = harness(tool);
    const first = request(tool, 959);
    expect((await executor.execute(first)).status).toBe("SUCCEEDED");
    const second = request(tool, 960, {
      executionId: first.executionId,
      idempotencyKey: "idem:959:new-owner",
    });
    const result = await executor.execute(second);
    expect(result.status).toBe("REJECTED");
    expect(result.error?.code).toBe("EXECUTION_VALIDATION_ERROR");
  });

  it("preserves ambiguity on audit failure and releases a HALF_OPEN business-error probe", async () => {
    const ambiguousTool = definition(
      "R2",
      () =>
        Promise.reject(
          new ToolExecutionError("DEPENDENCY_TIMEOUT", "reserve_charging_slot", "timeout"),
        ),
      { idempotent: false },
    );
    const ambiguousExecutor = new ReliableToolExecutor({
      registry: new ToolRegistry().register(ambiguousTool).seal(),
      authorizationConsumer: allowAll,
      clock: new MutableClock(),
      timeoutController: immediateTimeout,
      eventSink: {
        emit: (event) => {
          if (event.eventType === "execution.attempt.failed") throw new Error("sink");
        },
      },
    });
    const ambiguous = await ambiguousExecutor.execute(request(ambiguousTool, 956));
    expect(ambiguous.status).toBe("OUTCOME_UNKNOWN");
    expect(ambiguous.error?.code).toBe("OUTCOME_UNKNOWN");

    const clock = new MutableClock();
    const breaker = new CircuitBreaker({ clock, failureThreshold: 1, cooldownMs: 1 });
    breaker.failed("vehicleSimulator");
    clock.value += 1;
    const businessTool = definition("R0", () =>
      Promise.reject(new ToolExecutionError("RESOURCE_NOT_FOUND", "get_vehicle_state", "missing")),
    );
    const businessEvents: string[] = [];
    const businessExecutor = new ReliableToolExecutor({
      registry: new ToolRegistry().register(businessTool).seal(),
      authorizationConsumer: allowAll,
      clock,
      circuitBreaker: breaker,
      timeoutController: immediateTimeout,
      eventSink: {
        emit: (event) => {
          businessEvents.push(event.eventType);
        },
      },
    });
    expect((await businessExecutor.execute(request(businessTool, 957))).status).toBe("FAILED");
    expect(breaker.state("vehicleSimulator")).toBe("CLOSED");
    expect(businessEvents).toContain("circuit.closed");
  });

  it("covers defensive duplicate and absent optional-binding outcomes", async () => {
    const undefinedTool = definition("R0", () => Promise.resolve(undefined));
    const exactExecutor = new ReliableToolExecutor({
      registry: new ToolRegistry().register(undefinedTool).seal(),
      authorizationConsumer: allowAll,
      clock: new MutableClock(),
      timeoutController: immediateTimeout,
      eventSink: {
        emit: (event) => {
          if (event.eventType === "execution.deduplicated") throw new Error("sink");
        },
      },
    });
    const exact = request(undefinedTool, 961);
    expect((await exactExecutor.execute(exact)).status).toBe("SUCCEEDED");
    expect((await exactExecutor.execute(exact)).status).toBe("SUCCEEDED");

    const r2 = definition("R2", () => Promise.resolve({ ok: true, value: 1 }));
    const { executor: incompleteExecutor } = harness(r2);
    const incomplete = { ...request(r2, 962) };
    Reflect.deleteProperty(incomplete, "authorizationId");
    Reflect.deleteProperty(incomplete, "contextSnapshotId");
    Reflect.deleteProperty(incomplete, "contextVersion");
    expect((await incompleteExecutor.execute(incomplete)).status).toBe("REJECTED");

    const defensiveIdempotency = {
      acquire: () => ({
        kind: "DUPLICATE" as const,
        result: Promise.resolve({
          executionId: "execution:defensive:original",
          toolName: r2.name,
          status: "CREATED" as const,
          attemptCount: 0,
          deduplicated: false,
          startedAt: toUtcTimestamp(Date.parse("2026-08-29T00:00:00.000Z")),
          completedAt: toUtcTimestamp(Date.parse("2026-08-29T00:00:00.000Z")),
        }),
      }),
    } as unknown as IdempotencyManager;
    const defensiveExecutor = new ReliableToolExecutor({
      registry: new ToolRegistry().register(r2).seal(),
      authorizationConsumer: allowAll,
      clock: new MutableClock(),
      timeoutController: immediateTimeout,
      idempotencyManager: defensiveIdempotency,
      eventSink: { emit: () => undefined },
    });
    const defensive = await defensiveExecutor.execute(request(r2, 963));
    expect(defensive.status).toBe("FAILED");
    expect(defensiveExecutor.record(defensive.executionId)?.state).toBe("FAILED");
  });
});
