export const ACTION_LIFECYCLE_ERROR_CODES = [
  "INVALID_COMMAND",
  "ACTION_NOT_FOUND",
  "INVALID_TRANSITION",
  "INVALID_STATE",
  "CONFIRMATION_TOKEN_INVALID",
  "CONFIRMATION_EXPIRED",
  "CONFIRMATION_IDENTITY_MISMATCH",
  "ACTION_INTEGRITY_FAILED",
  "REVALIDATION_FAILED",
  "AUTHORIZATION_ALREADY_ISSUED",
  "INTERNAL_ERROR",
] as const;

export type ActionLifecycleErrorCode = (typeof ACTION_LIFECYCLE_ERROR_CODES)[number];

export class ActionLifecycleError extends Error {
  readonly code: ActionLifecycleErrorCode;
  readonly actionId: string | null;
  readonly state: string | null;

  constructor(
    code: ActionLifecycleErrorCode,
    message: string,
    actionId: string | null = null,
    state: string | null = null,
  ) {
    super(message);
    this.name = "ActionLifecycleError";
    this.code = code;
    this.actionId = actionId;
    this.state = state;
  }

  toJSON(): {
    readonly error: {
      readonly code: ActionLifecycleErrorCode;
      readonly actionId: string | null;
      readonly state: string | null;
      readonly message: string;
    };
  } {
    return {
      error: {
        code: this.code,
        actionId: this.actionId,
        state: this.state,
        message: this.message,
      },
    };
  }
}
