import { createActionFingerprint } from "@driveguard/action-lifecycle";
import { toUtcTimestamp } from "@driveguard/domain";
import {
  IdempotencyManager,
  ReliableToolExecutor,
  type DurableExecutionCoordinator,
  type ExecutionRequest,
} from "@driveguard/executor";
import { PolicyEngine } from "@driveguard/policy";
import { FixedClock } from "@driveguard/shared";
import { describe, expect, it } from "vitest";

import { createOfflineRegistry } from "../fixtures/phase4-tools.js";
import { PHASE6_EVALUATED_AT, policyInput } from "../fixtures/phase6-policy.js";

const durableCoordinator: DurableExecutionCoordinator = {
  async execute(_request, _requestBinding, owner) {
    return (await owner()).result;
  },
};

const registry = createOfflineRegistry();
const configuredWeatherTool = registry.get("get_weather");
if (configuredWeatherTool === undefined) throw new Error("Missing get_weather fixture Tool");
const weatherTool = configuredWeatherTool;

function request(index: number): ExecutionRequest {
  const toolName = "get_weather";
  const validatedArguments = {};
  const runId = `run:retention:${index}`;
  const sessionId = "session:retention";
  const traceId = `trace:retention:${index}`;
  const input = policyInput(toolName, { toolDefinition: weatherTool, validatedArguments });
  const { snapshotId: contextSnapshotId, contextVersion } = input.contextSnapshot;
  const { userId } = input.contextSnapshot.user;
  const { vehicleId } = input.contextSnapshot.vehicle;
  const actionFingerprint = createActionFingerprint({
    toolName,
    validatedArguments,
    sessionId,
    userId,
    vehicleId,
    contextSnapshotId,
    contextVersion,
  });
  const policyDecision = new PolicyEngine().evaluate(
    policyInput(toolName, {
      toolDefinition: weatherTool,
      validatedArguments,
      executionBinding: { runId, sessionId, traceId, actionFingerprint },
    }),
    PHASE6_EVALUATED_AT,
  );
  return {
    executionId: `execution:retention:${index}`,
    toolName,
    validatedArguments,
    actionFingerprint,
    runId,
    sessionId,
    userId,
    vehicleId,
    traceId,
    riskLevel: "R0",
    policyDecision,
    contextSnapshotId,
    contextVersion,
    idempotencyKey: `idempotency:retention:${index}`,
    createdAt: toUtcTimestamp(Date.parse(PHASE6_EVALUATED_AT)),
  };
}

describe("Phase 15.1 durable executor retention", () => {
  it("releases process-local records after durable finalization", async () => {
    const executor = new ReliableToolExecutor({
      registry,
      authorizationConsumer: {
        consumeExecutionAuthorization: () => Promise.reject(new Error("not expected for R0")),
      },
      clock: new FixedClock(Date.parse(PHASE6_EVALUATED_AT)),
      durableCoordinator,
      eventSink: { emit: () => undefined },
    });

    for (let index = 0; index < 500; index += 1) {
      const result = await executor.execute(request(index));
      expect(result.status).toBe("SUCCEEDED");
    }

    expect(executor.retentionSnapshot()).toEqual({
      executionRecords: 0,
      idempotencyEntries: 0,
    });
  }, 15_000);

  it("keeps process-local replay semantics when no durable coordinator is configured", async () => {
    const executor = new ReliableToolExecutor({
      registry,
      authorizationConsumer: {
        consumeExecutionAuthorization: () => Promise.reject(new Error("not expected for R0")),
      },
      clock: new FixedClock(Date.parse(PHASE6_EVALUATED_AT)),
      eventSink: { emit: () => undefined },
    });
    const original = request(501);
    const first = await executor.execute(original);
    const duplicate = await executor.execute({
      ...original,
      executionId: "execution:retention:501:duplicate",
    });

    expect(first.status).toBe("SUCCEEDED");
    expect(duplicate.deduplicated).toBe(true);
    expect(executor.retentionSnapshot()).toEqual({
      executionRecords: 2,
      idempotencyEntries: 1,
    });
  });

  it("does not release an idempotency owner through a mismatched binding", () => {
    const manager = new IdempotencyManager();
    const owner = manager.acquire("key", "fingerprint", "binding");
    expect(owner.kind).toBe("OWNER");
    expect(manager.release("key", "other-fingerprint", "binding")).toBe(false);
    expect(manager.release("key", "fingerprint", "other-binding")).toBe(false);
    expect(manager.acquire("key", "fingerprint", "binding").kind).toBe("DUPLICATE");
    expect(manager.size).toBe(1);
    expect(manager.release("key", "fingerprint", "binding")).toBe(true);
    expect(manager.size).toBe(0);
  });

  it("cleans process-local state when durable coordination fails", async () => {
    const executor = new ReliableToolExecutor({
      registry,
      authorizationConsumer: {
        consumeExecutionAuthorization: () => Promise.reject(new Error("not expected for R0")),
      },
      clock: new FixedClock(Date.parse(PHASE6_EVALUATED_AT)),
      durableCoordinator: {
        execute: () => Promise.reject(new Error("durable coordinator unavailable")),
      },
      eventSink: { emit: () => undefined },
    });

    await expect(executor.execute(request(502))).rejects.toThrow("durable coordinator unavailable");
    expect(executor.retentionSnapshot()).toEqual({
      executionRecords: 0,
      idempotencyEntries: 0,
    });
  });
});
