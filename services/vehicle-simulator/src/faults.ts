import { deterministicUnit, validateSeed } from "./determinism.js";
import { SimulatorError } from "./errors.js";
import {
  FAULT_MODES,
  FAULT_TARGETS,
  type FaultConfig,
  type FaultTarget,
  type TriggeredFault,
} from "./types.js";

const targets = new Set<string>(FAULT_TARGETS);
const modes = new Set<string>(FAULT_MODES);
const staleTargets = new Set<string>(["vehicle.get_state", "trip.get_state"]);

export function validateFaultConfig(input: FaultConfig): FaultConfig {
  if (!targets.has(input.target)) {
    throw new SimulatorError("VALIDATION_ERROR", "Fault target is not supported", 400);
  }
  if (!modes.has(input.mode)) {
    throw new SimulatorError("VALIDATION_ERROR", "Fault mode is not supported", 400);
  }
  if (!Number.isFinite(input.probability) || input.probability < 0 || input.probability > 1) {
    throw new SimulatorError("VALIDATION_ERROR", "Fault probability must be between 0 and 1", 400);
  }
  if (!Number.isSafeInteger(input.delayMs) || input.delayMs < 0 || input.delayMs > 30_000) {
    throw new SimulatorError(
      "VALIDATION_ERROR",
      "Fault delayMs must be an integer between 0 and 30000",
      400,
    );
  }
  if (input.mode === "stale_response" && !staleTargets.has(input.target)) {
    throw new SimulatorError(
      "VALIDATION_ERROR",
      "stale_response is only valid for vehicle and trip reads",
      400,
    );
  }
  return Object.freeze({ ...input });
}

export class FaultManager {
  #seed: number;
  readonly #configs = new Map<FaultTarget, FaultConfig>();
  readonly #counters = new Map<FaultTarget, number>();

  constructor(seed: number) {
    this.#seed = validateSeed(seed);
  }

  setSeed(seed: number): void {
    this.#seed = validateSeed(seed);
    this.clear();
  }

  set(config: FaultConfig): FaultConfig {
    const validated = validateFaultConfig(config);
    this.#configs.set(validated.target, validated);
    this.#counters.set(validated.target, 0);
    return validated;
  }

  list(): readonly FaultConfig[] {
    return [...this.#configs.values()].sort((left, right) =>
      left.target.localeCompare(right.target),
    );
  }

  clear(): void {
    this.#configs.clear();
    this.#counters.clear();
  }

  consume(target: FaultTarget): TriggeredFault | undefined {
    const config = this.#configs.get(target);
    if (config === undefined) return undefined;
    const sequence = (this.#counters.get(target) ?? 0) + 1;
    this.#counters.set(target, sequence);
    if (deterministicUnit(this.#seed, `fault:${target}`, sequence) >= config.probability) {
      return undefined;
    }
    return { ...config, triggered: true };
  }
}
