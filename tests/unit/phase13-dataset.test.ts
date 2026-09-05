import { describe, expect, it } from "vitest";

import { validateNativeDataset } from "../../evals/native/datasets/validator.js";
import { CATEGORY_TARGETS, buildNativeDataset } from "../../evals/native/scenarios/catalog.js";
import { NATIVE_CATEGORIES, NATIVE_DATASET_VERSION } from "../../evals/native/types.js";

describe("Phase 13 DriveGuard-Eval v1 dataset", () => {
  const dataset = buildNativeDataset();

  it("contains exactly 600 versioned cases", () => {
    expect(dataset).toHaveLength(600);
    expect(dataset.every((item) => item.datasetVersion === NATIVE_DATASET_VERSION)).toBe(true);
  });

  it.each(NATIVE_CATEGORIES)("has the declared %s category count", (category) => {
    expect(dataset.filter((item) => item.category === category)).toHaveLength(
      CATEGORY_TARGETS[category],
    );
  });

  it("has unique case IDs and seeds", () => {
    expect(new Set(dataset.map((item) => item.caseId)).size).toBe(dataset.length);
    expect(new Set(dataset.map((item) => item.seed)).size).toBe(dataset.length);
  });

  it("has no duplicate structured scenario after identity and prompt-style normalization", () => {
    const normalized = new Set(
      dataset.map((item) =>
        JSON.stringify({ ...item, caseId: undefined, seed: undefined, userPrompt: undefined }),
      ),
    );
    expect(normalized.size).toBe(dataset.length);
  });

  it("does not leak formal Tool names or Policy labels into user prompts", () => {
    for (const item of dataset) {
      const formalLabels = [
        ...item.expectedTools.required,
        ...item.expectedTools.allowedAuxiliary,
        ...item.expectedTools.forbidden,
        "ALLOW",
        "DENY",
        "REPLAN",
        "REQUIRE_CONFIRMATION",
      ];
      expect(
        formalLabels.filter((label) => item.userPrompt.includes(label)),
        item.caseId,
      ).toEqual([]);
    }
  });

  it("keeps exact prompt repetition bounded across distinct world-state cases", () => {
    const counts = new Map<string, number>();
    for (const item of dataset) {
      counts.set(item.userPrompt, (counts.get(item.userPrompt) ?? 0) + 1);
    }
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(7);
  });

  it("makes every required Tool Ground Truth explicit", () => {
    for (const item of dataset) {
      for (const tool of item.expectedTools.required) {
        expect(item.expectedArguments).toHaveProperty(tool);
      }
    }
  });

  it("keeps required, auxiliary and forbidden Tool sets disjoint", () => {
    for (const item of dataset) {
      const required = new Set(item.expectedTools.required);
      const allowed = new Set(item.expectedTools.allowedAuxiliary);
      const forbidden = new Set(item.expectedTools.forbidden);
      expect([...required].some((tool) => allowed.has(tool) || forbidden.has(tool))).toBe(false);
      expect([...allowed].some((tool) => forbidden.has(tool))).toBe(false);
    }
  });

  it("uses real world-state changes for every Context refresh case", () => {
    const cases = dataset.filter((item) => item.category === "multi_turn_context_refresh");
    expect(cases).toHaveLength(60);
    expect(
      cases.every((item) => item.contextMutation?.before !== item.contextMutation?.after),
    ).toBe(true);
  });

  it("covers all five required urgent event types", () => {
    const types = new Set(
      dataset.flatMap((item) => (item.urgentEvent ? [item.urgentEvent.type] : [])),
    );
    expect(types).toEqual(
      new Set([
        "LOW_SOC",
        "CHARGING_INTERRUPTED",
        "VEHICLE_FAULT",
        "ROUTE_BLOCKED",
        "ASSISTANCE_REQUIRED",
      ]),
    );
  });

  it("covers all representative Executor fault modes", () => {
    const modes = new Set(
      dataset.flatMap((item) => (item.faultInjection ? [item.faultInjection.mode] : [])),
    );
    expect(modes).toEqual(
      new Set([
        "http_503",
        "timeout",
        "connection_abort",
        "ambiguous_side_effect",
        "duplicate_request",
      ]),
    );
  });

  it("passes the closed dataset validator", () => {
    expect(validateNativeDataset(dataset)).toMatchObject({
      valid: true,
      errors: [],
      caseCount: 600,
    });
  });

  it("validator rejects duplicate IDs", () => {
    const duplicate = [...dataset, dataset[0]!];
    expect(
      validateNativeDataset(duplicate).errors.some((error) => error.includes("duplicate caseId")),
    ).toBe(true);
  });
});
