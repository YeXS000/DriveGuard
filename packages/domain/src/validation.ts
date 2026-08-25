import Schema from "typebox/schema";
import type { TLocalizedValidationError } from "typebox/error";
import type { Static, TSchema } from "typebox";

import { DomainValidationError, type DomainErrorCode } from "./errors.js";
import type { UtcTimestamp } from "./identifiers.js";
import {
  DrivingContextSchema,
  TripStateSchema,
  VehicleStateSchema,
  type DrivingContext,
  type TripState,
  type VehicleState,
} from "./schemas.js";
import { UtcTimestampSchema } from "./identifiers.js";

export const VEHICLE_INVARIANTS = Object.freeze({
  parkedGearRequiresZeroSpeed: "VEHICLE_PARKED_GEAR_REQUIRES_ZERO_SPEED",
  parkedModeRequiresZeroSpeed: "VEHICLE_PARKED_MODE_REQUIRES_ZERO_SPEED",
  chargingRequiresStationary: "VEHICLE_CHARGING_REQUIRES_STATIONARY",
  chargingModeRequiresZeroSpeed: "VEHICLE_CHARGING_MODE_REQUIRES_ZERO_SPEED",
  chargingModeRequiresChargingState: "VEHICLE_CHARGING_MODE_REQUIRES_CHARGING_STATE",
  occupantSeatsUnique: "VEHICLE_OCCUPANT_SEATS_UNIQUE",
  vehicleIdentityImmutable: "VEHICLE_IDENTITY_IMMUTABLE",
});

export const TRIP_INVARIANTS = Object.freeze({
  activeNavigationRequiresDestination: "TRIP_ACTIVE_NAVIGATION_REQUIRES_DESTINATION",
  activeNavigationRequiresRouteId: "TRIP_ACTIVE_NAVIGATION_REQUIRES_ROUTE_ID",
  inactiveNavigationClearsDestination: "TRIP_INACTIVE_NAVIGATION_CLEARS_DESTINATION",
  inactiveNavigationClearsRouteId: "TRIP_INACTIVE_NAVIGATION_CLEARS_ROUTE_ID",
});

const vehicleValidator = Schema.Compile(VehicleStateSchema);
const tripValidator = Schema.Compile(TripStateSchema);
const drivingContextValidator = Schema.Compile(DrivingContextSchema);
const utcTimestampValidator = Schema.Compile(UtcTimestampSchema);

export interface DomainValidationOptions {
  readonly nowMs?: number;
}

function freezeDeep<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    freezeDeep(Reflect.get(value, key));
  }
  Object.freeze(value);
  return value;
}

function cloneInput(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    throw new DomainValidationError([
      { code: "INVALID_FIELD", path: "$", message: "Domain input must be cloneable data" },
    ]);
  }
}

function valueAtInstancePath(input: unknown, instancePath: string): unknown {
  let value = input;
  for (const segment of instancePath.split("/").filter((candidate) => candidate.length > 0)) {
    if (typeof value !== "object" || value === null) return undefined;
    value = Reflect.get(value, segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  }
  return value;
}

function schemaErrorCode(error: TLocalizedValidationError, input: unknown): DomainErrorCode {
  if (error.instancePath.endsWith("/timestamp") || error.instancePath.endsWith("/capturedAt")) {
    return "INVALID_TIMESTAMP";
  }
  if (
    error.keyword === "type" &&
    (error.instancePath.endsWith("/version") || error.instancePath.endsWith("/contextVersion"))
  ) {
    return typeof valueAtInstancePath(input, error.instancePath) === "number"
      ? "OUT_OF_RANGE"
      : "INVALID_FIELD";
  }
  if (error.keyword === "enum") return "INVALID_ENUM";
  if (
    error.keyword === "minimum" ||
    error.keyword === "maximum" ||
    error.keyword === "exclusiveMinimum" ||
    error.keyword === "exclusiveMaximum" ||
    error.keyword === "minItems" ||
    error.keyword === "maxItems"
  ) {
    return "OUT_OF_RANGE";
  }
  return "INVALID_FIELD";
}

function schemaPath(root: string, instancePath: string): string {
  const suffix = instancePath.replaceAll("/", ".");
  return suffix.length === 0 ? root : `${root}${suffix}`;
}

function validateSchema<const T extends TSchema>(
  validator: ReturnType<typeof Schema.Compile<T>>,
  input: unknown,
  root: string,
): Static<T> {
  const cloned = cloneInput(input);
  if (!validator.Check(cloned)) {
    const [, errors] = validator.Errors(cloned);
    throw new DomainValidationError(
      errors.map((error) => ({
        code: schemaErrorCode(error, cloned),
        path: schemaPath(root, error.instancePath),
        message: `Invalid domain value at ${schemaPath(root, error.instancePath)}`,
      })),
    );
  }
  return freezeDeep(cloned);
}

function timestampMs(value: string, path: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new DomainValidationError([
      { code: "INVALID_TIMESTAMP", path, message: `Invalid UTC timestamp at ${path}` },
    ]);
  }
  return parsed;
}

function validateNotFuture(value: UtcTimestamp, path: string, nowMs: number): void {
  const parsed = timestampMs(value, path);
  if (!Number.isFinite(nowMs) || !Number.isInteger(nowMs)) {
    throw new DomainValidationError([
      { code: "INVALID_TIMESTAMP", path: "now", message: "Clock returned an invalid epoch" },
    ]);
  }
  if (parsed > nowMs) {
    throw new DomainValidationError([
      { code: "INVALID_TIMESTAMP", path, message: `Future timestamp is not valid at ${path}` },
    ]);
  }
}

function invariant(path: string, name: string, message: string): DomainValidationError {
  return new DomainValidationError([
    { code: "INVARIANT_VIOLATION", path, invariant: name, message },
  ]);
}

function validateVehicleInvariants(vehicle: VehicleState): void {
  if (vehicle.gear === "P" && vehicle.speedKph !== 0) {
    throw invariant(
      "vehicle.speedKph",
      VEHICLE_INVARIANTS.parkedGearRequiresZeroSpeed,
      "Park gear requires zero speed",
    );
  }
  if (vehicle.driveMode === "parked" && vehicle.speedKph !== 0) {
    throw invariant(
      "vehicle.driveMode",
      VEHICLE_INVARIANTS.parkedModeRequiresZeroSpeed,
      "Parked drive mode requires zero speed",
    );
  }
  if (vehicle.chargingState === "charging" && vehicle.speedKph !== 0) {
    throw invariant(
      "vehicle.chargingState",
      VEHICLE_INVARIANTS.chargingRequiresStationary,
      "Active charging requires zero speed",
    );
  }
  if (
    vehicle.driveMode === "charging" &&
    vehicle.chargingState !== "charging" &&
    vehicle.chargingState !== "completed"
  ) {
    throw invariant(
      "vehicle.driveMode",
      VEHICLE_INVARIANTS.chargingModeRequiresChargingState,
      "Charging drive mode requires a charging or completed charging state",
    );
  }
  if (vehicle.driveMode === "charging" && vehicle.speedKph !== 0) {
    throw invariant(
      "vehicle.driveMode",
      VEHICLE_INVARIANTS.chargingModeRequiresZeroSpeed,
      "Charging drive mode requires zero speed",
    );
  }
  const seats = vehicle.occupants.map((occupant) => occupant.seat);
  if (new Set(seats).size !== seats.length) {
    throw invariant(
      "vehicle.occupants",
      VEHICLE_INVARIANTS.occupantSeatsUnique,
      "Occupant seats must be unique",
    );
  }
}

function validateTripInvariants(trip: TripState): void {
  if (
    trip.navigationActive &&
    (trip.destination === null || trip.destination.trim().length === 0)
  ) {
    throw invariant(
      "trip.destination",
      TRIP_INVARIANTS.activeNavigationRequiresDestination,
      "Active navigation requires a destination",
    );
  }
  if (trip.navigationActive && trip.routeId === null) {
    throw invariant(
      "trip.routeId",
      TRIP_INVARIANTS.activeNavigationRequiresRouteId,
      "Active navigation requires a route ID",
    );
  }
  if (!trip.navigationActive && trip.destination !== null) {
    throw invariant(
      "trip.destination",
      TRIP_INVARIANTS.inactiveNavigationClearsDestination,
      "Inactive navigation must clear the destination",
    );
  }
  if (!trip.navigationActive && trip.routeId !== null) {
    throw invariant(
      "trip.routeId",
      TRIP_INVARIANTS.inactiveNavigationClearsRouteId,
      "Inactive navigation must clear the route ID",
    );
  }
}

export function parseVehicleState(
  input: unknown,
  options: DomainValidationOptions = {},
): VehicleState {
  const vehicle = validateSchema(vehicleValidator, input, "vehicle");
  validateNotFuture(vehicle.timestamp, "vehicle.timestamp", options.nowMs ?? Date.now());
  validateVehicleInvariants(vehicle);
  return vehicle;
}

export function parseTripState(input: unknown, options: DomainValidationOptions = {}): TripState {
  const trip = validateSchema(tripValidator, input, "trip");
  validateNotFuture(trip.timestamp, "trip.timestamp", options.nowMs ?? Date.now());
  validateTripInvariants(trip);
  return trip;
}

export function assertVehicleIdentityUnchanged(previous: VehicleState, next: VehicleState): void {
  if (previous.vehicleId !== next.vehicleId) {
    throw invariant(
      "vehicle.vehicleId",
      VEHICLE_INVARIANTS.vehicleIdentityImmutable,
      "Vehicle identity cannot change within a context snapshot sequence",
    );
  }
}

export function parseDrivingContext(
  input: unknown,
  options: DomainValidationOptions = {},
): DrivingContext {
  const context = validateSchema(drivingContextValidator, input, "context");
  const nowMs = options.nowMs ?? Date.now();
  validateNotFuture(context.capturedAt, "context.capturedAt", nowMs);
  const capturedAtMs = timestampMs(context.capturedAt, "context.capturedAt");
  validateNotFuture(context.vehicle.timestamp, "context.vehicle.timestamp", capturedAtMs);
  validateNotFuture(context.trip.timestamp, "context.trip.timestamp", capturedAtMs);
  validateVehicleInvariants(context.vehicle);
  validateTripInvariants(context.trip);
  return context;
}

export function toUtcTimestamp(epochMs: number): UtcTimestamp {
  if (!Number.isFinite(epochMs) || !Number.isInteger(epochMs)) {
    throw new DomainValidationError([
      { code: "INVALID_TIMESTAMP", path: "epochMs", message: "Epoch must be a finite integer" },
    ]);
  }
  try {
    const timestamp = new Date(epochMs).toISOString();
    if (!utcTimestampValidator.Check(timestamp)) {
      throw new RangeError("Generated timestamp did not match the UTC schema");
    }
    return timestamp;
  } catch {
    throw new DomainValidationError([
      { code: "INVALID_TIMESTAMP", path: "epochMs", message: "Epoch is outside Date range" },
    ]);
  }
}

export function timestampToEpochMs(value: UtcTimestamp, path = "timestamp"): number {
  return timestampMs(value, path);
}
