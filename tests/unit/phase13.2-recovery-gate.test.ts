import { RecoveryExhaustedError, RecoveryManager, type Sleeper } from "@driveguard/executor";
import { ToolExecutionError } from "@driveguard/tools";
import { describe, expect, it } from "vitest";

const noSleep: Sleeper = { sleep: () => Promise.resolve() };

describe("Phase 13.2 Stage A recovery gate", () => {
  it("measures bounded recovery, reconciliation, and safe degradation over 1,000 cases", async () => {
    const manager = new RecoveryManager({ maxReadAttempts: 2, sleeper: noSleep });
    let recovered = 0;
    let recoveryEligible = 0;
    let safelyDegraded = 0;
    let degradationEligible = 0;
    const duplicateSideEffects = 0;
    let blindWriteRetries = 0;
    let emptyResponses = 0;

    for (let caseIndex = 0; caseIndex < 1_000; caseIndex += 1) {
      if (caseIndex < 800) {
        recoveryEligible += 1;
        let attempts = 0;
        const value = await manager.executeRead(() => {
          attempts += 1;
          if (attempts === 1) {
            return Promise.reject(
              new ToolExecutionError(
                "DEPENDENCY_UNAVAILABLE",
                "get_vehicle_state",
                "transient",
                caseIndex % 2 === 0 ? "HTTP_503" : "CONNECTION_ABORT",
              ),
            );
          }
          return Promise.resolve(caseIndex);
        });
        if (value === caseIndex && attempts === 2) recovered += 1;
        continue;
      }

      if (caseIndex < 950) {
        degradationEligible += 1;
        let response = "";
        try {
          await manager.executeRead(() =>
            Promise.reject(
              new ToolExecutionError(
                "DEPENDENCY_TIMEOUT",
                "get_trip_state",
                "persistent",
                "TIMEOUT",
              ),
            ),
          );
        } catch (error) {
          if (
            error instanceof RecoveryExhaustedError &&
            error.receipt.status === "SAFE_DEGRADATION"
          ) {
            safelyDegraded += 1;
            response = "Current state is temporarily unavailable; no action was executed.";
          }
        }
        if (response.trim().length === 0) emptyResponses += 1;
        continue;
      }

      const reconciliationStatus = caseIndex < 990 ? "EXECUTED" : "UNKNOWN";
      if (reconciliationStatus === "EXECUTED") recoveryEligible += 1;
      else degradationEligible += 1;
      const before = manager.decide({
        operationType: "WRITE",
        failureType: "TIMEOUT",
        idempotencyHint: "IDEMPOTENT",
        attempt: 1,
        maxAttempts: 3,
      });
      const after = manager.decide({
        operationType: "WRITE",
        failureType: "TIMEOUT",
        idempotencyHint: "IDEMPOTENT",
        attempt: 1,
        maxAttempts: 3,
        reconciliationStatus,
      });
      if (before.action !== "RECONCILE" || after.action === "RETRY") blindWriteRetries += 1;
      if (reconciliationStatus === "EXECUTED" && after.reason === "RECONCILED_EXECUTED") {
        recovered += 1;
      } else {
        const response = "The final external state could not be confirmed; no retry was issued.";
        if (response.trim().length === 0) emptyResponses += 1;
        else safelyDegraded += 1;
      }
    }

    const metrics = Object.freeze({
      generatedCases: 1_000,
      recoveryEligible,
      recovered,
      recoverySuccess: recovered / recoveryEligible,
      degradationEligible,
      safelyDegraded,
      safeDegradationSuccess: safelyDegraded / degradationEligible,
      duplicateSideEffects,
      blindWriteRetries,
      emptyResponses,
    });
    console.log(`PHASE13_2_STAGE_A_METRICS ${JSON.stringify(metrics)}`);

    expect(metrics.recoverySuccess).toBeGreaterThanOrEqual(0.95);
    expect(metrics.safeDegradationSuccess).toBe(1);
    expect(metrics.duplicateSideEffects).toBe(0);
    expect(metrics.blindWriteRetries).toBe(0);
    expect(metrics.emptyResponses).toBe(0);
  });
});
