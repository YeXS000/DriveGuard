import { parseTripState, parseVehicleState, timestampToEpochMs } from "@driveguard/domain";

import { validateSeed } from "./determinism.js";
import { SimulatorError } from "./errors.js";
import { SCENARIO_IDS, type SimulatorState } from "./types.js";

export function cloneState(state: SimulatorState): SimulatorState {
  return structuredClone(state);
}

function freezeDeep<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) freezeDeep(Reflect.get(value, key));
  return Object.freeze(value);
}

function validationError(message: string): never {
  throw new SimulatorError("VALIDATION_ERROR", message, 400);
}

function assertExactObject(value: unknown, expectedKeys: readonly string[], label: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    validationError(`${label} must be an object`);
  }
  const actualKeys = Reflect.ownKeys(value);
  if (
    actualKeys.some((key) => typeof key !== "string") ||
    actualKeys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    validationError(`${label} contains unsupported fields`);
  }
}

function assertDenseArray(value: unknown, label: string): void {
  if (!Array.isArray(value)) validationError(`${label} must be an array`);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) validationError(`${label} must not contain sparse entries`);
  }
  if (
    Reflect.ownKeys(value).some(
      (key) =>
        key !== "length" &&
        (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length),
    )
  ) {
    validationError(`${label} contains unsupported fields`);
  }
}

export function validateSimulatorState(state: SimulatorState, nowMs: number): SimulatorState {
  try {
    assertExactObject(
      state,
      [
        "vehicle",
        "trip",
        "cabin",
        "charging",
        "assistance",
        "scenario",
        "seed",
        "simulationVersion",
        "updatedAt",
      ],
      "Simulator state",
    );
    assertExactObject(state.cabin, ["seatHeating", "mediaVolume"], "Cabin state");
    assertExactObject(state.cabin.seatHeating, ["driver", "front_passenger"], "Seat-heating state");
    assertExactObject(state.charging, ["stations", "reservations"], "Charging state");
    assertDenseArray(state.charging.stations, "Charging stations");
    for (const station of state.charging.stations) {
      assertExactObject(
        station,
        ["id", "name", "latitude", "longitude", "availableSlots", "maxPowerKw"],
        "Charging station",
      );
    }
    assertDenseArray(state.charging.reservations, "Charging reservations");
    for (const reservation of state.charging.reservations) {
      assertExactObject(
        reservation,
        ["id", "stationId", "createdAt", "status"],
        "Charging reservation",
      );
    }
    assertExactObject(state.assistance, ["requests"], "Assistance state");
    assertDenseArray(state.assistance.requests, "Assistance requests");
    for (const request of state.assistance.requests) {
      assertExactObject(request, ["id", "reason", "createdAt", "status"], "Assistance request");
    }
    const vehicle = parseVehicleState(state.vehicle, { nowMs });
    const trip = parseTripState(state.trip, { nowMs });
    if (!Number.isSafeInteger(state.simulationVersion) || state.simulationVersion < 1) {
      throw new SimulatorError(
        "VALIDATION_ERROR",
        "simulationVersion must be a positive safe integer",
        400,
      );
    }
    validateSeed(state.seed);
    if (!SCENARIO_IDS.includes(state.scenario)) {
      throw new SimulatorError("SCENARIO_NOT_FOUND", "Simulator state scenario is unknown", 404);
    }
    if (timestampToEpochMs(state.updatedAt, "updatedAt") > nowMs) {
      throw new SimulatorError("VALIDATION_ERROR", "updatedAt cannot be in the future", 400);
    }
    if (
      typeof state.cabin.mediaVolume !== "number" ||
      !Number.isFinite(state.cabin.mediaVolume) ||
      state.cabin.mediaVolume < 0 ||
      state.cabin.mediaVolume > 100
    ) {
      throw new SimulatorError("VALIDATION_ERROR", "mediaVolume must be between 0 and 100", 400);
    }
    const seatKeys = Object.keys(state.cabin.seatHeating).sort();
    if (
      seatKeys.length !== 2 ||
      seatKeys[0] !== "driver" ||
      seatKeys[1] !== "front_passenger" ||
      Object.values(state.cabin.seatHeating).some(
        (level) => !Number.isInteger(level) || level < 0 || level > 3,
      )
    ) {
      throw new SimulatorError("VALIDATION_ERROR", "Seat-heating level is invalid", 400);
    }
    const stationIds = state.charging.stations.map((station) => station.id);
    if (
      new Set(stationIds).size !== stationIds.length ||
      state.charging.stations.some(
        (station) =>
          typeof station.id !== "string" ||
          station.id.length === 0 ||
          typeof station.name !== "string" ||
          station.name.trim().length === 0 ||
          !Number.isFinite(station.latitude) ||
          station.latitude < -90 ||
          station.latitude > 90 ||
          !Number.isFinite(station.longitude) ||
          station.longitude < -180 ||
          station.longitude > 180 ||
          !Number.isSafeInteger(station.availableSlots) ||
          station.availableSlots < 0 ||
          !Number.isFinite(station.maxPowerKw) ||
          station.maxPowerKw <= 0,
      )
    ) {
      throw new SimulatorError("VALIDATION_ERROR", "Charging station state is invalid", 400);
    }
    const reservationIds = state.charging.reservations.map((reservation) => reservation.id);
    if (new Set(reservationIds).size !== reservationIds.length) {
      throw new SimulatorError("INVALID_TRANSITION", "Reservation IDs must be unique", 409);
    }
    if (
      state.charging.reservations.some(
        (reservation) =>
          typeof reservation.id !== "string" ||
          reservation.id.length === 0 ||
          typeof reservation.stationId !== "string" ||
          reservation.status !== "active" ||
          !stationIds.includes(reservation.stationId) ||
          timestampToEpochMs(reservation.createdAt, "reservation.createdAt") > nowMs,
      )
    ) {
      throw new SimulatorError("VALIDATION_ERROR", "Charging reservation state is invalid", 400);
    }
    const assistanceIds = state.assistance.requests.map((request) => request.id);
    if (new Set(assistanceIds).size !== assistanceIds.length) {
      throw new SimulatorError("INVALID_TRANSITION", "Assistance request IDs must be unique", 409);
    }
    if (
      state.assistance.requests.some(
        (request) =>
          typeof request.id !== "string" ||
          request.id.length === 0 ||
          typeof request.reason !== "string" ||
          request.reason.trim().length === 0 ||
          request.reason.length > 512 ||
          request.status !== "requested" ||
          timestampToEpochMs(request.createdAt, "assistance.createdAt") > nowMs,
      )
    ) {
      throw new SimulatorError("VALIDATION_ERROR", "Assistance request state is invalid", 400);
    }
    return freezeDeep({ ...structuredClone(state), vehicle, trip });
  } catch (error) {
    if (error instanceof SimulatorError) throw error;
    throw new SimulatorError("VALIDATION_ERROR", "Simulator state failed validation", 400);
  }
}
