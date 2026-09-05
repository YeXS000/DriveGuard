import type {
  ConsumeExecutionAuthorizationCommand,
  ExecutionAuthorization,
} from "@driveguard/action-lifecycle";
import type { UtcTimestamp } from "@driveguard/domain";
import type { PolicyDecision } from "@driveguard/policy";
import type { ToolRiskLevel } from "@driveguard/tools";

import type { RecoveryReceipt } from "./recovery.js";

export const EXECUTION_STATES = [
  "CREATED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "RETRY_EXHAUSTED",
  "OUTCOME_UNKNOWN",
  "REJECTED",
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

export interface ExecutionRequest {
  readonly executionId: string;
  readonly toolName: string;
  readonly validatedArguments: unknown;
  readonly actionFingerprint: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly vehicleId: string;
  readonly traceId: string;
  readonly riskLevel: ToolRiskLevel;
  readonly policyDecision: PolicyDecision;
  readonly actionId?: string;
  readonly authorizationId?: string;
  readonly contextSnapshotId?: string;
  readonly contextVersion?: number;
  readonly idempotencyKey: string;
  readonly createdAt: UtcTimestamp;
}

export const EXECUTION_ERROR_CODES = [
  "EXECUTION_VALIDATION_ERROR",
  "EXECUTION_NOT_AUTHORIZED",
  "AUTHORIZATION_EXPIRED",
  "AUTHORIZATION_ALREADY_USED",
  "AUTHORIZATION_MISMATCH",
  "IDEMPOTENCY_CONFLICT",
  "DEPENDENCY_TIMEOUT",
  "DEPENDENCY_UNAVAILABLE",
  "CIRCUIT_OPEN",
  "RETRY_EXHAUSTED",
  "OUTCOME_UNKNOWN",
  "TOOL_EXECUTION_FAILED",
  "INTERNAL_EXECUTION_ERROR",
] as const;
export type ExecutionErrorCode = (typeof EXECUTION_ERROR_CODES)[number];

export interface SafeExecutionError {
  readonly code: ExecutionErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ExecutionAttempt {
  readonly attempt: number;
  readonly startedAt: UtcTimestamp;
  readonly completedAt: UtcTimestamp;
  readonly outcome: "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "OUTCOME_UNKNOWN";
  readonly errorCode?: ExecutionErrorCode;
}

export interface ExecutionStateTransition {
  readonly from: ExecutionState | null;
  readonly to: ExecutionState;
  readonly transitionedAt: UtcTimestamp;
}

export interface ExecutionRecord {
  readonly executionId: string;
  readonly toolName: string;
  readonly actionFingerprint: string;
  readonly idempotencyKey: string;
  readonly state: ExecutionState;
  readonly attempts: readonly ExecutionAttempt[];
  readonly stateHistory: readonly ExecutionStateTransition[];
  readonly createdAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
}

export interface ExecutionResult {
  readonly executionId: string;
  readonly toolName: string;
  readonly status: ExecutionState;
  readonly attemptCount: number;
  readonly deduplicated: boolean;
  readonly startedAt: UtcTimestamp;
  readonly completedAt: UtcTimestamp;
  readonly result?: unknown;
  readonly error?: SafeExecutionError;
  readonly recovery?: RecoveryReceipt;
}

export interface ExecutionAuthorizationConsumer {
  consumeExecutionAuthorization(
    command: ConsumeExecutionAuthorizationCommand,
  ): Promise<ExecutionAuthorization>;
}

export type ExecutionErrorClassification = "RETRYABLE" | "NON_RETRYABLE" | "AMBIGUOUS_SIDE_EFFECT";
