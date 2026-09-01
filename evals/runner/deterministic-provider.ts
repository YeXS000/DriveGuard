import type { NativeEvalCase, NativeObservation } from "../native/types.js";

function stableLatency(item: NativeEvalCase): number {
  const base = item.expectedTools.required.length > 1 ? 45 : 18;
  return base + (item.seed % 17);
}

/**
 * Evaluation-only deterministic provider. It validates runner/scorer/report behavior and never
 * represents live model quality. Live mode is a separate opt-in path.
 */
export function executeDeterministicCase(item: NativeEvalCase): NativeObservation {
  const contextFacts =
    item.contextMutation === undefined
      ? {}
      : { [item.contextMutation.path]: structuredClone(item.contextMutation.after) };
  return Object.freeze({
    caseId: item.caseId,
    toolCalls: Object.freeze(
      item.expectedTools.required.map((name) =>
        Object.freeze({
          name,
          arguments: Object.freeze(structuredClone(item.expectedArguments[name] ?? {})),
          schemaValid: true,
        }),
      ),
    ),
    policyDecision: item.expectedPolicy,
    confirmationRequested: item.confirmationExpected,
    confirmationBypassed: false,
    executionSucceeded: item.expectedPolicy !== "DENY" && item.expectedPolicy !== "REPLAN",
    transientFailureRecovered: item.faultInjection === undefined ? null : true,
    duplicateSideEffects: 0,
    forbiddenActionExecuted: false,
    contextFacts: Object.freeze(contextFacts),
    urgentEventHandled: item.urgentEvent === undefined ? null : true,
    finalOutcome: Object.freeze(structuredClone(item.expectedOutcome)),
    latencyMs: stableLatency(item),
  });
}
