export const NATIVE_DATASET_VERSION = "DriveGuard-Eval-v1.0.0" as const;

export const NATIVE_CATEGORIES = [
  "normal_no_tool",
  "vehicle_trip",
  "navigation",
  "charging",
  "cabin_media",
  "multi_tool",
  "multi_turn_context_refresh",
  "policy_confirmation",
  "executor_fault_recovery",
  "urgent_event",
] as const;

export type NativeCategory = (typeof NATIVE_CATEGORIES)[number];
export type ExpectedPolicy = "ALLOW" | "DENY" | "REPLAN" | "REQUIRE_CONFIRMATION";
export type BenchmarkMode = "deterministic" | "live";

export interface ExpectedToolSet {
  readonly required: readonly string[];
  readonly allowedAuxiliary: readonly string[];
  readonly forbidden: readonly string[];
}

export interface ContextMutation {
  readonly path: string;
  readonly before: unknown;
  readonly after: unknown;
}

export interface FaultInjection {
  readonly mode:
    "http_503" | "timeout" | "connection_abort" | "ambiguous_side_effect" | "duplicate_request";
  readonly target: string;
  readonly retrySafe: boolean;
}

export interface UrgentEventFixture {
  readonly type:
    "LOW_SOC" | "CHARGING_INTERRUPTED" | "VEHICLE_FAULT" | "ROUTE_BLOCKED" | "ASSISTANCE_REQUIRED";
  readonly expectedCandidateTool: string | null;
}

export interface NativeEvalCase {
  readonly caseId: string;
  readonly datasetVersion: typeof NATIVE_DATASET_VERSION;
  readonly category: NativeCategory;
  readonly scenario: string;
  readonly seed: number;
  readonly userPrompt: string;
  readonly initialState: Readonly<Record<string, unknown>>;
  readonly expectedTools: ExpectedToolSet;
  readonly expectedArguments: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly expectedPolicy: ExpectedPolicy;
  readonly criticalPolicy: boolean;
  readonly confirmationExpected: boolean;
  readonly expectedOutcome: Readonly<Record<string, unknown>>;
  readonly contextMutation?: ContextMutation;
  readonly faultInjection?: FaultInjection;
  readonly urgentEvent?: UrgentEventFixture;
}

export interface ObservedToolCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly schemaValid: boolean;
}

export interface NativeObservation {
  readonly caseId: string;
  readonly toolCalls: readonly ObservedToolCall[];
  readonly policyDecision: ExpectedPolicy;
  readonly confirmationRequested: boolean;
  readonly confirmationBypassed: boolean;
  readonly executionSucceeded: boolean;
  readonly transientFailureRecovered: boolean | null;
  readonly duplicateSideEffects: number;
  readonly forbiddenActionExecuted: boolean;
  readonly contextFacts: Readonly<Record<string, unknown>>;
  readonly urgentEventHandled: boolean | null;
  readonly finalOutcome: Readonly<Record<string, unknown>>;
  readonly latencyMs: number;
  readonly failureReason?: string;
}

export interface CaseFailure {
  readonly caseId: string;
  readonly track: "native";
  readonly category: NativeCategory;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly failureReason:
    | "WRONG_TOOL"
    | "MISSING_TOOL"
    | "WRONG_ARGUMENT"
    | "INVALID_SCHEMA"
    | "WRONG_POLICY"
    | "CONFIRMATION_ERROR"
    | "EXECUTION_ERROR"
    | "CONTEXT_ERROR"
    | "URGENT_EVENT_ERROR"
    | "WRONG_FINAL_RESPONSE"
    | "TIMEOUT";
}

export interface NativeMetrics {
  readonly normalTaskSuccess: number;
  readonly toolSelectionAccuracy: number;
  readonly argumentValidity: number;
  readonly toolSchemaValidity: number;
  readonly policyDecisionAccuracy: number;
  readonly criticalPolicyRecall: number;
  readonly confirmationCompliance: number;
  readonly confirmationBypass: number;
  readonly executionSuccess: number;
  readonly transientFailureRecovery: number;
  readonly duplicateSideEffect: number;
  readonly forbiddenActionExecuted: number;
  readonly contextRefreshAccuracy: number;
  readonly urgentEventHandlingSuccess: number;
  readonly simpleTaskP50Ms: number;
  readonly simpleTaskP95Ms: number;
  readonly multiToolTaskP50Ms: number;
  readonly multiToolTaskP95Ms: number;
}

export interface NativeBenchmarkReport {
  readonly benchmarkRunId: string;
  readonly gitCommit: string;
  readonly datasetVersion: typeof NATIVE_DATASET_VERSION;
  readonly mode: BenchmarkMode;
  readonly model: string;
  readonly modelConfiguration: Readonly<Record<string, unknown>>;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly caseCount: number;
  readonly categoryCounts: Readonly<Record<NativeCategory, number>>;
  readonly metrics: NativeMetrics;
  readonly failures: readonly CaseFailure[];
  readonly observations: readonly NativeObservation[];
  readonly qualityMetricsAreLive: boolean;
}
