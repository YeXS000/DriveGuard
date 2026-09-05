import type { NativeEvalCase } from "../native/types.js";
import type {
  ConfirmationLifecycleStateV2,
  NativeCaseIdentityV2,
  NativeEvalCaseV2,
  NativeObservationV2,
  ObservedToolCallV2,
} from "../native/v2-types.js";

export function defaultCaseIdentityV2(
  caseId: string,
  runId = `eval-run:${caseId.toLowerCase()}`,
): NativeCaseIdentityV2 {
  return Object.freeze({
    runId,
    caseId,
    trialId: `${runId}:trial:1`,
    traceId: `${runId}:trace`,
    idempotencyKey: `${runId}:idempotency`,
  });
}

export function createPerfectV2Observation(
  item: NativeEvalCaseV2,
  identity: NativeCaseIdentityV2 = defaultCaseIdentityV2(item.caseId),
  latencyMs = 1,
): NativeObservationV2 {
  const toolCalls: ObservedToolCallV2[] = item.contract.tool.required.map((name) => {
    const contract = item.contract.arguments[name];
    return Object.freeze({
      name,
      arguments: Object.freeze(
        Object.fromEntries(
          Object.entries(contract?.fields ?? {}).map(([field, matcher]) => [
            field,
            matcher.expected,
          ]),
        ),
      ),
      schemaValid: true,
    });
  });
  const recovery = item.contract.recovery;
  return Object.freeze({
    identity,
    validity: "VALID",
    toolCalls: Object.freeze(toolCalls),
    policyEvaluations: Object.freeze(
      item.contract.policy.actions
        .filter((action) => action.requiredEvaluation)
        .map((action) => Object.freeze({ toolName: action.toolName, decision: action.expected })),
    ),
    confirmationLifecycle: Object.freeze([...item.contract.confirmation.requiredLifecycle]),
    execution: Object.freeze({
      agentToolExecution: item.contract.outcome.agentToolExecution,
      urgentProcessorExecution: item.contract.outcome.urgentProcessorExecution,
      simulatorSideEffectCount: item.contract.outcome.minSimulatorSideEffects,
      finalBusinessOutcome: item.contract.outcome.finalBusinessOutcome,
      forbiddenActionExecuted: false,
      duplicateSideEffectCount: 0,
    }),
    recovery: Object.freeze({
      attempted: recovery.kind !== "NONE",
      succeeded: recovery.kind !== "NONE",
      safeDegradation: false,
      outcomeReconciled: recovery.kind !== "NONE" && recovery.requireReconciliation,
      blindWriteRetry: false,
      duplicateRequestCount: recovery.kind === "DUPLICATE_REQUEST" ? 1 : 0,
      ...(recovery.kind === "DUPLICATE_REQUEST" ? { idempotencyKeyReused: true } : {}),
    }),
    finalResponse:
      item.contract.finalResponse.expectedExecutionClaim === "EXECUTED"
        ? "The requested action completed successfully."
        : item.contract.finalResponse.expectedExecutionClaim === "NOT_EXECUTED"
          ? "The requested action was not executed."
          : item.contract.finalResponse.expectedExecutionClaim === "UNKNOWN"
            ? "The final state could not be confirmed."
            : "Here is the requested information.",
    latencyMs,
    benchmarkRetryCount: 0,
    providerRetryCount: 0,
  });
}

export function lifecycleFromLiveEvidence(input: {
  readonly toolRequested: boolean;
  readonly policyChecked: boolean;
  readonly confirmationCreated: boolean;
  readonly finalResponseProduced: boolean;
  readonly userConfirmed: boolean;
  readonly executionStarted: boolean;
  readonly executionSucceeded: boolean;
  readonly stateRefreshed: boolean;
}): readonly ConfirmationLifecycleStateV2[] {
  const states: ConfirmationLifecycleStateV2[] = [];
  if (input.toolRequested) states.push("ACTION_PROPOSED");
  if (input.policyChecked) states.push("POLICY_CHECKED");
  if (input.confirmationCreated) states.push("CONFIRMATION_CREATED");
  if (input.userConfirmed) states.push("USER_CONFIRMED");
  if (input.executionStarted) states.push("EXECUTING");
  if (input.executionSucceeded) states.push("EXECUTED");
  if (input.stateRefreshed) states.push("STATE_REFRESHED");
  if (input.finalResponseProduced) states.push("FINAL_RESPONSE");
  return Object.freeze(states);
}

export interface LegacyTraceSufficiency {
  readonly caseId: string;
  readonly sufficient: boolean;
  readonly missingDimensions: readonly string[];
}

export function auditLegacyTrace(
  item: NativeEvalCase,
  observation: { readonly v2?: NativeObservationV2 },
): LegacyTraceSufficiency {
  if (observation.v2 !== undefined) {
    return Object.freeze({ caseId: item.caseId, sufficient: true, missingDimensions: [] });
  }
  const missing = ["action_level_policy", "final_response"];
  if (item.confirmationExpected) missing.push("confirmation_lifecycle");
  if (item.faultInjection !== undefined) missing.push("recovery_reconciliation");
  if (item.urgentEvent !== undefined) missing.push("urgent_execution_channels");
  return Object.freeze({
    caseId: item.caseId,
    sufficient: false,
    missingDimensions: Object.freeze(missing),
  });
}
