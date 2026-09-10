export class UrgentEventValidationError extends Error {
  readonly code = "URGENT_EVENT_INVALID" as const;

  constructor(message = "Urgent event validation failed") {
    super(message);
    this.name = "UrgentEventValidationError";
  }
}

export class UrgentEventTransientError extends Error {
  readonly code = "URGENT_EVENT_TRANSIENT_FAILURE" as const;
  readonly retryDelayMs: number | undefined;

  constructor(
    message = "Urgent event handling failed transiently",
    options?: ErrorOptions & { readonly retryDelayMs?: number },
  ) {
    super(message, options);
    this.name = "UrgentEventTransientError";
    this.retryDelayMs = options?.retryDelayMs;
  }
}

export class UrgentEventPermanentError extends Error {
  readonly code = "URGENT_EVENT_PERMANENT_FAILURE" as const;

  constructor(message = "Urgent event handling failed permanently", options?: ErrorOptions) {
    super(message, options);
    this.name = "UrgentEventPermanentError";
  }
}
