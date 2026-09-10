export interface Clock {
  nowMs(): number;
}

export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }
}

export class FixedClock implements Clock {
  readonly #valueMs: number;

  constructor(valueMs: number) {
    this.#valueMs = valueMs;
  }

  nowMs(): number {
    return this.#valueMs;
  }
}
