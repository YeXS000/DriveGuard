import type { CapabilityResolutionContext } from "@driveguard/capabilities";
import type { ContextConflictResult, ContextFreshnessResult } from "@driveguard/context";
import type { ContextSnapshot, UtcTimestamp } from "@driveguard/domain";
import type { ToolDefinition, ToolRiskLevel } from "@driveguard/tools";

export const POLICY_DECISION_TYPES = ["ALLOW", "DENY", "REQUIRE_CONFIRMATION", "REPLAN"] as const;
export type PolicyDecisionType = (typeof POLICY_DECISION_TYPES)[number];

export const POLICY_REASON_CODES = [
  "FORBIDDEN_RX",
  "INVALID_POLICY_INPUT",
  "POLICY_EXCEPTION",
  "CAPABILITY_UNAVAILABLE",
  "SERVICE_UNAVAILABLE",
  "CONTEXT_INVALID",
  "CONTEXT_FUTURE_TIMESTAMP",
  "CONTEXT_STALE",
  "CONTEXT_NOT_LATEST",
  "CONTEXT_RELEVANT_STATE_CHANGED",
  "CONTEXT_PATH_UNKNOWN",
  "R3_CONFIRMATION_REQUIRED",
  "R2_CONFIRMATION_REQUIRED",
  "R1_ALLOWED",
  "R0_ALLOWED",
  "DEFAULT_DENY",
] as const;
export type PolicyReasonCode = (typeof POLICY_REASON_CODES)[number];

export type PolicyRiskLevel = ToolRiskLevel | "UNKNOWN";
export type PolicyFreshnessEvidence = ContextFreshnessResult["status"] | "UNKNOWN";
export type PolicyConflictEvidence = ContextConflictResult["status"] | "NOT_EVALUATED" | "UNKNOWN";

export interface PolicyEvidence {
  readonly freshnessStatus: PolicyFreshnessEvidence;
  readonly conflictStatus: PolicyConflictEvidence;
  readonly contextChanged: boolean;
  readonly requiredCapabilityAvailable: boolean;
  readonly serviceAvailable: boolean;
}

export interface PolicyDecision {
  readonly decision: PolicyDecisionType;
  readonly ruleId: string;
  readonly reasonCode: PolicyReasonCode;
  readonly toolName: string;
  readonly riskLevel: PolicyRiskLevel;
  readonly contextSnapshotId: string | null;
  readonly contextVersion: number | null;
  readonly evaluatedAt: UtcTimestamp | null;
  readonly evidence: PolicyEvidence;
}

/**
 * Normal callers supply this only after Phase 4 Tool schema validation. The public Engine still
 * accepts `unknown` at its boundary so forged/direct calls can be denied instead of throwing.
 */
export interface PolicyEvaluationInput {
  readonly toolDefinition: ToolDefinition;
  readonly validatedArguments: unknown;
  /** Set by the single Runtime guard after canonical Registry identity verification. */
  readonly trustedDefinition: boolean;
  readonly contextSnapshot: ContextSnapshot;
  readonly freshness: ContextFreshnessResult;
  readonly availability: CapabilityResolutionContext;
  readonly conflict?: ContextConflictResult;
  /** Runtime-owned identity used to bind an issued decision to one execution intent. */
  readonly executionBinding?: {
    readonly runId: string;
    readonly sessionId: string;
    readonly traceId: string;
    readonly actionFingerprint: string;
  };
}

export interface PolicyRuleResult {
  readonly decision: PolicyDecisionType;
  readonly reasonCode: PolicyReasonCode;
}

export interface PolicyRuleInput {
  readonly toolName: string;
  readonly riskLevel: PolicyRiskLevel;
  readonly inputValid: boolean;
  readonly contextPresent: boolean;
  readonly contextValid: boolean;
  readonly capabilityAvailable: boolean;
  readonly serviceAvailable: boolean;
  readonly freshnessStatus: PolicyFreshnessEvidence;
  readonly conflictStatus: PolicyConflictEvidence;
  readonly contextChanged: boolean;
  readonly contextRequirement: "STATE_REFRESH" | "LATEST_REQUIRED" | "UNKNOWN";
}

export interface PolicyRule {
  readonly ruleId: string;
  readonly priority: number;
  appliesTo(input: PolicyRuleInput): boolean;
  evaluate(input: PolicyRuleInput): PolicyRuleResult;
}
