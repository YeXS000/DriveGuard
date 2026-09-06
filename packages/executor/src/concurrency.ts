export type ExecutionAdmissionRejection = "QUEUE_FULL" | "QUEUE_TIMEOUT";

export interface ExecutionConcurrencySnapshot {
  readonly readActive: number;
  readonly writeActive: number;
  readonly activeVehicles: number;
  readonly queued: number;
  readonly rejected: number;
}

export interface ExecutionConcurrencyPermit {
  release(): void;
}

export type ExecutionAdmission =
  | { readonly admitted: true; readonly permit: ExecutionConcurrencyPermit }
  | { readonly admitted: false; readonly reason: ExecutionAdmissionRejection };

export interface ExecutionConcurrencyControllerOptions {
  readonly maxReadConcurrency?: number;
  readonly maxWriteConcurrency?: number;
  readonly maxQueue?: number;
  readonly queueTimeoutMs?: number;
  readonly observer?: (snapshot: ExecutionConcurrencySnapshot) => void;
}

interface Waiter {
  readonly sideEffect: boolean;
  readonly vehicleId: string;
  readonly resolve: (result: ExecutionAdmission) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

/**
 * Process-wide bounded execution admission. Reads are capped independently;
 * side effects are capped globally and serialized per vehicle.
 */
export class ExecutionConcurrencyController {
  readonly #maxReadConcurrency: number;
  readonly #maxWriteConcurrency: number;
  readonly #maxQueue: number;
  readonly #queueTimeoutMs: number;
  readonly #observer: ((snapshot: ExecutionConcurrencySnapshot) => void) | undefined;
  readonly #activeVehicles = new Set<string>();
  readonly #queue: Waiter[] = [];
  #readActive = 0;
  #writeActive = 0;
  #rejected = 0;

  constructor(options: ExecutionConcurrencyControllerOptions = {}) {
    this.#maxReadConcurrency = positiveInteger(
      options.maxReadConcurrency ?? 4,
      "maxReadConcurrency",
    );
    this.#maxWriteConcurrency = positiveInteger(
      options.maxWriteConcurrency ?? 8,
      "maxWriteConcurrency",
    );
    this.#maxQueue = positiveInteger(options.maxQueue ?? 4_096, "maxQueue");
    this.#queueTimeoutMs = positiveInteger(options.queueTimeoutMs ?? 30_000, "queueTimeoutMs");
    this.#observer = options.observer;
    this.#notify();
  }

  snapshot(): ExecutionConcurrencySnapshot {
    return Object.freeze({
      readActive: this.#readActive,
      writeActive: this.#writeActive,
      activeVehicles: this.#activeVehicles.size,
      queued: this.#queue.length,
      rejected: this.#rejected,
    });
  }

  acquire(input: {
    readonly sideEffect: boolean;
    readonly vehicleId: string;
  }): Promise<ExecutionAdmission> {
    if (this.#queue.length === 0 && this.#canStart(input.sideEffect, input.vehicleId)) {
      return Promise.resolve({
        admitted: true,
        permit: this.#start(input.sideEffect, input.vehicleId),
      });
    }
    if (this.#queue.length >= this.#maxQueue) {
      this.#rejected += 1;
      this.#notify();
      return Promise.resolve({ admitted: false, reason: "QUEUE_FULL" });
    }
    return new Promise<ExecutionAdmission>((resolve) => {
      const waiter: Waiter = {
        sideEffect: input.sideEffect,
        vehicleId: input.vehicleId,
        resolve,
        timer: undefined,
      };
      waiter.timer = setTimeout(() => {
        const index = this.#queue.indexOf(waiter);
        if (index < 0) return;
        this.#queue.splice(index, 1);
        this.#rejected += 1;
        resolve({ admitted: false, reason: "QUEUE_TIMEOUT" });
        this.#notify();
        this.#drain();
      }, this.#queueTimeoutMs);
      waiter.timer.unref?.();
      this.#queue.push(waiter);
      this.#notify();
      this.#drain();
    });
  }

  #canStart(sideEffect: boolean, vehicleId: string): boolean {
    return sideEffect
      ? this.#writeActive < this.#maxWriteConcurrency && !this.#activeVehicles.has(vehicleId)
      : this.#readActive < this.#maxReadConcurrency;
  }

  #start(sideEffect: boolean, vehicleId: string): ExecutionConcurrencyPermit {
    if (sideEffect) {
      this.#writeActive += 1;
      this.#activeVehicles.add(vehicleId);
    } else {
      this.#readActive += 1;
    }
    this.#notify();
    let released = false;
    return Object.freeze({
      release: () => {
        if (released) return;
        released = true;
        if (sideEffect) {
          this.#writeActive = Math.max(0, this.#writeActive - 1);
          this.#activeVehicles.delete(vehicleId);
        } else {
          this.#readActive = Math.max(0, this.#readActive - 1);
        }
        this.#notify();
        this.#drain();
      },
    });
  }

  #drain(): void {
    while (true) {
      const index = this.#queue.findIndex((waiter) =>
        this.#canStart(waiter.sideEffect, waiter.vehicleId),
      );
      if (index < 0) return;
      const waiter = this.#queue.splice(index, 1)[0];
      if (waiter === undefined) return;
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.timer = undefined;
      waiter.resolve({
        admitted: true,
        permit: this.#start(waiter.sideEffect, waiter.vehicleId),
      });
    }
  }

  #notify(): void {
    try {
      this.#observer?.(this.snapshot());
    } catch {
      // Capacity observation must not affect execution admission or safety.
    }
  }
}
