export type RequestAdmissionRejection = "QUEUE_FULL" | "QUEUE_TIMEOUT" | "SHUTTING_DOWN";

export interface RequestAdmissionSnapshot {
  readonly accepting: boolean;
  readonly active: number;
  readonly queued: number;
  readonly rejected: number;
}

export interface RequestAdmissionPermit {
  release(): void;
}

export type RequestAdmission =
  | { readonly admitted: true; readonly permit: RequestAdmissionPermit }
  | { readonly admitted: false; readonly reason: RequestAdmissionRejection };

export interface RequestAdmissionControllerOptions {
  readonly maxConcurrent?: number;
  readonly maxQueue?: number;
  readonly queueTimeoutMs?: number;
  readonly observer?: (snapshot: RequestAdmissionSnapshot) => void;
}

interface Waiter {
  readonly resolve: (result: RequestAdmission) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

function boundedPositive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) {
    throw new TypeError(`${name} must be an integer between 1 and 100000`);
  }
  return value;
}

/** Bounded FIFO admission for stateful API and Agent routes. */
export class RequestAdmissionController {
  readonly #maxConcurrent: number;
  readonly #maxQueue: number;
  readonly #queueTimeoutMs: number;
  readonly #observer: ((snapshot: RequestAdmissionSnapshot) => void) | undefined;
  readonly #queue: Waiter[] = [];
  #accepting = true;
  #active = 0;
  #rejected = 0;

  constructor(options: RequestAdmissionControllerOptions = {}) {
    this.#maxConcurrent = boundedPositive(options.maxConcurrent ?? 32, "maxConcurrent");
    this.#maxQueue = boundedPositive(options.maxQueue ?? 64, "maxQueue");
    this.#queueTimeoutMs = boundedPositive(options.queueTimeoutMs ?? 500, "queueTimeoutMs");
    this.#observer = options.observer;
    this.#notify();
  }

  snapshot(): RequestAdmissionSnapshot {
    return Object.freeze({
      accepting: this.#accepting,
      active: this.#active,
      queued: this.#queue.length,
      rejected: this.#rejected,
    });
  }

  acquire(): Promise<RequestAdmission> {
    if (!this.#accepting) return Promise.resolve(this.#reject("SHUTTING_DOWN"));
    if (this.#active < this.#maxConcurrent && this.#queue.length === 0) {
      return Promise.resolve({ admitted: true, permit: this.#permit() });
    }
    if (this.#queue.length >= this.#maxQueue) {
      return Promise.resolve(this.#reject("QUEUE_FULL"));
    }
    return new Promise<RequestAdmission>((resolve) => {
      const waiter: Waiter = { resolve, timer: undefined };
      waiter.timer = setTimeout(() => {
        const index = this.#queue.indexOf(waiter);
        if (index < 0) return;
        this.#queue.splice(index, 1);
        resolve(this.#reject("QUEUE_TIMEOUT"));
        this.#notify();
      }, this.#queueTimeoutMs);
      waiter.timer.unref?.();
      this.#queue.push(waiter);
      this.#notify();
    });
  }

  beginShutdown(): void {
    if (!this.#accepting) return;
    this.#accepting = false;
    for (const waiter of this.#queue.splice(0)) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.timer = undefined;
      waiter.resolve(this.#reject("SHUTTING_DOWN"));
    }
    this.#notify();
  }

  #permit(): RequestAdmissionPermit {
    this.#active += 1;
    this.#notify();
    let released = false;
    return Object.freeze({
      release: () => {
        if (released) return;
        released = true;
        this.#active = Math.max(0, this.#active - 1);
        this.#drain();
        this.#notify();
      },
    });
  }

  #drain(): void {
    while (this.#accepting && this.#active < this.#maxConcurrent && this.#queue.length > 0) {
      const waiter = this.#queue.shift();
      if (waiter === undefined) return;
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.timer = undefined;
      waiter.resolve({ admitted: true, permit: this.#permit() });
    }
  }

  #reject(reason: RequestAdmissionRejection): RequestAdmission {
    this.#rejected += 1;
    this.#notify();
    return { admitted: false, reason };
  }

  #notify(): void {
    try {
      this.#observer?.(this.snapshot());
    } catch {
      // Admission safety does not depend on observability.
    }
  }
}
