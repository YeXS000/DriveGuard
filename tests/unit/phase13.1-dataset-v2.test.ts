import { describe, expect, it } from "vitest";

import { buildNativeDatasetV2 } from "../../evals/native/datasets/v2.js";
import { validateNativeDatasetV2 } from "../../evals/native/datasets/v2-validator.js";
import { buildNativeDataset } from "../../evals/native/scenarios/catalog.js";
import { NATIVE_DATASET_V2_VERSION } from "../../evals/native/v2-types.js";

describe("Phase 13.1 DriveGuard-Eval V2 Task Contracts", () => {
  const v1 = buildNativeDataset();
  const v2 = buildNativeDatasetV2(v1);

  it("preserves all 600 V1 identities while changing the schema version", () => {
    expect(v2).toHaveLength(600);
    expect(v2.map((item) => item.caseId)).toEqual(v1.map((item) => item.caseId));
    expect(v2.every((item) => item.datasetVersion === NATIVE_DATASET_V2_VERSION)).toBe(true);
  });

  it("uses condition-bound auxiliary Tools instead of a global read-only allowance", () => {
    expect(
      v2.every((item) =>
        item.contract.tool.conditionalAuxiliary.every((auxiliary) => auxiliary.when.length > 0),
      ),
    ).toBe(true);
    const explicitNavigation = v2.find(
      (item) =>
        item.contract.tool.required.includes("set_navigation_destination") &&
        item.contract.arguments.set_navigation_destination?.fields.destination !== undefined,
    );
    expect(explicitNavigation?.contract.tool.activeConditions).toEqual([]);
  });

  it("uses typed argument contracts for text, numeric and canonical business arguments", () => {
    const navigation = v2.find((item) =>
      item.contract.tool.required.includes("set_navigation_destination"),
    );
    const temperature = v2.find((item) =>
      item.contract.tool.required.includes("set_cabin_temperature"),
    );
    const assistance = v2.find((item) =>
      item.contract.tool.required.includes("request_roadside_assistance"),
    );
    expect(
      navigation?.contract.arguments.set_navigation_destination?.fields.destination,
    ).toMatchObject({ kind: "normalized_text" });
    expect(
      temperature?.contract.arguments.set_cabin_temperature?.fields.temperatureC,
    ).toMatchObject({ kind: "numeric_tolerance", tolerance: 0.5 });
    expect(assistance?.contract.arguments.request_roadside_assistance?.fields.reason).toMatchObject(
      { kind: "canonical_category" },
    );
  });

  it("assigns fault-type-specific recovery contracts", () => {
    const kinds = new Set(
      v2
        .filter((item) => item.category === "executor_fault_recovery")
        .map((item) => item.contract.recovery.kind),
    );
    expect(kinds).toEqual(
      new Set([
        "READ_TIMEOUT",
        "READ_503",
        "CONNECTION_ABORT",
        "DEFINITE_WRITE_FAILURE",
        "AMBIGUOUS_SIDE_EFFECT",
        "DUPLICATE_REQUEST",
      ]),
    );
    const ambiguous = v2.find((item) => item.contract.recovery.kind === "AMBIGUOUS_SIDE_EFFECT");
    expect(ambiguous?.contract.arguments.get_charging_status).toEqual({
      allowAdditionalFields: false,
      fields: {},
    });
  });

  it("keeps safety refusals out of the Agent Tool execution channel", () => {
    const refusal = v2.find(
      (item) =>
        item.contract.tool.required.length === 0 &&
        item.contract.outcome.finalBusinessOutcome === "BLOCKED",
    );
    expect(refusal?.contract.outcome.agentToolExecution).toBe("NOT_APPLICABLE");
  });

  it("passes closed V2 schema validation for every case", () => {
    expect(validateNativeDatasetV2(v2)).toEqual({ valid: true, errors: [], caseCount: 600 });
  });
});
