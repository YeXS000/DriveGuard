export const RUNTIME_ERROR_CODES = [
  "CONFIGURATION_ERROR",
  "CONTEXT_LOAD_FAILED",
  "CONTEXT_INVALID",
  "CAPABILITY_RESOLUTION_FAILED",
  "MODEL_ERROR",
  "TOOL_ERROR",
  "SESSION_BUSY",
  "RUN_CANCELLED",
  "INTERNAL_ERROR",
] as const;

export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[number];

export interface RuntimeFailure {
  readonly code: RuntimeErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export class AgentRuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly retryable: boolean;

  constructor(code: RuntimeErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "AgentRuntimeError";
    this.code = code;
    this.retryable = retryable;
  }

  toFailure(): RuntimeFailure {
    return Object.freeze({ code: this.code, message: this.message, retryable: this.retryable });
  }

  toJSON(): { readonly error: RuntimeFailure } {
    return { error: this.toFailure() };
  }
}

export function sanitizeRuntimeText(value: string, sensitiveValues: readonly string[]): string {
  let sanitized = value
    .replace(/authorization\s*:\s*bearer\s+\S+/giu, "[REDACTED]")
    .replace(/(?:api[_-]?key|token|secret)\s*[=:]\s*\S+/giu, "credential=[REDACTED]");
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue.length > 0) sanitized = sanitized.replaceAll(sensitiveValue, "[REDACTED]");
  }
  return sanitized;
}

export function safeRuntimeError(
  error: unknown,
  fallback: AgentRuntimeError,
  sensitiveValues: readonly string[],
): AgentRuntimeError {
  if (error instanceof AgentRuntimeError) {
    return new AgentRuntimeError(
      error.code,
      sanitizeRuntimeText(error.message, sensitiveValues),
      error.retryable,
    );
  }
  return new AgentRuntimeError(
    fallback.code,
    sanitizeRuntimeText(fallback.message, sensitiveValues),
    fallback.retryable,
  );
}
