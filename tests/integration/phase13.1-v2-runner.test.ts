import { describe, expect, it } from "vitest";

import { buildNativeDatasetV2 } from "../../evals/native/datasets/v2.js";
import { buildNativeDataset } from "../../evals/native/scenarios/catalog.js";
import {
  BenchmarkInfrastructureError,
  mapWithConcurrency,
  runNativeBenchmarkV2,
} from "../../evals/runner/native-v2-runner.js";
import { createPerfectV2Observation } from "../../evals/runner/v2-observation.js";
import { deriveFinalBusinessOutcomeV2 } from "../../evals/runner/live-provider.js";
import {
  normalizeEvaluationDerivedObservationV2,
  rescoreNativeBenchmarkReportV2,
} from "../../evals/reports/native-v2-rescore.js";

describe("Phase 13.1 case-level concurrency and isolation", () => {
  const source = buildNativeDataset();
  const contracts = buildNativeDatasetV2(source);

  it("derives no-tool and blocked business outcomes without expectedPolicy shortcuts", () => {
    const common = {
      executionSucceeded: false,
      confirmationRequested: false,
      userConfirmed: false,
      faultInjected: false,
      ambiguousSideEffect: false,
      outcomeReconciled: false,
      response: "",
    } as const;
    expect(
      deriveFinalBusinessOutcomeV2({ ...common, taskClass: "no_tool", actualPolicy: "ALLOW" }),
    ).toBe("NOT_APPLICABLE");
    expect(
      deriveFinalBusinessOutcomeV2({ ...common, taskClass: "agent_tool", actualPolicy: "DENY" }),
    ).toBe("BLOCKED");
    expect(
      deriveFinalBusinessOutcomeV2({ ...common, taskClass: "agent_tool", actualPolicy: "REPLAN" }),
    ).toBe("REPLAN_REQUIRED");
    expect(
      deriveFinalBusinessOutcomeV2({
        ...common,
        taskClass: "agent_tool",
        actualPolicy: "ALLOW",
        faultInjected: true,
        ambiguousSideEffect: true,
      }),
    ).toBe("UNKNOWN");

    const ambiguousIndex = contracts.findIndex(
      (item) => item.contract.recovery.kind === "AMBIGUOUS_SIDE_EFFECT",
    );
    const ambiguous = contracts[ambiguousIndex]!;
    const observation = createPerfectV2Observation(ambiguous);
    expect(
      normalizeEvaluationDerivedObservationV2(ambiguous, {
        ...observation,
        execution: { ...observation.execution, finalBusinessOutcome: "SAFE_DEGRADATION" },
        recovery: { ...observation.recovery, outcomeReconciled: false },
      }).execution.finalBusinessOutcome,
    ).toBe("UNKNOWN");
  });

  it("preserves source order while enforcing the configured concurrency bound", async () => {
    let active = 0;
    let maxActive = 0;
    const output = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 4, async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return value * 2;
    });
    expect(output).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(maxActive).toBe(4);
  });

  it("uses unique run/case/trial/trace/idempotency identities for every case", async () => {
    const report = await runNativeBenchmarkV2({
      sourceCases: source.slice(0, 8),
      cases: contracts.slice(0, 8),
      mode: "deterministic",
      gitCommit: "test",
      concurrency: 8,
    });
    for (const key of ["runId", "trialId", "traceId", "idempotencyKey"] as const) {
      expect(new Set(report.observations.map((item) => item.identity[key])).size).toBe(8);
    }
    expect(report.metrics.evaluationErrorCount).toBe(0);
    expect(rescoreNativeBenchmarkReportV2(report, contracts, "2026-09-02T00:00:00Z")).toMatchObject(
      {
        scorerVersion: "DriveGuard-Scorer-v2.0.0",
        rescoredAt: "2026-09-02T00:00:00Z",
        caseCount: 8,
      },
    );
  });

  it("defaults quality to concurrency 4 and latency to serial comparability", async () => {
    const quality = await runNativeBenchmarkV2({
      sourceCases: source.slice(0, 2),
      cases: contracts.slice(0, 2),
      mode: "deterministic",
      gitCommit: "test",
    });
    const latency = await runNativeBenchmarkV2({
      sourceCases: source.slice(0, 2),
      cases: contracts.slice(0, 2),
      mode: "deterministic",
      profile: "latency",
      gitCommit: "test",
    });
    expect(quality.concurrency).toBe(4);
    expect(quality.latencyComparableToPhase13Serial).toBe(false);
    expect(latency.concurrency).toBe(1);
    expect(latency.latencyComparableToPhase13Serial).toBe(true);
  });

  it("retries a declared infrastructure failure once and records the retry", async () => {
    let attempts = 0;
    const report = await runNativeBenchmarkV2({
      sourceCases: source.slice(0, 1),
      cases: contracts.slice(0, 1),
      mode: "live",
      gitCommit: "test",
      executeLiveCase: (_item, identity) => {
        attempts += 1;
        if (attempts === 1) throw new BenchmarkInfrastructureError("provider 429");
        return Promise.resolve({
          caseId: identity.caseId,
          toolCalls: [],
          policyDecision: "ALLOW",
          confirmationRequested: false,
          confirmationBypassed: false,
          executionSucceeded: true,
          transientFailureRecovered: null,
          duplicateSideEffects: 0,
          forbiddenActionExecuted: false,
          contextFacts: {},
          urgentEventHandled: null,
          finalOutcome: {},
          latencyMs: 1,
          v2: createPerfectV2Observation(contracts[0]!, identity),
        });
      },
    });
    expect(attempts).toBe(2);
    expect(report.benchmarkRequestRetryCount).toBe(1);
  });

  it("never lets the benchmark runner retry an intentionally injected fault", async () => {
    const index = source.findIndex((item) => item.faultInjection !== undefined);
    let attempts = 0;
    const report = await runNativeBenchmarkV2({
      sourceCases: [source[index]!],
      cases: [contracts[index]!],
      mode: "live",
      gitCommit: "test",
      infrastructureRetries: 3,
      executeLiveCase: () => {
        attempts += 1;
        return Promise.reject(new BenchmarkInfrastructureError("injected timeout"));
      },
    });
    expect(attempts).toBe(1);
    expect(report.observations[0]).toMatchObject({
      validity: "VALID",
      benchmarkRetryCount: 0,
      recovery: { attempted: true },
    });
  });
});
