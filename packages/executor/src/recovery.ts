import { ToolExecutionError, type IdempotencyHint } from "@driveguard/tools";

import type { Sleeper } from "./retry.js";
import { SystemSleeper } from "./retry.js";

export const RECOVERY_OPERATION_TYPES = ["READ", "WRITE"] as const;
export type RecoveryOperationType = (typeof RECOVERY_OPERATION_TYPES)[number];

export const RECOVERY_FAILURE_TYPES = [
  "TIMEOUT",
  "HTTP_503",
  "CONNECTION_ABORT",
  "DEFINITE_FAILURE",
  "AMBIGUOUS_SIDE_EFFECT",
  "DUPLICATE_REQUEST",
] as const;
export type RecoveryFailureType = (typeof RECOVERY_FAILURE_TYPES)[number];

export const RECONCILIATION_STATUSES = ["EXECUTED", "NOT_EXECUTED", "UNKNOWN"] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

export type RecoveryAction = "RETRY" | "RECONCILE" | "SAFE_DEGRADATION" | "STOP";
export type RecoveryStatus = "RECOVERED" | "SAFE_DEGRADATION" | "UNKNOWN";

export interface RecoveryDecisionInput {
  readonly operationType: RecoveryOperationType;
  readonly failureType: RecoveryFailureType;
  readonly idempotencyHint: IdempotencyHint;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly reconciliationStatus?: ReconciliationStatus;
}

export interface RecoveryDecision {
  readonly action: RecoveryAction;
  readonly reason:
    | "READ_TRANSIENT_RETRY"
    | "READ_RETRY_EXHAUSTED"
    | "WRITE_DEFINITE_SAFE_RETRY"
    | "WRITE_RETRY_NOT_SAFE"
    | "AMBIGUOUS_WRITE_REQUIRES_RECONCILIATION"
    | "RECONCILED_EXECUTED"
    | "RECONCILED_NOT_EXECUTED_RETRY"
    | "RECONCILIATION_UNKNOWN";
}

export interface RecoveryReceipt {
  readonly operationType: RecoveryOperationType;
  readonly failureType: RecoveryFailureType;
  readonly action: RecoveryAction;
  readonly status: RecoveryStatus;
  readonly attemptCount: number;
  readonly retryCount: number;
  readonly idempotencyKeyReused: boolean;
  readonly reconciliationStatus?: ReconciliationStatus;
}

export interface RecoveryReconciliationResult {
  readonly status: ReconciliationStatus;
  readonly result?: unknown;
}

export interface ExecutionReconciler {
  reconcile(input: {
    readonly toolName: string;
    readonly validatedArguments: unknown;
    readonly idempotencyKey: string;
  }): Promise<RecoveryReconciliationResult>;
}

export class RecoveryExhaustedError extends Error {
  readonly receipt: RecoveryReceipt;

  constructor(receipt: RecoveryReceipt) {
    super("Read recovery was exhausted safely");
    this.name = "RecoveryExhaustedError";
    this.receipt = receipt;
  }
}

export interface RecoveryManagerOptions {
  readonly maxReadAttempts?: number;
  readonly retryDelaysMs?: readonly number[];
  readonly sleeper?: Sleeper;
}

function positiveAttempts(value: number | undefined): number {
  const selected = value ?? 2;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 3) {
    throw new TypeError("Recovery maxReadAttempts must be an integer between 1 and 3");
  }
  return selected;
}

function delays(values: readonly number[] | undefined): readonly number[] {
  const selected = values ?? [50, 150];
  if (
    selected.length === 0 ||
    selected.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 5_000)
  ) {
    throw new TypeError("Recovery retry delays are invalid");
  }
  return Object.freeze([...selected]);
}

export function recoveryFailureType(error: unknown): RecoveryFailureType {
  if (typeof error === "object" && error !== null) {
    const explicit = Reflect.get(error, "failureType") as unknown;
    if (
      typeof explicit === "string" &&
      (RECOVERY_FAILURE_TYPES as readonly string[]).includes(explicit)
    ) {
      return explicit as RecoveryFailureType;
    }
  }
  if (error instanceof ToolExecutionError) {
    if (error.code === "DEPENDENCY_TIMEOUT") return "TIMEOUT";
    if (error.code === "DEPENDENCY_UNAVAILABLE") return "CONNECTION_ABORT";
  }
  return "DEFINITE_FAILURE";
}

export class RecoveryManager {
  readonly #maxReadAttempts: number;
  readonly #retryDelaysMs: readonly number[];
  readonly #sleeper: Sleeper;

  constructor(options: RecoveryManagerOptions = {}) {
    this.#maxReadAttempts = positiveAttempts(options.maxReadAttempts);
    this.#retryDelaysMs = delays(options.retryDelaysMs);
    this.#sleeper = options.sleeper ?? new SystemSleeper();
  }

  decide(input: RecoveryDecisionInput): RecoveryDecision {
    if (input.operationType === "READ") {
      const transient =
        input.failureType === "TIMEOUT" ||
        input.failureType === "HTTP_503" ||
        input.failureType === "CONNECTION_ABORT" ||
        input.failureType === "DUPLICATE_REQUEST";
      return transient && input.attempt < input.maxAttempts
        ? { action: "RETRY", reason: "READ_TRANSIENT_RETRY" }
        : { action: "SAFE_DEGRADATION", reason: "READ_RETRY_EXHAUSTED" };
    }

    if (
      input.failureType === "AMBIGUOUS_SIDE_EFFECT" ||
      input.failureType === "TIMEOUT" ||
      input.failureType === "CONNECTION_ABORT"
    ) {
      if (input.reconciliationStatus === undefined) {
        return {
          action: "RECONCILE",
          reason: "AMBIGUOUS_WRITE_REQUIRES_RECONCILIATION",
        };
      }
      if (input.reconciliationStatus === "EXECUTED") {
        return { action: "STOP", reason: "RECONCILED_EXECUTED" };
      }
      if (
        input.reconciliationStatus === "NOT_EXECUTED" &&
        input.idempotencyHint === "IDEMPOTENT" &&
        input.attempt < input.maxAttempts
      ) {
        return { action: "RETRY", reason: "RECONCILED_NOT_EXECUTED_RETRY" };
      }
      return { action: "STOP", reason: "RECONCILIATION_UNKNOWN" };
    }

    if (
      (input.failureType === "HTTP_503" || input.failureType === "DUPLICATE_REQUEST") &&
      input.idempotencyHint === "IDEMPOTENT" &&
      input.attempt < input.maxAttempts
    ) {
      return { action: "RETRY", reason: "WRITE_DEFINITE_SAFE_RETRY" };
    }
    return { action: "SAFE_DEGRADATION", reason: "WRITE_RETRY_NOT_SAFE" };
  }

  async executeRead<T>(operation: () => Promise<T>): Promise<T> {
    let lastFailure: RecoveryFailureType = "DEFINITE_FAILURE";
    for (let attempt = 1; attempt <= this.#maxReadAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastFailure = recoveryFailureType(error);
        const decision = this.decide({
          operationType: "READ",
          failureType: lastFailure,
          idempotencyHint: "READ_ONLY",
          attempt,
          maxAttempts: this.#maxReadAttempts,
        });
        if (decision.action !== "RETRY") {
          throw new RecoveryExhaustedError(
            Object.freeze({
              operationType: "READ",
              failureType: lastFailure,
              action: "SAFE_DEGRADATION",
              status: "SAFE_DEGRADATION",
              attemptCount: attempt,
              retryCount: Math.max(0, attempt - 1),
              idempotencyKeyReused: attempt > 1,
            }),
          );
        }
        await this.#sleeper.sleep(
          this.#retryDelaysMs[Math.min(attempt - 1, this.#retryDelaysMs.length - 1)] ?? 0,
        );
      }
    }
    throw new RecoveryExhaustedError(
      Object.freeze({
        operationType: "READ",
        failureType: lastFailure,
        action: "SAFE_DEGRADATION",
        status: "SAFE_DEGRADATION",
        attemptCount: this.#maxReadAttempts,
        retryCount: Math.max(0, this.#maxReadAttempts - 1),
        idempotencyKeyReused: this.#maxReadAttempts > 1,
      }),
    );
  }
}
