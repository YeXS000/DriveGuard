import { parseTripState, parseVehicleState, toUtcTimestamp } from "@driveguard/domain";
import type { Clock } from "@driveguard/shared";

import { SimulatorError } from "./errors.js";
import { validateSeed } from "./determinism.js";
import { validateSimulatorState } from "./state.js";
import { SCENARIO_IDS, type ScenarioId, type SimulatorState } from "./types.js";

const STATIONS = [
  {
    id: "station-pudong-001",
    name: "Pudong Fast Charge",
    latitude: 31.2304,
    longitude: 121.4737,
    availableSlots: 2,
    maxPowerKw: 180,
  },
  {
    id: "station-hongqiao-002",
    name: "Hongqiao Charging Hub",
    latitude: 31.1967,
    longitude: 121.327,
    availableSlots: 1,
    maxPowerKw: 120,
  },
  {
    id: "station-empty-003",
    name: "Capacity Test Station",
    latitude: 31.21,
    longitude: 121.41,
    availableSlots: 0,
    maxPowerKw: 60,
  },
] as const;

function rawVehicle(now: string) {
  return {
    vehicleId: "simulator-vehicle-001",
    timestamp: now,
    version: 1,
    speedKph: 0,
    gear: "P",
    driveMode: "parked",
    soc: 72,
    chargingState: "not_charging",
    estimatedRangeKm: 360,
    latitude: 31.2304,
    longitude: 121.4737,
    doors: {
      frontLeft: "locked",
      frontRight: "locked",
      rearLeft: "locked",
      rearRight: "locked",
      trunk: "locked",
    },
    windows: {
      frontLeft: "closed",
      frontRight: "closed",
      rearLeft: "closed",
      rearRight: "closed",
    },
    cabinTemperature: 22,
    outsideTemperature: 28,
    occupants: [
      { seat: "driver", presence: "occupied" },
      { seat: "front_passenger", presence: "vacant" },
    ],
  };
}

function inactiveTrip(now: string) {
  return {
    timestamp: now,
    version: 1,
    destination: null,
    routeId: null,
    remainingDistanceKm: 0,
    etaMinutes: 0,
    navigationActive: false,
  };
}

function scenarioParts(scenario: ScenarioId, now: string): { vehicle: unknown; trip: unknown } {
  const vehicle = rawVehicle(now);
  const trip = inactiveTrip(now);
  switch (scenario) {
    case "city_idle":
      return { vehicle, trip };
    case "highway_driving":
      return {
        vehicle: { ...vehicle, speedKph: 100, gear: "D", driveMode: "driving", soc: 58 },
        trip: {
          ...trip,
          destination: "Suzhou Industrial Park",
          routeId: "route-highway-initial",
          remainingDistanceKm: 76,
          etaMinutes: 52,
          navigationActive: true,
        },
      };
    case "low_soc":
      return { vehicle: { ...vehicle, soc: 8, estimatedRangeKm: 34 }, trip };
    case "charging":
      return {
        vehicle: {
          ...vehicle,
          driveMode: "charging",
          chargingState: "charging",
          soc: 45,
          estimatedRangeKm: 220,
        },
        trip,
      };
    case "active_navigation":
      return {
        vehicle,
        trip: {
          ...trip,
          destination: "Shanghai Science Museum",
          routeId: "route-city-initial",
          remainingDistanceKm: 18.4,
          etaMinutes: 29,
          navigationActive: true,
        },
      };
    case "parked_no_navigation":
      return { vehicle, trip };
    case "network_failure_ready":
      return { vehicle: { ...vehicle, soc: 24, estimatedRangeKm: 108 }, trip };
  }
}

export class ScenarioRegistry {
  readonly #clock: Clock;
  readonly #ids = new Set<string>(SCENARIO_IDS);

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  list(): readonly ScenarioId[] {
    return [...SCENARIO_IDS];
  }

  get(candidate: string): ScenarioId {
    if (!this.#ids.has(candidate)) {
      throw new SimulatorError("SCENARIO_NOT_FOUND", "Requested scenario does not exist", 404);
    }
    return candidate as ScenarioId;
  }

  load(candidate: string, seed: number): SimulatorState {
    const scenario = this.get(candidate);
    const validatedSeed = validateSeed(seed);
    const nowMs = this.#clock.nowMs();
    const now = toUtcTimestamp(nowMs);
    const parts = scenarioParts(scenario, now);
    const state: SimulatorState = {
      vehicle: parseVehicleState(parts.vehicle, { nowMs }),
      trip: parseTripState(parts.trip, { nowMs }),
      cabin: {
        seatHeating: { driver: 0, front_passenger: 0 },
        mediaVolume: 35,
      },
      charging: { stations: structuredClone(STATIONS), reservations: [] },
      assistance: { requests: [] },
      scenario,
      seed: validatedSeed,
      simulationVersion: 1,
      updatedAt: now,
    };
    return validateSimulatorState(state, nowMs);
  }
}
