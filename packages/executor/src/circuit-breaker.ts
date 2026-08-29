import type { Clock } from "@driveguard/shared";

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

interface CircuitEntry {
  state: CircuitState;
  failures: number;
  openedAt: number;
  probeActive: boolean;
}

export type CircuitPermit =
  | { readonly allowed: false; readonly state: "OPEN" }
  | { readonly allowed: true; readonly state: "CLOSED" | "HALF_OPEN" };

export interface CircuitBreakerOptions {
  readonly clock: Clock;
  readonly failureThreshold?: number;
  readonly cooldownMs?: number;
}

export class CircuitBreaker {
  readonly #clock: Clock;
  readonly #failureThreshold: number;
  readonly #cooldownMs: number;
  readonly #circuits = new Map<string, CircuitEntry>();

  constructor(options: CircuitBreakerOptions) {
    this.#clock = options.clock;
    this.#failureThreshold = options.failureThreshold ?? 5;
    this.#cooldownMs = options.cooldownMs ?? 20_000;
    if (
      !Number.isSafeInteger(this.#failureThreshold) ||
      this.#failureThreshold < 1 ||
      !Number.isSafeInteger(this.#cooldownMs) ||
      this.#cooldownMs < 1
    ) {
      throw new TypeError("CircuitBreaker configuration is invalid");
    }
  }

  acquire(key: string): CircuitPermit {
    const entry = this.#entry(key);
    if (entry.state === "OPEN") {
      if (this.#clock.nowMs() - entry.openedAt < this.#cooldownMs) {
        return { allowed: false, state: "OPEN" };
      }
      entry.state = "HALF_OPEN";
      entry.probeActive = false;
    }
    if (entry.state === "HALF_OPEN") {
      if (entry.probeActive) return { allowed: false, state: "OPEN" };
      entry.probeActive = true;
      return { allowed: true, state: "HALF_OPEN" };
    }
    return { allowed: true, state: "CLOSED" };
  }

  succeeded(key: string): { readonly previous: CircuitState; readonly current: CircuitState } {
    const entry = this.#entry(key);
    const previous = entry.state;
    entry.state = "CLOSED";
    entry.failures = 0;
    entry.probeActive = false;
    return { previous, current: entry.state };
  }

  failed(key: string): { readonly previous: CircuitState; readonly current: CircuitState } {
    const entry = this.#entry(key);
    const previous = entry.state;
    entry.probeActive = false;
    if (entry.state === "HALF_OPEN") {
      entry.state = "OPEN";
      entry.openedAt = this.#clock.nowMs();
      return { previous, current: entry.state };
    }
    entry.failures += 1;
    if (entry.failures >= this.#failureThreshold) {
      entry.state = "OPEN";
      entry.openedAt = this.#clock.nowMs();
    }
    return { previous, current: entry.state };
  }

  state(key: string): CircuitState {
    return this.#entry(key).state;
  }

  #entry(key: string): CircuitEntry {
    let entry = this.#circuits.get(key);
    if (entry === undefined) {
      entry = { state: "CLOSED", failures: 0, openedAt: 0, probeActive: false };
      this.#circuits.set(key, entry);
    }
    return entry;
  }
}
