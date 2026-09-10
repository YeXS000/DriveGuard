import { DomainValidationError, toUtcTimestamp, type VehicleId } from "@driveguard/domain";
import { SystemClock, type Clock } from "@driveguard/shared";

import { DeterministicIdAllocator, deterministicUnit } from "./determinism.js";
import { SimulatorError } from "./errors.js";
import { FaultManager } from "./faults.js";
import { ScenarioRegistry } from "./scenarios.js";
import { cloneState, validateSimulatorState } from "./state.js";
import {
  cancelReservation,
  createReservation,
  requestRoadsideAssistance,
  reroute,
  setCabinTemperature,
  setMediaVolume,
  setNavigationDestination,
  setSeatHeating,
  setSoc,
  setVehicleSpeed,
} from "./transitions.js";
import type {
  FaultConfig,
  FaultTarget,
  ScenarioId,
  SimulatorState,
  TriggeredFault,
} from "./types.js";

const HISTORY_LIMIT = 10;

export interface VehicleSimulatorOptions {
  readonly clock?: Clock;
  readonly scenario?: ScenarioId;
  readonly seed?: number;
  readonly vehicleId?: string;
}

export class VehicleSimulator {
  readonly clock: Clock;
  readonly scenarios: ScenarioRegistry;
  readonly faults: FaultManager;
  readonly #vehicleId: string;
  #state: SimulatorState;
  #history: SimulatorState[];
  #ids: DeterministicIdAllocator;
  #mutationTail: Promise<void> = Promise.resolve();
  #resetEpoch = 0;

  constructor(options: VehicleSimulatorOptions = {}) {
    this.clock = options.clock ?? new SystemClock();
    this.scenarios = new ScenarioRegistry(this.clock);
    const scenario = options.scenario ?? "city_idle";
    const seed = options.seed ?? 1;
    const initial = this.scenarios.load(scenario, seed);
    const vehicleId = options.vehicleId ?? initial.vehicle.vehicleId;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(vehicleId)) {
      throw new SimulatorError("VALIDATION_ERROR", "Vehicle identity is invalid", 400);
    }
    this.#vehicleId = vehicleId;
    this.#state = this.#bindVehicle(initial);
    this.#history = [this.#state];
    this.#ids = new DeterministicIdAllocator(seed);
    this.faults = new FaultManager(seed);
  }

  state(): SimulatorState {
    return cloneState(this.#state);
  }

  historySize(): number {
    return this.#history.length;
  }

  vehicleState(stale = false): SimulatorState["vehicle"] {
    if (!stale) return structuredClone(this.#state.vehicle);
    const historical = this.#history.findLast(
      (candidate) => candidate.vehicle.version < this.#state.vehicle.version,
    );
    return structuredClone((historical ?? this.#state).vehicle);
  }

  tripState(stale = false): SimulatorState["trip"] {
    if (!stale) return structuredClone(this.#state.trip);
    const historical = this.#history.findLast(
      (candidate) => candidate.trip.version < this.#state.trip.version,
    );
    return structuredClone((historical ?? this.#state).trip);
  }

  chargingStations(): SimulatorState["charging"]["stations"] {
    return structuredClone(this.#state.charging.stations);
  }

  chargingStatus(): {
    readonly chargingState: SimulatorState["vehicle"]["chargingState"];
    readonly reservations: SimulatorState["charging"]["reservations"];
  } {
    return {
      chargingState: this.#state.vehicle.chargingState,
      reservations: structuredClone(this.#state.charging.reservations),
    };
  }

  isReady(): boolean {
    try {
      this.scenarios.get(this.#state.scenario);
      validateSimulatorState(this.#state, this.clock.nowMs());
      return true;
    } catch {
      return false;
    }
  }

  consumeFault(target: FaultTarget): TriggeredFault | undefined {
    return this.faults.consume(target);
  }

  resetEpoch(): number {
    return this.#resetEpoch;
  }

  configureFault(config: FaultConfig): FaultConfig {
    return this.faults.set(config);
  }

  listFaults(): readonly FaultConfig[] {
    return this.faults.list();
  }

  clearFaults(): void {
    this.faults.clear();
  }

  async reset(scenario: string, seed: number): Promise<SimulatorState> {
    return this.#serialize(() => {
      const next = this.#bindVehicle(this.scenarios.load(scenario, seed));
      this.#resetEpoch += 1;
      this.#state = next;
      this.#history = [next];
      this.#ids = new DeterministicIdAllocator(seed);
      this.faults.setSeed(seed);
      return this.state();
    });
  }

  #bindVehicle(state: SimulatorState): SimulatorState {
    if (state.vehicle.vehicleId === this.#vehicleId) return state;
    return validateSimulatorState(
      { ...state, vehicle: { ...state.vehicle, vehicleId: this.#vehicleId as VehicleId } },
      this.clock.nowMs(),
    );
  }

  async setVehicleSpeed(speedKph: number, resetEpoch?: number): Promise<SimulatorState> {
    return this.#transition((state, nowMs) => setVehicleSpeed(state, speedKph, nowMs), resetEpoch);
  }

  async setSoc(soc: number, resetEpoch?: number): Promise<SimulatorState> {
    return this.#transition((state, nowMs) => setSoc(state, soc, nowMs), resetEpoch);
  }

  async setCabinTemperature(temperatureC: number, resetEpoch?: number): Promise<SimulatorState> {
    return this.#transition(
      (state, nowMs) => setCabinTemperature(state, temperatureC, nowMs),
      resetEpoch,
    );
  }

  async setSeatHeating(
    seat: "driver" | "front_passenger",
    level: 0 | 1 | 2 | 3,
    resetEpoch?: number,
  ): Promise<SimulatorState> {
    return this.#transition(
      (state, nowMs) => setSeatHeating(state, seat, level, nowMs),
      resetEpoch,
    );
  }

  async setMediaVolume(volume: number, resetEpoch?: number): Promise<SimulatorState> {
    return this.#transition((state, nowMs) => setMediaVolume(state, volume, nowMs), resetEpoch);
  }

  async setDestination(destination: string, resetEpoch?: number): Promise<SimulatorState> {
    if (
      typeof destination !== "string" ||
      destination.trim().length === 0 ||
      destination.length > 512
    ) {
      throw new SimulatorError(
        "VALIDATION_ERROR",
        "Navigation destination must be a non-empty string",
        400,
      );
    }
    return this.#transition((state, nowMs) => {
      const routeId = this.#ids.next("route");
      const distanceKm = Math.round((8 + deterministicUnit(state.seed, routeId, 1) * 92) * 10) / 10;
      return setNavigationDestination(state, destination, routeId, distanceKm, nowMs);
    }, resetEpoch);
  }

  async reroute(resetEpoch?: number): Promise<SimulatorState> {
    return this.#transition(
      (state, nowMs) => reroute(state, () => this.#ids.next("route"), nowMs),
      resetEpoch,
    );
  }

  async createReservation(stationId: string, resetEpoch?: number): Promise<SimulatorState> {
    return this.#transition(
      (state, nowMs) =>
        createReservation(state, stationId, () => this.#ids.next("reservation"), nowMs),
      resetEpoch,
    );
  }

  async cancelReservation(reservationId: string, resetEpoch?: number): Promise<SimulatorState> {
    return this.#transition(
      (state, nowMs) => cancelReservation(state, reservationId, nowMs),
      resetEpoch,
    );
  }

  async requestRoadsideAssistance(reason: string, resetEpoch?: number): Promise<SimulatorState> {
    if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > 512) {
      throw new SimulatorError(
        "VALIDATION_ERROR",
        "Roadside assistance reason must be a non-empty string",
        400,
      );
    }
    return this.#transition(
      (state, nowMs) =>
        requestRoadsideAssistance(
          state,
          {
            id: this.#ids.next("assistance"),
            reason,
            createdAt: toUtcTimestamp(nowMs),
            status: "requested",
          },
          nowMs,
        ),
      resetEpoch,
    );
  }

  async #transition(
    construct: (current: SimulatorState, nowMs: number) => SimulatorState,
    expectedResetEpoch?: number,
  ): Promise<SimulatorState> {
    return this.#serialize(() => {
      if (expectedResetEpoch !== undefined && expectedResetEpoch !== this.#resetEpoch) {
        throw new SimulatorError(
          "INVALID_TRANSITION",
          "Mutation was invalidated by simulator reset",
          409,
        );
      }
      const nowMs = this.clock.nowMs();
      const idSnapshot = this.#ids.snapshot();
      try {
        const candidate = construct(this.#state, nowMs);
        const next = validateSimulatorState(candidate, nowMs);
        this.#state = next;
        this.#history.push(next);
        if (this.#history.length > HISTORY_LIMIT) this.#history.shift();
        return this.state();
      } catch (error) {
        this.#ids.restore(idSnapshot);
        if (error instanceof SimulatorError) throw error;
        if (error instanceof DomainValidationError) {
          throw new SimulatorError("VALIDATION_ERROR", "Transition failed validation", 400);
        }
        throw error;
      }
    });
  }

  async #serialize<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.#mutationTail;
    let release!: () => void;
    this.#mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
