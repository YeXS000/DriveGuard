import { describe, expect, it } from "vitest";

import {
  DomainValidationError,
  parseDrivingContext,
  parseTripState,
  TRIP_INVARIANTS,
} from "@driveguard/domain";
import {
  createCapabilitiesInput,
  createInactiveTripInput,
  createUserInput,
  createValidSnapshot,
  createValidTripInput,
  createWeatherInput,
  PHASE_2_NOW_MS,
} from "../fixtures/phase2-domain.js";

function expectTripError(input: unknown, code: string, invariant?: string): void {
  try {
    parseTripState(input, { nowMs: PHASE_2_NOW_MS });
    throw new Error("Expected trip validation failure");
  } catch (error) {
    expect(error).toBeInstanceOf(DomainValidationError);
    if (!(error instanceof DomainValidationError)) return;
    expect(error.code).toBe(code);
    if (invariant !== undefined) expect(error.issues[0]?.invariant).toBe(invariant);
  }
}

describe("Phase 2 TripState and DrivingContext validation", () => {
  it("accepts active navigation", () => {
    expect(parseTripState(createValidTripInput(), { nowMs: PHASE_2_NOW_MS }).routeId).toBe(
      "route-001",
    );
  });

  it("accepts inactive navigation with explicit null route data", () => {
    const trip = parseTripState(createInactiveTripInput(), { nowMs: PHASE_2_NOW_MS });
    expect(trip.destination).toBeNull();
    expect(trip.routeId).toBeNull();
  });

  it.each([
    ["remainingDistanceKm", 0],
    ["etaMinutes", 0],
  ])("accepts zero %s", (field, value) => {
    const trip = createValidTripInput();
    Reflect.set(trip, field, value);
    expect(Reflect.get(parseTripState(trip, { nowMs: PHASE_2_NOW_MS }), field)).toBe(value);
  });

  it.each([
    ["remainingDistanceKm", -1],
    ["etaMinutes", -1],
    ["remainingDistanceKm", 100_001],
    ["etaMinutes", 525_601],
  ])("rejects out-of-range %s", (field, value) => {
    const trip = createValidTripInput();
    Reflect.set(trip, field, value);
    expectTripError(trip, "OUT_OF_RANGE");
  });

  it("rejects active navigation missing destination", () => {
    const trip = createValidTripInput();
    Reflect.deleteProperty(trip, "destination");
    expectTripError(trip, "INVALID_FIELD");
  });

  it("rejects active navigation missing routeId", () => {
    const trip = createValidTripInput();
    Reflect.deleteProperty(trip, "routeId");
    expectTripError(trip, "INVALID_FIELD");
  });

  it("rejects active navigation with null destination using a named invariant", () => {
    const trip = createValidTripInput();
    Reflect.set(trip, "destination", null);
    expectTripError(
      trip,
      "INVARIANT_VIOLATION",
      TRIP_INVARIANTS.activeNavigationRequiresDestination,
    );
  });

  it("rejects active navigation with a whitespace-only destination", () => {
    const trip = createValidTripInput();
    trip.destination = "   ";
    expectTripError(
      trip,
      "INVARIANT_VIOLATION",
      TRIP_INVARIANTS.activeNavigationRequiresDestination,
    );
  });

  it("rejects active navigation with null routeId using a named invariant", () => {
    const trip = createValidTripInput();
    Reflect.set(trip, "routeId", null);
    expectTripError(trip, "INVARIANT_VIOLATION", TRIP_INVARIANTS.activeNavigationRequiresRouteId);
  });

  it("rejects retained destination when navigation is inactive", () => {
    const trip = createInactiveTripInput();
    Reflect.set(trip, "destination", "Old destination");
    expectTripError(
      trip,
      "INVARIANT_VIOLATION",
      TRIP_INVARIANTS.inactiveNavigationClearsDestination,
    );
  });

  it("rejects retained routeId when navigation is inactive", () => {
    const trip = createInactiveTripInput();
    Reflect.set(trip, "routeId", "old-route");
    expectTripError(trip, "INVARIANT_VIOLATION", TRIP_INVARIANTS.inactiveNavigationClearsRouteId);
  });

  it.each(["invalid", "2026-02-30T10:00:00.000Z"])("rejects invalid timestamp %s", (value) => {
    const trip = createValidTripInput();
    trip.timestamp = value;
    expectTripError(trip, "INVALID_TIMESTAMP");
  });

  it.each([0, -1, 1.2])("rejects invalid trip version %s", (value) => {
    const trip = createValidTripInput();
    trip.version = value;
    expectTripError(trip, "OUT_OF_RANGE");
  });

  it.each(["1", null])("classifies non-number trip version %s as INVALID_FIELD", (value) => {
    const trip = createValidTripInput();
    Reflect.set(trip, "version", value);
    expectTripError(trip, "INVALID_FIELD");
  });

  it("accepts the minimal weather, user and capability domain data", () => {
    const snapshot = createValidSnapshot();
    expect(snapshot.weather).toEqual(createWeatherInput());
    expect(snapshot.user).toEqual(createUserInput());
    expect(snapshot.capabilities).toEqual(createCapabilitiesInput());
  });

  it("rejects invalid minimal weather data", () => {
    const context = structuredClone(createValidSnapshot());
    Reflect.set(context.weather, "condition", "hailstorm-provider-value");
    expect(() => parseDrivingContext(context, { nowMs: PHASE_2_NOW_MS })).toThrow(
      DomainValidationError,
    );
  });

  it("rejects unknown extra context fields", () => {
    const context = structuredClone(createValidSnapshot());
    Reflect.set(context, "policyDecision", "ALLOW");
    expect(() => parseDrivingContext(context, { nowMs: PHASE_2_NOW_MS })).toThrow(
      DomainValidationError,
    );
  });
});
