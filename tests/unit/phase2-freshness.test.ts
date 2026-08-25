import { describe, expect, it } from "vitest";

import { FixedClock } from "@driveguard/shared";
import { ContextFreshnessEvaluator, DEFAULT_FRESHNESS_REQUIREMENTS } from "@driveguard/context";
import { DomainValidationError } from "@driveguard/domain";
import {
  createSnapshotBuilder,
  createValidSnapshot,
  PHASE_2_NOW_MS,
} from "../fixtures/phase2-domain.js";

describe("Phase 2 ContextFreshnessEvaluator", () => {
  it("defines the Phase 2 read-only and low-risk requirement data", () => {
    expect(DEFAULT_FRESHNESS_REQUIREMENTS).toEqual({
      readOnly: { maxAgeMs: 5_000, requiresLatest: false },
      lowRisk: { maxAgeMs: 2_000, requiresLatest: false },
    });
  });

  it.each([
    [4_999, 5_000, "FRESH"],
    [5_000, 5_000, "FRESH"],
    [5_001, 5_000, "STALE"],
    [0, 0, "FRESH"],
    [1, 0, "STALE"],
    [86_400_000, 5_000, "STALE"],
  ])("evaluates age=%s max=%s as %s", (age, maxAgeMs, expected) => {
    const snapshot = createValidSnapshot();
    const evaluator = new ContextFreshnessEvaluator(new FixedClock(PHASE_2_NOW_MS + age));
    expect(evaluator.evaluate(snapshot, { maxAgeMs, requiresLatest: false }).status).toBe(expected);
  });

  it("reports a timestamp in the future without throwing", () => {
    const snapshot = createValidSnapshot();
    const evaluator = new ContextFreshnessEvaluator(new FixedClock(PHASE_2_NOW_MS - 1));
    const result = evaluator.evaluate(snapshot, { maxAgeMs: 5_000, requiresLatest: false });
    expect(result).toMatchObject({ status: "INVALID_FUTURE_TIMESTAMP", ageMs: -1 });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5])(
    "rejects invalid injected evaluator clock value %s",
    (nowMs) => {
      const evaluator = new ContextFreshnessEvaluator(new FixedClock(nowMs));
      expect(() =>
        evaluator.evaluate(createValidSnapshot(), { maxAgeMs: 5_000, requiresLatest: false }),
      ).toThrow(DomainValidationError);
    },
  );

  it("reports NOT_LATEST when latest context is required and differs", () => {
    const builder = createSnapshotBuilder();
    const snapshot = createValidSnapshot(builder);
    const latest = createValidSnapshot(builder);
    const evaluator = new ContextFreshnessEvaluator(new FixedClock(PHASE_2_NOW_MS));
    expect(
      evaluator.evaluate(
        snapshot,
        { maxAgeMs: 5_000, requiresLatest: true },
        latest.contextVersion,
      ),
    ).toMatchObject({ status: "NOT_LATEST", latestVersion: 2 });
  });

  it("is fresh when latest context is required and matches", () => {
    const snapshot = createValidSnapshot();
    const evaluator = new ContextFreshnessEvaluator(new FixedClock(PHASE_2_NOW_MS));
    expect(
      evaluator.evaluate(snapshot, { maxAgeMs: 0, requiresLatest: true }, snapshot.contextVersion)
        .status,
    ).toBe("FRESH");
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid maxAgeMs %s",
    (maxAgeMs) => {
      const snapshot = createValidSnapshot();
      const evaluator = new ContextFreshnessEvaluator(new FixedClock(PHASE_2_NOW_MS));
      expect(() => evaluator.evaluate(snapshot, { maxAgeMs, requiresLatest: false })).toThrow(
        DomainValidationError,
      );
    },
  );

  it("rejects a non-boolean requiresLatest runtime value", () => {
    const snapshot = createValidSnapshot();
    const evaluator = new ContextFreshnessEvaluator(new FixedClock(PHASE_2_NOW_MS));
    const requirement = { maxAgeMs: 5_000, requiresLatest: false };
    Object.defineProperty(requirement, "requiresLatest", { value: "yes" });
    expect(() => evaluator.evaluate(snapshot, requirement)).toThrow(DomainValidationError);
  });

  it("requires latestVersion input when requiresLatest is true", () => {
    const snapshot = createValidSnapshot();
    const evaluator = new ContextFreshnessEvaluator(new FixedClock(PHASE_2_NOW_MS));
    expect(() => evaluator.evaluate(snapshot, { maxAgeMs: 5_000, requiresLatest: true })).toThrow(
      DomainValidationError,
    );
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", null])(
    "rejects invalid latestVersion %s",
    (latestVersion) => {
      const snapshot = createValidSnapshot();
      const evaluator = new ContextFreshnessEvaluator(new FixedClock(PHASE_2_NOW_MS));
      expect(() =>
        evaluator.evaluate(snapshot, { maxAgeMs: 5_000, requiresLatest: true }, latestVersion),
      ).toThrow(DomainValidationError);
    },
  );

  it("includes the evaluated versions and age in structured output", () => {
    const snapshot = createValidSnapshot();
    const evaluator = new ContextFreshnessEvaluator(new FixedClock(PHASE_2_NOW_MS + 12));
    const result = evaluator.evaluate(
      snapshot,
      { maxAgeMs: 20, requiresLatest: true },
      snapshot.contextVersion,
    );
    expect(result).toEqual({
      status: "FRESH",
      ageMs: 12,
      maxAgeMs: 20,
      snapshotVersion: 1,
      latestVersion: 1,
    });
  });
});
