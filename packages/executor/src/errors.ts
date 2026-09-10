import { ActionLifecycleError } from "@driveguard/action-lifecycle";
import { ToolExecutionError } from "@driveguard/tools";

import type {
  ExecutionErrorClassification,
  ExecutionErrorCode,
  SafeExecutionError,
} from "./types.js";
import { recoveryFailureType, type RecoveryFailureType } from "./recovery.js";

export class ExecutorFault extends Error {
  readonly code: ExecutionErrorCode;
  readonly failureType: RecoveryFailureType | undefined;

  constructor(code: ExecutionErrorCode, message: string, failureType?: RecoveryFailureType) {
    super(message);
    this.name = "ExecutorFault";
    this.code = code;
    this.failureType = failureType;
  }
}

export function safeExecutionError(
  code: ExecutionErrorCode,
  retryable = false,
): SafeExecutionError {
  const messages: Record<ExecutionErrorCode, string> = {
    EXECUTION_VALIDATION_ERROR: "Execution request failed validation",
    EXECUTION_NOT_AUTHORIZED: "Execution is not authorized",
    AUTHORIZATION_EXPIRED: "Execution authorization has expired",
    AUTHORIZATION_ALREADY_USED: "Execution authorization was already used",
    AUTHORIZATION_MISMATCH: "Execution authorization does not match the request",
    IDEMPOTENCY_CONFLICT: "Idempotency key conflicts with another action",
    DEPENDENCY_TIMEOUT: "Tool dependency timed out",
    DEPENDENCY_UNAVAILABLE: "Tool dependency is unavailable",
    EXECUTOR_BUSY: "Executor capacity is temporarily unavailable",
    CIRCUIT_OPEN: "Tool dependency circuit is open",
    RETRY_EXHAUSTED: "Retry attempts were exhausted",
    OUTCOME_UNKNOWN: "The side-effect outcome is unknown",
    TOOL_EXECUTION_FAILED: "Tool execution failed",
    INTERNAL_EXECUTION_ERROR: "Execution failed safely",
  };
  return Object.freeze({ code, message: messages[code], retryable });
}

export function authorizationErrorCode(error: unknown): ExecutionErrorCode {
  if (error instanceof ActionLifecycleError) {
    if (error.code === "AUTHORIZATION_EXPIRED") return "AUTHORIZATION_EXPIRED";
    if (error.code === "AUTHORIZATION_ALREADY_USED") return "AUTHORIZATION_ALREADY_USED";
    if (error.code === "AUTHORIZATION_MISMATCH") return "AUTHORIZATION_MISMATCH";
  }
  return "EXECUTION_NOT_AUTHORIZED";
}

export function classifyToolFailure(
  error: unknown,
  sideEffect: boolean,
  downstreamRetrySafe: boolean,
): {
  readonly classification: ExecutionErrorClassification;
  readonly code: ExecutionErrorCode;
  readonly failureType: RecoveryFailureType;
} {
  let code: ExecutionErrorCode = "TOOL_EXECUTION_FAILED";
  let transient = false;
  if (error instanceof ExecutorFault) {
    code = error.code;
    transient = code === "DEPENDENCY_TIMEOUT" || code === "DEPENDENCY_UNAVAILABLE";
  } else if (error instanceof ToolExecutionError) {
    if (error.code === "DEPENDENCY_TIMEOUT") {
      code = "DEPENDENCY_TIMEOUT";
      transient = true;
    } else if (error.code === "DEPENDENCY_UNAVAILABLE") {
      code = "DEPENDENCY_UNAVAILABLE";
      transient = true;
    }
  }
  const failureType = recoveryFailureType(error);
  const hasExplicitFailureType =
    typeof error === "object" && error !== null && Reflect.get(error, "failureType") !== undefined;
  const explicitlyAmbiguous =
    hasExplicitFailureType &&
    (failureType === "TIMEOUT" ||
      failureType === "CONNECTION_ABORT" ||
      failureType === "AMBIGUOUS_SIDE_EFFECT");
  if (!transient) return { classification: "NON_RETRYABLE", code, failureType };
  if (sideEffect && (explicitlyAmbiguous || (!hasExplicitFailureType && !downstreamRetrySafe))) {
    return { classification: "AMBIGUOUS_SIDE_EFFECT", code, failureType };
  }
  if (sideEffect && !downstreamRetrySafe) {
    return { classification: "NON_RETRYABLE", code, failureType };
  }
  return { classification: "RETRYABLE", code, failureType };
}

export function classifyToolError(
  error: unknown,
  sideEffect: boolean,
  downstreamRetrySafe: boolean,
): { readonly classification: ExecutionErrorClassification; readonly code: ExecutionErrorCode } {
  const classified = classifyToolFailure(error, sideEffect, downstreamRetrySafe);
  return { classification: classified.classification, code: classified.code };
}
