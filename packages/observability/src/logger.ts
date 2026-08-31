import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";

export const OBSERVABILITY_REDACTION_PATHS = Object.freeze([
  "authorization",
  "Authorization",
  "cookie",
  "Cookie",
  "confirmationToken",
  "confirmation_token",
  "confirmationCredential",
  "confirmation_credential",
  "executionAuthorization",
  "executionAuthorizationSecret",
  "DEEPSEEK_API_KEY",
  "apiKey",
  "api_key",
  "secret",
  "token",
  "prompt",
  "rawPrompt",
  "chainOfThought",
  "chain_of_thought",
  "reasoning",
  "headers.authorization",
  "headers.Authorization",
  "headers.cookie",
  "headers.Cookie",
  "req.headers.authorization",
  "req.headers.cookie",
  "req.body.prompt",
  "body.prompt",
  "*.authorization",
  "*.Authorization",
  "*.cookie",
  "*.Cookie",
  "*.confirmationToken",
  "*.confirmation_token",
  "*.confirmationCredential",
  "*.confirmation_credential",
  "*.executionAuthorization",
  "*.executionAuthorizationSecret",
  "*.DEEPSEEK_API_KEY",
  "*.apiKey",
  "*.api_key",
  "*.secret",
  "*.token",
  "*.prompt",
  "*.rawPrompt",
  "*.chainOfThought",
  "*.chain_of_thought",
  "*.reasoning",
] as const);

export type ObservableLogLevel = "debug" | "info" | "warn" | "error";

export interface CorrelationFields {
  readonly traceId: string | null;
  readonly runId: string | null;
  readonly sessionId: string | null;
  readonly actionId?: string | null;
  readonly executionId?: string | null;
  readonly toolName?: string | null;
  readonly eventId?: string | null;
}

export interface ObservableLogDetails {
  readonly policyDecision?: string;
  readonly durationMs?: number;
  readonly errorCode?: string;
  readonly attempt?: number;
  readonly status?: string;
  readonly method?: string;
  readonly route?: string;
  readonly statusCode?: number;
}

export interface DriveGuardLoggerOptions {
  readonly service: string;
  readonly level?: string;
  readonly destination?: DestinationStream;
  readonly sensitiveValues?: readonly string[];
}

function safeText(value: string, sensitiveValues: readonly string[]): string {
  let safe = value;
  for (const sensitive of sensitiveValues) {
    if (sensitive.length > 0) safe = safe.replaceAll(sensitive, "[REDACTED]");
  }
  return safe;
}

function sanitizeDetails(
  details: ObservableLogDetails | undefined,
  sensitiveValues: readonly string[],
): ObservableLogDetails | undefined {
  if (details === undefined) return undefined;
  const sanitized: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(details) as [
    keyof ObservableLogDetails,
    string | number | undefined,
  ][]) {
    if (value === undefined) continue;
    sanitized[key] = typeof value === "string" ? safeText(value, sensitiveValues) : value;
  }
  return sanitized;
}

export function createPinoLogger(options: DriveGuardLoggerOptions): Logger {
  const configuration: LoggerOptions = {
    level: options.level ?? "info",
    base: { service: options.service },
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    formatters: {
      level(label: string) {
        return { level: label };
      },
    },
    redact: {
      paths: [...OBSERVABILITY_REDACTION_PATHS],
      censor: "[REDACTED]",
    },
  };
  return options.destination === undefined
    ? pino(configuration)
    : pino(configuration, options.destination);
}

export class DriveGuardLogger {
  readonly #logger: Logger;
  readonly #sensitiveValues: readonly string[];

  constructor(options: DriveGuardLoggerOptions) {
    this.#logger = createPinoLogger(options);
    this.#sensitiveValues = Object.freeze([...(options.sensitiveValues ?? [])]);
  }

  write(
    level: ObservableLogLevel,
    event: string,
    correlation: CorrelationFields,
    details?: ObservableLogDetails,
  ): void {
    const fields = {
      event: safeText(event, this.#sensitiveValues),
      traceId: correlation.traceId,
      runId: correlation.runId,
      sessionId: correlation.sessionId,
      ...(correlation.actionId === undefined ? {} : { actionId: correlation.actionId }),
      ...(correlation.executionId === undefined ? {} : { executionId: correlation.executionId }),
      ...(correlation.toolName === undefined ? {} : { toolName: correlation.toolName }),
      ...(correlation.eventId === undefined ? {} : { eventId: correlation.eventId }),
      ...(sanitizeDetails(details, this.#sensitiveValues) ?? {}),
    };
    this.#logger[level](fields);
  }

  flush(): void {
    this.#logger.flush();
  }
}
