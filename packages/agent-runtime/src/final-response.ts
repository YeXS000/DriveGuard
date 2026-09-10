import type { ConfirmActionCommand } from "@driveguard/action-lifecycle";
import type { ExecutionResult } from "@driveguard/executor";

export const CONFIRMED_ACTION_LIFECYCLE_STATES = [
  "ACTION_PROPOSED",
  "POLICY_CHECKED",
  "CONFIRMATION_CREATED",
  "USER_CONFIRMED",
  "EXECUTING",
  "EXECUTED",
  "STATE_REFRESHED",
  "FINAL_RESPONSE",
] as const;
export type ConfirmedActionLifecycleState = (typeof CONFIRMED_ACTION_LIFECYCLE_STATES)[number];

export interface ConfirmedActionStateRefresh {
  readonly status: "REFRESHED" | "UNAVAILABLE";
  readonly snapshotId?: string;
  readonly contextVersion?: number;
}

export interface ConfirmedActionCompletion {
  readonly actionId: string;
  readonly toolName: string;
  readonly idempotencyKey: string;
  readonly execution: ExecutionResult;
  readonly stateRefresh: ConfirmedActionStateRefresh;
  readonly lifecycle: readonly ConfirmedActionLifecycleState[];
  readonly response: string;
}

function responseForExecution(
  execution: ExecutionResult,
  stateRefresh: ConfirmedActionStateRefresh,
): string {
  if (execution.status === "SUCCEEDED") {
    return stateRefresh.status === "REFRESHED"
      ? "The requested action completed successfully, and the current state was refreshed."
      : "The requested action completed successfully, but the current state could not be refreshed.";
  }
  if (execution.status === "OUTCOME_UNKNOWN") {
    return "The external service outcome could not be confirmed. No blind retry was issued.";
  }
  if (execution.status === "RETRY_EXHAUSTED") {
    return "The requested action was not executed to a confirmed completion after bounded retries. No further action was issued.";
  }
  return "The requested action failed and was not executed to a confirmed completion.";
}

export function finalResponseMatchesExecution(
  response: string,
  execution: Pick<ExecutionResult, "status">,
): boolean {
  const normalized = response.trim().toLowerCase();
  if (normalized.length === 0) return false;
  const successClaim = /\b(completed successfully|succeeded|was executed)\b/u.test(normalized);
  return execution.status === "SUCCEEDED" || !successClaim;
}

export function createConfirmedActionCompletion(input: {
  readonly command: Pick<ConfirmActionCommand, "actionId">;
  readonly toolName: string;
  readonly execution: ExecutionResult;
  readonly stateRefresh: ConfirmedActionStateRefresh;
}): ConfirmedActionCompletion {
  const response = responseForExecution(input.execution, input.stateRefresh);
  if (!finalResponseMatchesExecution(response, input.execution)) {
    throw new TypeError("Final response does not match the execution receipt");
  }
  const lifecycle: ConfirmedActionLifecycleState[] = [
    "ACTION_PROPOSED",
    "POLICY_CHECKED",
    "CONFIRMATION_CREATED",
    "USER_CONFIRMED",
    "EXECUTING",
  ];
  if (input.execution.status === "SUCCEEDED") lifecycle.push("EXECUTED");
  if (input.stateRefresh.status === "REFRESHED") lifecycle.push("STATE_REFRESHED");
  lifecycle.push("FINAL_RESPONSE");
  return Object.freeze({
    actionId: input.command.actionId,
    toolName: input.toolName,
    idempotencyKey: `confirmed:${input.command.actionId}`,
    execution: input.execution,
    stateRefresh: Object.freeze({ ...input.stateRefresh }),
    lifecycle: Object.freeze(lifecycle),
    response,
  });
}
