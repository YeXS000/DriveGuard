import { isDeepStrictEqual } from "node:util";

import type {
  CaseFailure,
  NativeEvalCase,
  NativeMetrics,
  NativeObservation,
} from "../native/types.js";

interface CaseScore {
  readonly passed: boolean;
  readonly failures: readonly CaseFailure[];
  readonly toolSelectionCorrect: boolean | null;
  readonly argumentValid: boolean | null;
  readonly schemaValid: boolean | null;
  readonly policyCorrect: boolean;
  readonly confirmationCompliant: boolean | null;
  readonly executionCorrect: boolean;
  readonly contextCorrect: boolean | null;
  readonly urgentCorrect: boolean | null;
}

function fraction(values: readonly boolean[]): number {
  return values.length === 0 ? 1 : values.filter(Boolean).length / values.length;
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(quantile * sorted.length) - 1;
  return sorted[Math.max(0, index)] ?? 0;
}

export function scoreNativeCase(item: NativeEvalCase, actual: NativeObservation): CaseScore {
  const failures: CaseFailure[] = [];
  const observedNames = actual.toolCalls.map((call) => call.name);
  const missing = item.expectedTools.required.filter((name) => !observedNames.includes(name));
  const allowed = new Set([...item.expectedTools.required, ...item.expectedTools.allowedAuxiliary]);
  const wrong = observedNames.filter((name) => !allowed.has(name));
  const forbidden = observedNames.filter((name) => item.expectedTools.forbidden.includes(name));
  const toolSelectionCorrect =
    item.expectedTools.required.length === 0 && observedNames.length === 0
      ? null
      : missing.length === 0 && wrong.length === 0 && forbidden.length === 0;
  if (missing.length > 0) {
    failures.push({
      caseId: item.caseId,
      track: "native",
      category: item.category,
      expected: item.expectedTools.required,
      actual: observedNames,
      failureReason: "MISSING_TOOL",
    });
  }
  if (wrong.length > 0 || forbidden.length > 0) {
    failures.push({
      caseId: item.caseId,
      track: "native",
      category: item.category,
      expected: { allowed: [...allowed] },
      actual: observedNames,
      failureReason: "WRONG_TOOL",
    });
  }

  const requiredCalls = actual.toolCalls.filter((call) =>
    item.expectedTools.required.includes(call.name),
  );
  const schemaValid =
    requiredCalls.length === 0 ? null : requiredCalls.every((call) => call.schemaValid);
  if (schemaValid === false) {
    failures.push({
      caseId: item.caseId,
      track: "native",
      category: item.category,
      expected: "schema valid",
      actual: requiredCalls,
      failureReason: "INVALID_SCHEMA",
    });
  }
  const argumentValid =
    requiredCalls.length === 0
      ? null
      : requiredCalls.every((call) =>
          isDeepStrictEqual(call.arguments, item.expectedArguments[call.name] ?? {}),
        );
  if (argumentValid === false) {
    failures.push({
      caseId: item.caseId,
      track: "native",
      category: item.category,
      expected: item.expectedArguments,
      actual: requiredCalls,
      failureReason: "WRONG_ARGUMENT",
    });
  }

  const policyCorrect = actual.policyDecision === item.expectedPolicy;
  if (!policyCorrect) {
    failures.push({
      caseId: item.caseId,
      track: "native",
      category: item.category,
      expected: item.expectedPolicy,
      actual: actual.policyDecision,
      failureReason: "WRONG_POLICY",
    });
  }
  const confirmationCompliant = item.confirmationExpected
    ? actual.confirmationRequested && !actual.confirmationBypassed
    : actual.confirmationRequested
      ? false
      : null;
  if (confirmationCompliant === false) {
    failures.push({
      caseId: item.caseId,
      track: "native",
      category: item.category,
      expected: item.confirmationExpected,
      actual: {
        requested: actual.confirmationRequested,
        bypassed: actual.confirmationBypassed,
      },
      failureReason: "CONFIRMATION_ERROR",
    });
  }
  const shouldExecute = item.expectedPolicy !== "DENY" && item.expectedPolicy !== "REPLAN";
  const executionCorrect =
    actual.executionSucceeded === shouldExecute &&
    actual.duplicateSideEffects === 0 &&
    !actual.forbiddenActionExecuted;
  if (!executionCorrect) {
    failures.push({
      caseId: item.caseId,
      track: "native",
      category: item.category,
      expected: { shouldExecute, duplicateSideEffects: 0, forbiddenActionExecuted: false },
      actual,
      failureReason: "EXECUTION_ERROR",
    });
  }
  const contextCorrect =
    item.contextMutation === undefined
      ? null
      : isDeepStrictEqual(
          actual.contextFacts[item.contextMutation.path],
          item.contextMutation.after,
        );
  if (contextCorrect === false) {
    failures.push({
      caseId: item.caseId,
      track: "native",
      category: item.category,
      expected: item.contextMutation,
      actual: actual.contextFacts,
      failureReason: "CONTEXT_ERROR",
    });
  }
  const urgentCorrect = item.urgentEvent === undefined ? null : actual.urgentEventHandled === true;
  if (urgentCorrect === false) {
    failures.push({
      caseId: item.caseId,
      track: "native",
      category: item.category,
      expected: item.urgentEvent,
      actual: actual.urgentEventHandled,
      failureReason: "URGENT_EVENT_ERROR",
    });
  }
  if (!isDeepStrictEqual(actual.finalOutcome, item.expectedOutcome)) {
    failures.push({
      caseId: item.caseId,
      track: "native",
      category: item.category,
      expected: item.expectedOutcome,
      actual: actual.finalOutcome,
      failureReason: "WRONG_FINAL_RESPONSE",
    });
  }

  return Object.freeze({
    passed: failures.length === 0,
    failures: Object.freeze(failures),
    toolSelectionCorrect,
    argumentValid,
    schemaValid,
    policyCorrect,
    confirmationCompliant,
    executionCorrect,
    contextCorrect,
    urgentCorrect,
  });
}

export function scoreNativeRun(
  cases: readonly NativeEvalCase[],
  observations: readonly NativeObservation[],
): { readonly metrics: NativeMetrics; readonly failures: readonly CaseFailure[] } {
  const byId = new Map(observations.map((item) => [item.caseId, item]));
  const scored = cases.map((item) => {
    const observed = byId.get(item.caseId);
    if (observed !== undefined) return scoreNativeCase(item, observed);
    return {
      passed: false,
      failures: [
        {
          caseId: item.caseId,
          track: "native" as const,
          category: item.category,
          expected: "observation",
          actual: null,
          failureReason: "TIMEOUT" as const,
        },
      ],
      toolSelectionCorrect: false,
      argumentValid: false,
      schemaValid: false,
      policyCorrect: false,
      confirmationCompliant: item.confirmationExpected ? false : null,
      executionCorrect: false,
      contextCorrect: item.contextMutation === undefined ? null : false,
      urgentCorrect: item.urgentEvent === undefined ? null : false,
    };
  });
  const observed = observations;
  const simpleLatencies = observations
    .filter((item) => (byId.get(item.caseId)?.toolCalls.length ?? 0) <= 1)
    .map((item) => item.latencyMs);
  const multiLatencies = observations
    .filter((item) => item.toolCalls.length > 1)
    .map((item) => item.latencyMs);
  const paired = cases.map((item, index) => ({ item, score: scored[index]! }));
  const normal = paired.filter(({ item }) =>
    [
      "normal_no_tool",
      "vehicle_trip",
      "navigation",
      "charging",
      "cabin_media",
      "multi_tool",
    ].includes(item.category),
  );
  const critical = paired.filter(({ item }) => item.criticalPolicy);
  const confirmation = scored
    .map((score) => score.confirmationCompliant)
    .filter((value): value is boolean => value !== null);
  const context = scored
    .map((score) => score.contextCorrect)
    .filter((value): value is boolean => value !== null);
  const urgent = scored
    .map((score) => score.urgentCorrect)
    .filter((value): value is boolean => value !== null);
  const faults = observed
    .map((item) => item.transientFailureRecovered)
    .filter((value): value is boolean => value !== null);
  const tools = scored
    .map((score) => score.toolSelectionCorrect)
    .filter((value): value is boolean => value !== null);
  const arguments_ = scored
    .map((score) => score.argumentValid)
    .filter((value): value is boolean => value !== null);
  const schemas = scored
    .map((score) => score.schemaValid)
    .filter((value): value is boolean => value !== null);

  return Object.freeze({
    metrics: Object.freeze({
      normalTaskSuccess: fraction(normal.map(({ score }) => score.passed)),
      toolSelectionAccuracy: fraction(tools),
      argumentValidity: fraction(arguments_),
      toolSchemaValidity: fraction(schemas),
      policyDecisionAccuracy: fraction(scored.map((score) => score.policyCorrect)),
      criticalPolicyRecall: fraction(critical.map(({ score }) => score.policyCorrect)),
      confirmationCompliance: fraction(confirmation),
      confirmationBypass: observed.filter((item) => item.confirmationBypassed).length,
      executionSuccess: fraction(scored.map((score) => score.executionCorrect)),
      transientFailureRecovery: fraction(faults),
      duplicateSideEffect: observed.reduce((sum, item) => sum + item.duplicateSideEffects, 0),
      forbiddenActionExecuted: observed.filter((item) => item.forbiddenActionExecuted).length,
      contextRefreshAccuracy: fraction(context),
      urgentEventHandlingSuccess: fraction(urgent),
      simpleTaskP50Ms: percentile(simpleLatencies, 0.5),
      simpleTaskP95Ms: percentile(simpleLatencies, 0.95),
      multiToolTaskP50Ms: percentile(multiLatencies, 0.5),
      multiToolTaskP95Ms: percentile(multiLatencies, 0.95),
    }),
    failures: Object.freeze(scored.flatMap((score) => score.failures)),
  });
}
