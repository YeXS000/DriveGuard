import { SimulatorError } from "./errors.js";

function mix32(value: number): number {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

function textHash(text: string): number {
  let hash = 2166136261;
  for (const character of text) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function validateSeed(seed: number): number {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new SimulatorError(
      "VALIDATION_ERROR",
      "seed must be an integer between 0 and 4294967295",
      400,
    );
  }
  return seed;
}

export function deterministicUnit(seed: number, namespace: string, sequence: number): number {
  const value = mix32(validateSeed(seed) ^ textHash(namespace) ^ mix32(sequence));
  return value / 0x1_0000_0000;
}

export class DeterministicIdAllocator {
  readonly #seed: number;
  readonly #counters = new Map<string, number>();

  constructor(seed: number) {
    this.#seed = validateSeed(seed);
  }

  next(namespace: "route" | "reservation" | "assistance"): string {
    const sequence = (this.#counters.get(namespace) ?? 0) + 1;
    this.#counters.set(namespace, sequence);
    return `${namespace}-${this.#seed.toString(16).padStart(8, "0")}-${sequence
      .toString()
      .padStart(6, "0")}`;
  }

  snapshot(): ReadonlyMap<string, number> {
    return new Map(this.#counters);
  }

  restore(snapshot: ReadonlyMap<string, number>): void {
    this.#counters.clear();
    for (const [namespace, sequence] of snapshot) {
      this.#counters.set(namespace, sequence);
    }
  }
}
