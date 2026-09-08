import { ActionLifecycleError } from "@driveguard/action-lifecycle";

export const API_ERROR_CODES = [
  "VALIDATION_ERROR",
  "SESSION_NOT_FOUND",
  "ACTION_NOT_FOUND",
  "EXECUTION_NOT_FOUND",
  "URGENT_EVENT_NOT_FOUND",
  "CONFIRMATION_INVALID",
  "ACTION_EXPIRED",
  "SESSION_BUSY",
  "SERVICE_BUSY",
  "POLICY_DENIED",
  "REPLAN_REQUIRED",
  "DEPENDENCY_UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;

  constructor(code: ApiErrorCode, message: string, statusCode: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function actionApiError(error: unknown): ApiError {
  if (!(error instanceof ActionLifecycleError)) {
    return new ApiError("INTERNAL_ERROR", "The request failed safely", 500);
  }
  switch (error.code) {
    case "ACTION_NOT_FOUND":
      return new ApiError("ACTION_NOT_FOUND", "Action was not found", 404);
    case "CONFIRMATION_EXPIRED":
    case "AUTHORIZATION_EXPIRED":
      return new ApiError("ACTION_EXPIRED", "Action or authorization has expired", 409);
    case "CONFIRMATION_TOKEN_INVALID":
    case "CONFIRMATION_IDENTITY_MISMATCH":
    case "INVALID_COMMAND":
    case "INVALID_STATE":
      return new ApiError("CONFIRMATION_INVALID", "Confirmation request is invalid", 403);
    case "REVALIDATION_FAILED":
      return new ApiError("REPLAN_REQUIRED", "Current context requires replanning", 409);
    default:
      return new ApiError("INTERNAL_ERROR", "The action request failed safely", 500);
  }
}

export function runtimeApiError(code: string | undefined): ApiError {
  switch (code) {
    case "SESSION_BUSY":
      return new ApiError("SERVICE_BUSY", "Session already has an active request", 503);
    case "POLICY_DENIED":
      return new ApiError("POLICY_DENIED", "Policy denied the requested action", 403);
    case "POLICY_REPLAN_REQUIRED":
      return new ApiError("REPLAN_REQUIRED", "Current context requires replanning", 409);
    case "TOOL_ERROR":
    case "CONTEXT_LOAD_FAILED":
      return new ApiError("DEPENDENCY_UNAVAILABLE", "A required dependency is unavailable", 503);
    default:
      return new ApiError("INTERNAL_ERROR", "The Agent request failed safely", 500);
  }
}
