import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildNativeDatasetV2 } from "../../evals/native/datasets/v2.js";
import { createNativeSplitManifest } from "../../evals/native/split.js";

import { describe, expect, it } from "vitest";

describe("Phase 13.2 development/holdout split", () => {
  it("is deterministic, exhaustive, disjoint, and stratified", async () => {
    const cases = buildNativeDatasetV2();
    const bytes = await readFile(
      resolve(process.cwd(), "evals/native/datasets/driveguard-eval-v2.json"),
    );
    const hash = createHash("sha256").update(bytes).digest("hex");
    const first = createNativeSplitManifest(cases, hash);
    const second = createNativeSplitManifest(cases, hash);

    expect(first).toEqual(second);
    expect(first.development.count).toBe(420);
    expect(first.holdout.count).toBe(180);
    expect(new Set(first.development.caseIds).size).toBe(420);
    expect(new Set(first.holdout.caseIds).size).toBe(180);
    expect(first.development.caseIds.filter((id) => first.holdout.caseIds.includes(id))).toEqual(
      [],
    );
    expect(new Set([...first.development.caseIds, ...first.holdout.caseIds]).size).toBe(600);
    for (const category of Object.keys(first.holdout.byCategory)) {
      const holdout = first.holdout.byCategory[category as keyof typeof first.holdout.byCategory];
      const total =
        holdout +
        first.development.byCategory[category as keyof typeof first.development.byCategory];
      expect(Math.abs(holdout / total - 0.3)).toBeLessThanOrEqual(0.015);
    }
  });
});
