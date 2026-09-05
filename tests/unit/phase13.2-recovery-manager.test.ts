import {
  RecoveryExhaustedError,
  RecoveryManager,
  classifyToolFailure,
  type Sleeper,
} from "@driveguard/executor";
import { ToolExecutionError } from "@driveguard/tools";
import { describe, expect, it } from "vitest";

const noSleep: Sleeper = { sleep: () => Promise.resolve() };

describe("Phase 13.2 Recovery Manager", () => {
  it("retries a transient read within the bound and returns the recovered value", async () => {
    const manager = new RecoveryManager({ maxReadAttempts: 2, sleeper: noSleep });
    let attempts = 0;
    const value = await manager.executeRead(() => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.reject(
          new ToolExecutionError(
            "DEPENDENCY_UNAVAILABLE",
            "get_vehicle_state",
            "temporary",
            "HTTP_503",
          ),
        );
      }
      return Promise.resolve({ ok: true });
    });

    expect(value).toEqual({ ok: true });
    expect(attempts).toBe(2);
  });

  it("produces explicit safe degradation after a bounded read timeout", async () => {
    const manager = new RecoveryManager({ maxReadAttempts: 2, sleeper: noSleep });
    const operation = () =>
      Promise.reject(
        new ToolExecutionError("DEPENDENCY_TIMEOUT", "get_vehicle_state", "timeout", "TIMEOUT"),
      );

    await expect(manager.executeRead(operation)).rejects.toMatchObject({
      name: "RecoveryExhaustedError",
      receipt: {
        operationType: "READ",
        failureType: "TIMEOUT",
        action: "SAFE_DEGRADATION",
        status: "SAFE_DEGRADATION",
        attemptCount: 2,
        retryCount: 1,
        idempotencyKeyReused: true,
      },
    } satisfies Partial<RecoveryExhaustedError>);
  });

  it("requires reconciliation before any ambiguous write retry", () => {
    const manager = new RecoveryManager();
    expect(
      manager.decide({
        operationType: "WRITE",
        failureType: "TIMEOUT",
        idempotencyHint: "IDEMPOTENT",
        attempt: 1,
        maxAttempts: 3,
      }),
    ).toEqual({
      action: "RECONCILE",
      reason: "AMBIGUOUS_WRITE_REQUIRES_RECONCILIATION",
    });
    expect(
      manager.decide({
        operationType: "WRITE",
        failureType: "TIMEOUT",
        idempotencyHint: "IDEMPOTENT",
        attempt: 1,
        maxAttempts: 3,
        reconciliationStatus: "EXECUTED",
      }),
    ).toEqual({ action: "STOP", reason: "RECONCILED_EXECUTED" });
    expect(
      manager.decide({
        operationType: "WRITE",
        failureType: "TIMEOUT",
        idempotencyHint: "IDEMPOTENT",
        attempt: 1,
        maxAttempts: 3,
        reconciliationStatus: "NOT_EXECUTED",
      }),
    ).toEqual({ action: "RETRY", reason: "RECONCILED_NOT_EXECUTED_RETRY" });
    expect(
      manager.decide({
        operationType: "WRITE",
        failureType: "TIMEOUT",
        idempotencyHint: "NON_IDEMPOTENT",
        attempt: 1,
        maxAttempts: 3,
        reconciliationStatus: "UNKNOWN",
      }),
    ).toEqual({ action: "STOP", reason: "RECONCILIATION_UNKNOWN" });
  });

  it("distinguishes definite 503 writes from ambiguous timeout writes", () => {
    const timeout = new ToolExecutionError(
      "DEPENDENCY_TIMEOUT",
      "reserve_charging_slot",
      "late",
      "TIMEOUT",
    );
    const unavailable = new ToolExecutionError(
      "DEPENDENCY_UNAVAILABLE",
      "reserve_charging_slot",
      "503",
      "HTTP_503",
    );
    expect(classifyToolFailure(timeout, true, true).classification).toBe("AMBIGUOUS_SIDE_EFFECT");
    expect(classifyToolFailure(unavailable, true, true).classification).toBe("RETRYABLE");
    expect(classifyToolFailure(unavailable, true, false).classification).toBe("NON_RETRYABLE");
  });

  it("rejects invalid retry configuration", () => {
    expect(() => new RecoveryManager({ maxReadAttempts: 0 })).toThrow(TypeError);
    expect(() => new RecoveryManager({ retryDelaysMs: [-1] })).toThrow(TypeError);
  });
});
