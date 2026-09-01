import { describe, expect, it } from "vitest";

import { buildNativeDataset } from "../../evals/native/scenarios/catalog.js";
import { executeDeterministicCase } from "../../evals/runner/deterministic-provider.js";
import { scoreNativeCase, scoreNativeRun } from "../../evals/scorers/index.js";

describe("Phase 13 deterministic scorers", () => {
  const dataset = buildNativeDataset();
  const toolCase = dataset.find((item) => item.expectedTools.required.length > 0)!;
  const contextCase = dataset.find((item) => item.contextMutation !== undefined)!;
  const confirmationCase = dataset.find((item) => item.confirmationExpected)!;

  it("accepts a Ground Truth-equivalent observation", () => {
    expect(scoreNativeCase(toolCase, executeDeterministicCase(toolCase)).passed).toBe(true);
  });

  it("classifies a missing required Tool", () => {
    const observation = { ...executeDeterministicCase(toolCase), toolCalls: [] };
    expect(scoreNativeCase(toolCase, observation).failures).toContainEqual(
      expect.objectContaining({ failureReason: "MISSING_TOOL" }),
    );
  });

  it("does not penalize an allowed read-only auxiliary Tool", () => {
    const candidate = dataset.find((item) => item.expectedTools.allowedAuxiliary.length > 0)!;
    const observed = executeDeterministicCase(candidate);
    const auxiliary = candidate.expectedTools.allowedAuxiliary[0]!;
    const observation = {
      ...observed,
      toolCalls: [...observed.toolCalls, { name: auxiliary, arguments: {}, schemaValid: true }],
    };
    expect(scoreNativeCase(candidate, observation).toolSelectionCorrect).toBe(true);
  });

  it("classifies a forbidden or unnecessary Tool", () => {
    const observed = executeDeterministicCase(toolCase);
    const observation = {
      ...observed,
      toolCalls: [...observed.toolCalls, { name: "apply_brake", arguments: {}, schemaValid: true }],
    };
    expect(scoreNativeCase(toolCase, observation).failures).toContainEqual(
      expect.objectContaining({ failureReason: "WRONG_TOOL" }),
    );
  });

  it("separates schema invalidity from semantic argument mismatch", () => {
    const observed = executeDeterministicCase(toolCase);
    const invalidSchema = {
      ...observed,
      toolCalls: observed.toolCalls.map((call) => ({ ...call, schemaValid: false })),
    };
    expect(scoreNativeCase(toolCase, invalidSchema).schemaValid).toBe(false);
    const wrongSemantic = {
      ...observed,
      toolCalls: observed.toolCalls.map((call) => ({ ...call, arguments: { unexpected: true } })),
    };
    expect(scoreNativeCase(toolCase, wrongSemantic).argumentValid).toBe(false);
  });

  it("classifies wrong Policy separately", () => {
    const observed = executeDeterministicCase(toolCase);
    const observation = { ...observed, policyDecision: "DENY" as const };
    expect(scoreNativeCase(toolCase, observation).failures).toContainEqual(
      expect.objectContaining({ failureReason: "WRONG_POLICY" }),
    );
  });

  it("detects confirmation bypass", () => {
    const observed = executeDeterministicCase(confirmationCase);
    const observation = { ...observed, confirmationBypassed: true };
    expect(scoreNativeCase(confirmationCase, observation).confirmationCompliant).toBe(false);
  });

  it("scores refreshed state rather than conversational memory", () => {
    const observed = executeDeterministicCase(contextCase);
    expect(scoreNativeCase(contextCase, observed).contextCorrect).toBe(true);
    const stale = {
      ...observed,
      contextFacts: { [contextCase.contextMutation!.path]: contextCase.contextMutation!.before },
    };
    expect(scoreNativeCase(contextCase, stale).contextCorrect).toBe(false);
  });

  it("counts duplicate side effects and forbidden execution as absolute counts", () => {
    const observed = executeDeterministicCase(toolCase);
    const report = scoreNativeRun(
      [toolCase],
      [{ ...observed, duplicateSideEffects: 2, forbiddenActionExecuted: true }],
    );
    expect(report.metrics.duplicateSideEffect).toBe(2);
    expect(report.metrics.forbiddenActionExecuted).toBe(1);
  });

  it("uses stable metric denominators and reports a missing observation as TIMEOUT", () => {
    const report = scoreNativeRun([toolCase], []);
    expect(report.failures).toContainEqual(expect.objectContaining({ failureReason: "TIMEOUT" }));
    expect(report.metrics.toolSelectionAccuracy).toBe(0);
  });
});
