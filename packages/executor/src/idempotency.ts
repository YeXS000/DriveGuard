import type { ExecutionResult } from "./types.js";

interface IdempotencyEntry {
  readonly fingerprint: string;
  readonly requestBinding: string;
  readonly promise: Promise<ExecutionResult>;
  readonly resolve: (result: ExecutionResult) => void;
}

export type IdempotencyAcquisition =
  | {
      readonly kind: "OWNER";
      complete(result: ExecutionResult): void;
    }
  | { readonly kind: "DUPLICATE"; readonly result: Promise<ExecutionResult> }
  | { readonly kind: "CONFLICT" };

export class IdempotencyManager {
  readonly #entries = new Map<string, IdempotencyEntry>();

  get size(): number {
    return this.#entries.size;
  }

  acquire(key: string, fingerprint: string, requestBinding: string): IdempotencyAcquisition {
    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      return existing.fingerprint === fingerprint && existing.requestBinding === requestBinding
        ? { kind: "DUPLICATE", result: existing.promise }
        : { kind: "CONFLICT" };
    }
    let resolve: (result: ExecutionResult) => void = () => undefined;
    const promise = new Promise<ExecutionResult>((settle) => {
      resolve = settle;
    });
    this.#entries.set(key, { fingerprint, requestBinding, promise, resolve });
    let completed = false;
    return {
      kind: "OWNER",
      complete: (result) => {
        if (completed) return;
        completed = true;
        resolve(result);
      },
    };
  }

  /**
   * Release process-local replay state only after a durable coordinator has
   * committed the authoritative result. The binding check prevents an older
   * request from deleting a newer owner that happens to reuse the same key.
   */
  release(key: string, fingerprint: string, requestBinding: string): boolean {
    const current = this.#entries.get(key);
    if (
      current === undefined ||
      current.fingerprint !== fingerprint ||
      current.requestBinding !== requestBinding
    ) {
      return false;
    }
    return this.#entries.delete(key);
  }
}
