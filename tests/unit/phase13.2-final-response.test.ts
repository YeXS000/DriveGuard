import {
  createConfirmedActionCompletion,
  finalResponseMatchesExecution,
} from "@driveguard/agent-runtime";
import { toUtcTimestamp } from "@driveguard/domain";
import type { ExecutionResult } from "@driveguard/executor";
import { describe, expect, it } from "vitest";

const at = toUtcTimestamp(Date.UTC(2026, 8, 3));

function execution(status: ExecutionResult["status"]): ExecutionResult {
  return Object.freeze({
    executionId: `execution:${status.toLowerCase()}`,
    toolName: "reserve_charging_slot",
    status,
    attemptCount: 1,
    deduplicated: false,
    startedAt: at,
    completedAt: at,
  });
}

describe("Phase 13.2 confirmation final-response guard", () => {
  it("emits the complete ordered lifecycle only after confirmed execution and refresh", () => {
    const completion = createConfirmedActionCompletion({
      command: { actionId: "action:confirmed" },
      toolName: "reserve_charging_slot",
      execution: execution("SUCCEEDED"),
      stateRefresh: { status: "REFRESHED", snapshotId: "snapshot:2", contextVersion: 2 },
    });

    expect(completion.lifecycle).toEqual([
      "ACTION_PROPOSED",
      "POLICY_CHECKED",
      "CONFIRMATION_CREATED",
      "USER_CONFIRMED",
      "EXECUTING",
      "EXECUTED",
      "STATE_REFRESHED",
      "FINAL_RESPONSE",
    ]);
    expect(completion.idempotencyKey).toBe("confirmed:action:confirmed");
    expect(completion.response).toContain("completed successfully");
  });

  it.each(["FAILED", "RETRY_EXHAUSTED", "OUTCOME_UNKNOWN", "REJECTED"] as const)(
    "never turns a %s receipt into a success claim",
    (status) => {
      const completion = createConfirmedActionCompletion({
        command: { actionId: `action:${status.toLowerCase()}` },
        toolName: "reserve_charging_slot",
        execution: execution(status),
        stateRefresh: { status: "UNAVAILABLE" },
      });
      expect(completion.response.trim().length).toBeGreaterThan(0);
      expect(finalResponseMatchesExecution(completion.response, completion.execution)).toBe(true);
      expect(completion.lifecycle).not.toContain("EXECUTED");
      expect(completion.lifecycle.at(-1)).toBe("FINAL_RESPONSE");
    },
  );

  it("rejects an externally supplied stale success claim for a failed receipt", () => {
    expect(finalResponseMatchesExecution("The action was executed.", execution("FAILED"))).toBe(
      false,
    );
  });

  it("measures 1,000 confirmation completions with no stale or empty final response", () => {
    let validLifecycle = 0;
    let staleResponses = 0;
    let emptyResponses = 0;
    for (let caseIndex = 0; caseIndex < 1_000; caseIndex += 1) {
      const status =
        caseIndex < 900
          ? ("SUCCEEDED" as const)
          : caseIndex < 950
            ? ("OUTCOME_UNKNOWN" as const)
            : ("FAILED" as const);
      const completion = createConfirmedActionCompletion({
        command: { actionId: `action:gate:${caseIndex}` },
        toolName: "reserve_charging_slot",
        execution: execution(status),
        stateRefresh: { status: "REFRESHED", snapshotId: `snapshot:${caseIndex}` },
      });
      if (
        completion.lifecycle[0] === "ACTION_PROPOSED" &&
        completion.lifecycle.at(-1) === "FINAL_RESPONSE" &&
        (status !== "SUCCEEDED" ||
          (completion.lifecycle.includes("EXECUTED") &&
            completion.lifecycle.includes("STATE_REFRESHED")))
      ) {
        validLifecycle += 1;
      }
      if (!finalResponseMatchesExecution(completion.response, completion.execution)) {
        staleResponses += 1;
      }
      if (completion.response.trim().length === 0) emptyResponses += 1;
    }
    const metrics = {
      generatedCases: 1_000,
      validLifecycle,
      confirmationLifecycleSuccess: validLifecycle / 1_000,
      staleResponses,
      emptyResponses,
    };
    console.log(`PHASE13_2_STAGE_B_METRICS ${JSON.stringify(metrics)}`);
    expect(metrics.confirmationLifecycleSuccess).toBe(1);
    expect(metrics.staleResponses).toBe(0);
    expect(metrics.emptyResponses).toBe(0);
  });
});
