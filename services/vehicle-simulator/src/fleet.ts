import { SimulatorError } from "./errors.js";
import { VehicleSimulator } from "./simulator.js";

const vehicleIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface VehicleSimulatorFleetOptions {
  readonly defaultSimulator?: VehicleSimulator;
  readonly maxVehicles?: number;
  readonly createSimulator?: (vehicleId: string) => VehicleSimulator;
}

/**
 * Routes each trusted vehicle identity to isolated Simulator state. The fleet is
 * deliberately bounded and refuses new identities instead of evicting live state.
 */
export class VehicleSimulatorFleet {
  readonly #simulators = new Map<string, VehicleSimulator>();
  readonly #defaultVehicleId: string;
  readonly #maxVehicles: number;
  readonly #createSimulator: (vehicleId: string) => VehicleSimulator;

  constructor(options: VehicleSimulatorFleetOptions = {}) {
    const defaultSimulator = options.defaultSimulator ?? new VehicleSimulator();
    this.#defaultVehicleId = defaultSimulator.state().vehicle.vehicleId;
    const maxVehicles = options.maxVehicles ?? 1_000;
    if (!Number.isSafeInteger(maxVehicles) || maxVehicles < 1 || maxVehicles > 10_000) {
      throw new TypeError("maxVehicles must be an integer between 1 and 10000");
    }
    this.#maxVehicles = maxVehicles;
    this.#createSimulator =
      options.createSimulator ?? ((vehicleId) => new VehicleSimulator({ vehicleId }));
    this.#simulators.set(this.#defaultVehicleId, defaultSimulator);
  }

  get defaultVehicleId(): string {
    return this.#defaultVehicleId;
  }

  get size(): number {
    return this.#simulators.size;
  }

  resolve(value: unknown): { readonly vehicleId: string; readonly simulator: VehicleSimulator } {
    const vehicleId = value === undefined ? this.#defaultVehicleId : value;
    if (typeof vehicleId !== "string" || !vehicleIdPattern.test(vehicleId)) {
      throw new SimulatorError("VALIDATION_ERROR", "Vehicle identity header is invalid", 400);
    }
    const existing = this.#simulators.get(vehicleId);
    if (existing !== undefined) return { vehicleId, simulator: existing };
    if (this.#simulators.size >= this.#maxVehicles) {
      throw new SimulatorError("INTERNAL_ERROR", "Simulator vehicle capacity is unavailable", 503);
    }
    const simulator = this.#createSimulator(vehicleId);
    if (simulator.state().vehicle.vehicleId !== vehicleId) {
      throw new SimulatorError("INTERNAL_ERROR", "Simulator vehicle boundary failed safely", 500);
    }
    this.#simulators.set(vehicleId, simulator);
    return { vehicleId, simulator };
  }
}
