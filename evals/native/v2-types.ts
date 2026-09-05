import type { NativeCategory } from "./types.js";

export const NATIVE_DATASET_V2_VERSION = "DriveGuard-Eval-v2.0.0" as const;

export type PolicyDecisionV2 = "ALLOW" | "DENY" | "REPLAN" | "REQUIRE_CONFIRMATION";
export type AuxiliaryConditionV2 =
  "MISSING_REQUIRED_INFORMATION" | "STATE_REFRESH" | "STALE_CONTEXT" | "RECOVERY_RECONCILIATION";

export interface ConditionalAuxiliaryToolV2 {
  readonly name: string;
  readonly when: AuxiliaryConditionV2;
}

export interface ToolContractV2 {
  readonly required: readonly string[];
  readonly conditionalAuxiliary: readonly ConditionalAuxiliaryToolV2[];
  readonly activeConditions: readonly AuxiliaryConditionV2[];
  readonly forbidden: readonly string[];
  readonly maxAuxiliaryCalls: number;
  readonly maxToolCalls: number;
}

export type ArgumentMatcherV2 =
  | { readonly kind: "exact"; readonly expected: unknown }
  | { readonly kind: "numeric_tolerance"; readonly expected: number; readonly tolerance: number }
  | { readonly kind: "normalized_text"; readonly expected: string }
  | { readonly kind: "canonical_category"; readonly expected: string };

export interface ToolArgumentContractV2 {
  readonly fields: Readonly<Record<string, ArgumentMatcherV2>>;
  readonly allowAdditionalFields: boolean;
}

export interface PolicyActionContractV2 {
  readonly toolName: string;
  readonly expected: PolicyDecisionV2;
  readonly critical: boolean;
  readonly requiredEvaluation: boolean;
}

export type ConfirmationLifecycleStateV2 =
  | "ACTION_PROPOSED"
  | "POLICY_CHECKED"
  | "CONFIRMATION_CREATED"
  | "USER_CONFIRMED"
  | "EXECUTING"
  | "EXECUTED"
  | "STATE_REFRESHED"
  | "FINAL_RESPONSE";

export type ExecutionStatusV2 = "SUCCEEDED" | "FAILED" | "BLOCKED" | "NOT_APPLICABLE";
export type BusinessOutcomeStatusV2 =
  | "SUCCEEDED"
  | "FAILED"
  | "BLOCKED"
  | "AWAITING_CONFIRMATION"
  | "REPLAN_REQUIRED"
  | "SAFE_DEGRADATION"
  | "UNKNOWN"
  | "NOT_APPLICABLE";

export type RecoveryKindV2 =
  | "NONE"
  | "READ_TIMEOUT"
  | "READ_503"
  | "CONNECTION_ABORT"
  | "DEFINITE_WRITE_FAILURE"
  | "AMBIGUOUS_SIDE_EFFECT"
  | "DUPLICATE_REQUEST";

export interface NoRecoveryContractV2 {
  readonly kind: "NONE";
}

export interface ActiveRecoveryContractV2 {
  readonly kind: Exclude<RecoveryKindV2, "NONE">;
  readonly retrySafety:
    "BOUNDED_SAFE_RETRY" | "IDEMPOTENT_REPLAY" | "RECONCILE_BEFORE_RETRY" | "NO_RETRY";
  readonly requireAttempt: boolean;
  readonly allowSafeDegradation: boolean;
  readonly requireReconciliation: boolean;
  readonly forbidBlindWriteRetry: boolean;
  readonly maxSideEffectCount: number;
}

export type RecoveryContractV2 = NoRecoveryContractV2 | ActiveRecoveryContractV2;

export interface TaskContractV2 {
  readonly goal: string;
  readonly taskClass: "no_tool" | "agent_tool" | "urgent_event";
  readonly tool: ToolContractV2;
  readonly arguments: Readonly<Record<string, ToolArgumentContractV2>>;
  readonly policy: { readonly actions: readonly PolicyActionContractV2[] };
  readonly confirmation: {
    readonly required: boolean;
    readonly protectedTools: readonly string[];
    readonly requiredLifecycle: readonly ConfirmationLifecycleStateV2[];
  };
  readonly outcome: {
    readonly agentToolExecution: ExecutionStatusV2;
    readonly urgentProcessorExecution: ExecutionStatusV2;
    readonly minSimulatorSideEffects: number;
    readonly maxSimulatorSideEffects: number;
    readonly finalBusinessOutcome: BusinessOutcomeStatusV2;
  };
  readonly recovery: RecoveryContractV2;
  readonly finalResponse: {
    readonly allowEmpty: boolean;
    readonly expectedExecutionClaim: "EXECUTED" | "NOT_EXECUTED" | "UNKNOWN" | "NO_CLAIM";
  };
}

export interface NativeEvalCaseV2 {
  readonly caseId: string;
  readonly datasetVersion: typeof NATIVE_DATASET_V2_VERSION;
  readonly category: NativeCategory;
  readonly scenario: string;
  readonly seed: number;
  readonly userPrompt: string;
  readonly initialState: Readonly<Record<string, unknown>>;
  readonly sourceDatasetVersion: "DriveGuard-Eval-v1.0.0";
  readonly contract: TaskContractV2;
}

export interface NativeCaseIdentityV2 {
  readonly runId: string;
  readonly caseId: string;
  readonly trialId: string;
  readonly traceId: string;
  readonly idempotencyKey: string;
}

export interface ObservedToolCallV2 {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly schemaValid: boolean;
  readonly auxiliaryCondition?: AuxiliaryConditionV2;
}

export interface NativeObservationV2 {
  readonly identity: NativeCaseIdentityV2;
  readonly validity: "VALID" | "INFRA_FAILURE" | "EVALUATOR_FAILURE";
  readonly infrastructureError?: string;
  readonly toolCalls: readonly ObservedToolCallV2[];
  readonly policyEvaluations: readonly {
    readonly toolName: string;
    readonly decision: PolicyDecisionV2;
  }[];
  readonly confirmationLifecycle: readonly ConfirmationLifecycleStateV2[];
  readonly execution: {
    readonly agentToolExecution: ExecutionStatusV2;
    readonly urgentProcessorExecution: ExecutionStatusV2;
    readonly simulatorSideEffectCount: number;
    readonly finalBusinessOutcome: BusinessOutcomeStatusV2;
    readonly forbiddenActionExecuted: boolean;
    readonly duplicateSideEffectCount: number;
  };
  readonly recovery: {
    readonly attempted: boolean;
    readonly succeeded: boolean;
    readonly safeDegradation: boolean;
    readonly outcomeReconciled: boolean;
    readonly blindWriteRetry: boolean;
    readonly duplicateRequestCount: number;
    readonly idempotencyKeyReused?: boolean;
  };
  readonly finalResponse: string;
  readonly latencyMs: number;
  readonly benchmarkRetryCount: number;
  readonly providerRetryCount: number | null;
}

export type FailureAttributionV2 = "AGENT_ERROR" | "EVALUATION_ERROR" | "INFRA_ERROR";

export type FailureReasonV2 =
  | "MISSING_TOOL"
  | "UNNECESSARY_TOOL"
  | "FORBIDDEN_TOOL"
  | "WRONG_ARGUMENT"
  | "INVALID_SCHEMA"
  | "WRONG_POLICY"
  | "CONFIRMATION_ERROR"
  | "EXECUTION_ERROR"
  | "RECOVERY_ERROR"
  | "FINAL_RESPONSE_ERROR"
  | "POST_EXECUTION_RESPONSE_STALE"
  | "TRACE_INSUFFICIENT"
  | "INFRASTRUCTURE_FAILURE";

export interface CaseFailureV2 {
  readonly caseId: string;
  readonly attribution: FailureAttributionV2;
  readonly reason: FailureReasonV2;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly detail: string;
}
