export const DOMAIN_ERROR_CODES = [
  "INVALID_FIELD",
  "OUT_OF_RANGE",
  "INVALID_ENUM",
  "INVARIANT_VIOLATION",
  "STALE_CONTEXT",
  "INVALID_TIMESTAMP",
  "VERSION_CONFLICT",
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export interface DomainIssue {
  readonly code: DomainErrorCode;
  readonly path: string;
  readonly message: string;
  readonly invariant?: string;
}

export class DomainValidationError extends Error {
  readonly code: DomainErrorCode;
  readonly issues: readonly DomainIssue[];

  constructor(issues: readonly DomainIssue[]) {
    const first = issues[0] ?? {
      code: "INVALID_FIELD" as const,
      path: "$",
      message: "Domain validation failed",
    };
    super(first.message);
    this.name = "DomainValidationError";
    this.code = first.code;
    this.issues = Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
  }

  toJSON(): { code: DomainErrorCode; issues: readonly DomainIssue[] } {
    return { code: this.code, issues: this.issues };
  }
}
