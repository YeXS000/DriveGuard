import { describe, expect, it } from "vitest";

import { buildNativeDatasetV2 } from "../../evals/native/datasets/v2.js";
import { buildNativeDataset } from "../../evals/native/scenarios/catalog.js";
import { offlineRescore } from "../../evals/reports/offline-rescore.js";
import { executeDeterministicCase } from "../../evals/runner/deterministic-provider.js";

describe("Phase 13.1 offline rescore trace sufficiency", () => {
  const source = buildNativeDataset().slice(0, 2);
  const contracts = buildNativeDatasetV2(source);

  it("does not guess V2 status from a legacy Boolean-only trace", () => {
    const legacy = executeDeterministicCase(source[0]!);
    const { v2: ignored, ...withoutV2 } = legacy;
    expect(ignored).toBeDefined();
    const report = offlineRescore({
      sourceRunId: "old",
      v1Cases: [source[0]!],
      v2Cases: [contracts[0]!],
      v1Observations: [withoutV2],
    });
    expect(report.traceSufficiency.requiresRerun).toBe(1);
    expect(report.cases[0]).toMatchObject({ newStatus: "NOT_SCORABLE" });
  });

  it("computes an exact old/new transition when a V2 trace is present", () => {
    const observation = executeDeterministicCase(source[1]!);
    const report = offlineRescore({
      sourceRunId: "old",
      v1Cases: [source[1]!],
      v2Cases: [contracts[1]!],
      v1Observations: [observation],
      v2Observations: [observation.v2!],
    });
    expect(report.transitions["OLD PASS -> NEW PASS"]).toBe(1);
    expect(report.traceSufficiency.sufficient).toBe(1);
    expect(report.cases[0]?.category).toBe(source[1]?.category);

    const oldFailure = offlineRescore({
      sourceRunId: "old",
      v1Cases: [source[1]!],
      v2Cases: [contracts[1]!],
      v1Observations: [{ ...observation, policyDecision: "DENY" }],
      v2Observations: [observation.v2!],
    });
    expect(oldFailure.transitions["OLD FAIL -> NEW PASS"]).toBe(1);
    expect(oldFailure.transitionReasons).toMatchObject({
      "OLD FAIL -> NEW PASS: V1/WRONG_POLICY": 1,
    });
  });
});
