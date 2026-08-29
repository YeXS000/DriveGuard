import type { CapabilityResolutionContext } from "@driveguard/capabilities";
import type { ContextConflictResult, ContextFreshnessResult } from "@driveguard/context";
import type { ContextSnapshot, UtcTimestamp } from "@driveguard/domain";
import type { PolicyDecision } from "@driveguard/policy";
import type { FormalToolName, ToolDefinition, ToolRiskLevel } from "@driveguard/tools";

export const ACTION_STATES = [
  "AWAITING_CONFIRMATION",
  "CONFIRMED",
  "READY_FOR_EXECUTION",
  "CANCELLED",
  "EXPIRED",
  "REPLAN_REQUIRED",
  "REJECTED",
] as const;
export type ActionState = (typeof ACTION_STATES)[number];

export interface ActionStateTransition {
  readonly from: ActionState | null;
  readonly to: ActionState;
  readonly transitionedAt: UtcTimestamp;
}

export interface ActionIntent {
  readonly actionId: string;
  readonly toolName: FormalToolName;
  readonly validatedArguments: unknown;
  readonly riskLevel: Extract<ToolRiskLevel, "R2" | "R3">;
  readonly runId: string;
  readonly sessionId: string;
  readonly traceId: string;
  readonly userId: string;
  readonly vehicleId: string;
  readonly policyRuleId: string;
  readonly policyDecision: PolicyDecision;
  readonly contextSnapshotId: string;
  readonly contextVersion: number;
  readonly createdAt: UtcTimestamp;
  readonly expiresAt: UtcTimestamp;
  readonly actionFingerprint: string;
  readonly confirmationSummary: string;
}

export interface PendingAction extends ActionIntent {
  readonly state: ActionState;
  readonly updatedAt: UtcTimestamp;
  readonly stateHistory: readonly ActionStateTransition[];
}

export interface TrustedConfirmationChallenge {
  readonly actionId: string;
  readonly confirmationToken: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly expiresAt: UtcTimestamp;
}

export interface SafeConfirmationRequiredResult {
  readonly actionId: string;
  readonly toolName: FormalToolName;
  readonly riskLevel: Extract<ToolRiskLevel, "R2" | "R3">;
  readonly expiresAt: UtcTimestamp;
  readonly summary: string;
}

export interface ExecutionAuthorization {
  readonly authorizationId: string;
  readonly actionId: string;
  readonly actionFingerprint: string;
  readonly toolName: FormalToolName;
  readonly riskLevel: Extract<ToolRiskLevel, "R2" | "R3">;
  readonly confirmationId: string;
  readonly policyRuleId: string;
  readonly contextSnapshotId: string;
  readonly contextVersion: number;
  readonly issuedAt: UtcTimestamp;
  readonly expiresAt: UtcTimestamp;
}

export interface ConsumeExecutionAuthorizationCommand {
  readonly authorizationId: string;
  readonly actionId: string;
  readonly actionFingerprint: string;
  readonly toolName: FormalToolName;
  readonly sessionId: string;
  readonly contextSnapshotId: string;
  readonly contextVersion: number;
  readonly validatedArguments: unknown;
}

export interface CreatePendingActionCommand {
  readonly definition: ToolDefinition;
  readonly validatedArguments: unknown;
  readonly runId: string;
  readonly sessionId: string;
  readonly traceId: string;
  readonly userId: string;
  readonly vehicleId: string;
  readonly policyDecision: PolicyDecision;
  readonly contextSnapshot: ContextSnapshot;
}

export interface ConfirmActionCommand {
  readonly actionId: string;
  readonly confirmationToken: string;
  readonly sessionId: string;
  readonly userId: string;
}

export interface BoundActionCommand {
  readonly actionId: string;
  readonly sessionId: string;
  readonly userId: string;
}

export interface CurrentActionContext {
  readonly snapshot: ContextSnapshot;
  readonly latestContextVersion: unknown;
  readonly availability: CapabilityResolutionContext;
}

export interface ActionRevalidationResult {
  readonly status: "VALID" | "REPLAN_REQUIRED";
  readonly reason:
    | "UNCHANGED"
    | "IRRELEVANT_VERSION_CHANGE"
    | "CONTEXT_STALE"
    | "CONTEXT_NOT_LATEST"
    | "CONTEXT_FUTURE_TIMESTAMP"
    | "RELEVANT_STATE_CHANGED"
    | "UNKNOWN_RELEVANT_PATH"
    | "CAPABILITY_UNAVAILABLE"
    | "SERVICE_UNAVAILABLE"
    | "TOOL_UNAVAILABLE"
    | "CONTEXT_RELOAD_FAILED";
  readonly currentContext: ContextSnapshot | null;
  readonly freshness: ContextFreshnessResult | null;
  readonly conflict: ContextConflictResult | null;
}
