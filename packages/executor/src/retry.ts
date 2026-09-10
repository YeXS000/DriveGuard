import type { ExecutionErrorClassification } from "./types.js";

export interface Sleeper {
  sleep(delayMs: number): Promise<void>;
}

export class SystemSleeper implements Sleeper {
  sleep(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

export interface RetryPolicyOptions {
  readonly maxAttempts?: number;
  readonly backoffMs?: readonly number[];
}

export class RetryPolicy {
  readonly maxAttempts: number;
  readonly #backoffMs: readonly number[];

  constructor(options: RetryPolicyOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.#backoffMs = Object.freeze([...(options.backoffMs ?? [50, 100])]);
    if (
      !Number.isSafeInteger(this.maxAttempts) ||
      this.maxAttempts < 1 ||
      this.maxAttempts > 10 ||
      this.#backoffMs.some((value) => !Number.isSafeInteger(value) || value < 0)
    ) {
      throw new TypeError("RetryPolicy configuration is invalid");
    }
  }

  shouldRetry(classification: ExecutionErrorClassification, attempt: number): boolean {
    return classification === "RETRYABLE" && attempt < this.maxAttempts;
  }

  delayForRetry(completedAttempt: number): number {
    return this.#backoffMs[Math.min(completedAttempt - 1, this.#backoffMs.length - 1)] ?? 0;
  }
}
