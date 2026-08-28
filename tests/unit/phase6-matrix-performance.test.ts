import { performance } from "node:perf_hooks";

import { PolicyEngine } from "@driveguard/policy";
import { describe, expect, it } from "vitest";

import { PHASE6_EVALUATED_AT } from "../fixtures/phase6-policy.js";
import {
  PHASE6_POLICY_MATRIX,
  generatedPolicyCase,
  matrixInput,
} from "../fixtures/phase6-policy-matrix.js";

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? Number.POSITIVE_INFINITY;
}

describe("Phase 6 machine-readable Policy Case Matrix", () => {
  const engine = new PolicyEngine();

  it.each(PHASE6_POLICY_MATRIX)("$id matches decision and rule", (row) => {
    const result = engine.evaluate(matrixInput(row), PHASE6_EVALUATED_AT);
    expect(result.decision).toBe(row.expectedDecision);
    expect(result.ruleId).toBe(row.expectedRuleId);
    expect(result.riskLevel).toBe(row.risk);
  });

  it("runs 10,000 deterministic matrix evaluations with zero mismatches", () => {
    const prepared = Array.from({ length: 10_000 }, (_, index) => generatedPolicyCase(index));
    for (let index = 0; index < 1_000; index += 1) {
      engine.evaluate(prepared[index]!.input, PHASE6_EVALUATED_AT);
    }
    const durations: number[] = [];
    let decisionMismatch = 0;
    let ruleMismatch = 0;
    let nondeterministic = 0;
    let criticalExpected = 0;
    let criticalMatched = 0;
    for (const entry of prepared) {
      const started = performance.now();
      const result = engine.evaluate(entry.input, PHASE6_EVALUATED_AT);
      durations.push(performance.now() - started);
      if (result.decision !== entry.expectedDecision) decisionMismatch += 1;
      if (result.ruleId !== entry.expectedRuleId) ruleMismatch += 1;
      const triple = `${result.decision}|${result.ruleId}|${result.reasonCode}`;
      const repeated = engine.evaluate(entry.input, PHASE6_EVALUATED_AT);
      const repeatedTriple = `${repeated.decision}|${repeated.ruleId}|${repeated.reasonCode}`;
      if (repeatedTriple !== triple) nondeterministic += 1;
      if (entry.expectedDecision !== "ALLOW") {
        criticalExpected += 1;
        if (result.decision === entry.expectedDecision && result.ruleId === entry.expectedRuleId) {
          criticalMatched += 1;
        }
      }
    }
    durations.sort((left, right) => left - right);
    const p95 = percentile(durations, 0.95);
    const p99 = percentile(durations, 0.99);
    process.stdout.write(
      `PHASE6_POLICY_METRICS ${JSON.stringify({ definedRows: PHASE6_POLICY_MATRIX.length, generatedCases: prepared.length, evaluations: prepared.length * 2, uniqueCaseIds: new Set(prepared.map((entry) => entry.id)).size, criticalExpected, criticalMatched, criticalRecall: criticalMatched / criticalExpected, decisionMismatch, ruleMismatch, nondeterministic, p95Ms: p95, p99Ms: p99 })}\n`,
    );
    expect(new Set(prepared.map((entry) => entry.id)).size).toBe(10_000);
    expect(new Set(prepared.map((entry) => entry.tool)).size).toBe(14);
    expect(decisionMismatch).toBe(0);
    expect(ruleMismatch).toBe(0);
    expect(nondeterministic).toBe(0);
    expect(criticalMatched).toBe(criticalExpected);
    expect(p95).toBeLessThan(5);
    expect(p99).toBeLessThan(10);
  }, 60_000);
});
