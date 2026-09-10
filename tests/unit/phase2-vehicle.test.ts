import { describe, expect, it } from "vitest";

import {
  type ContextSnapshotId,
  DomainValidationError,
  parseVehicleState,
  toUtcTimestamp,
  VEHICLE_INVARIANTS,
} from "@driveguard/domain";
import { createValidVehicleInput, PHASE_2_NOW_MS } from "../fixtures/phase2-domain.js";

function expectCode(input: unknown, code: DomainValidationError["code"], invariant?: string): void {
  try {
    parseVehicleState(input, { nowMs: PHASE_2_NOW_MS });
    throw new Error("Expected vehicle validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(DomainValidationError);
    if (!(error instanceof DomainValidationError)) return;
    expect(error.code).toBe(code);
    if (invariant !== undefined) expect(error.issues[0]?.invariant).toBe(invariant);
  }
}

describe("Phase 2 VehicleState validation", () => {
  it("accepts a normal stationary vehicle", () => {
    expect(parseVehicleState(createValidVehicleInput(), { nowMs: PHASE_2_NOW_MS }).gear).toBe("P");
  });

  it("accepts a driving vehicle", () => {
    const input = createValidVehicleInput();
    Object.assign(input, { speedKph: 80, gear: "D", driveMode: "driving" });
    expect(parseVehicleState(input, { nowMs: PHASE_2_NOW_MS }).speedKph).toBe(80);
  });

  it("accepts a charging vehicle", () => {
    const input = createValidVehicleInput();
    Object.assign(input, { driveMode: "charging", chargingState: "charging" });
    expect(parseVehicleState(input, { nowMs: PHASE_2_NOW_MS }).chargingState).toBe("charging");
  });

  it("accepts low SOC", () => {
    const input = createValidVehicleInput();
    input.soc = 1;
    expect(parseVehicleState(input, { nowMs: PHASE_2_NOW_MS }).soc).toBe(1);
  });

  it.each([0, 100])("accepts SOC boundary %s", (soc) => {
    const input = createValidVehicleInput();
    input.soc = soc;
    expect(parseVehicleState(input, { nowMs: PHASE_2_NOW_MS }).soc).toBe(soc);
  });

  it.each([
    ["soc", -1],
    ["soc", 101],
    ["speedKph", -1],
    ["speedKph", 501],
    ["estimatedRangeKm", -1],
    ["estimatedRangeKm", 5_001],
    ["cabinTemperature", 15.9],
    ["cabinTemperature", 30.1],
    ["outsideTemperature", -60.1],
    ["outsideTemperature", 60.1],
    ["latitude", -90.1],
    ["latitude", 90.1],
    ["longitude", -180.1],
    ["longitude", 180.1],
    ["soc", Number.MAX_VALUE],
  ])("rejects out-of-range %s=%s", (field, value) => {
    const input = createValidVehicleInput();
    Reflect.set(input, field, value);
    expectCode(input, "OUT_OF_RANGE");
  });

  it.each([
    ["soc", Number.NaN],
    ["speedKph", Number.POSITIVE_INFINITY],
    ["estimatedRangeKm", Number.NEGATIVE_INFINITY],
    ["soc", null],
    ["soc", undefined],
  ])("rejects non-finite or absent numeric %s=%s", (field, value) => {
    const input = createValidVehicleInput();
    Reflect.set(input, field, value);
    expectCode(input, "INVALID_FIELD");
  });

  it.each([
    ["soc", 0],
    ["soc", 100],
    ["cabinTemperature", 16],
    ["cabinTemperature", 30],
    ["outsideTemperature", -60],
    ["outsideTemperature", 60],
    ["latitude", -90],
    ["latitude", 90],
    ["longitude", -180],
    ["longitude", 180],
  ])("deterministically accepts boundary %s=%s", (field, value) => {
    const input = createValidVehicleInput();
    Reflect.set(input, field, value);
    expect(Reflect.get(parseVehicleState(input, { nowMs: PHASE_2_NOW_MS }), field)).toBe(value);
  });

  it("rejects an invalid enum", () => {
    const input = createValidVehicleInput();
    input.gear = "SIDEWAYS";
    expectCode(input, "INVALID_ENUM");
  });

  it("rejects a missing required field", () => {
    const input = createValidVehicleInput();
    Reflect.deleteProperty(input, "vehicleId");
    expectCode(input, "INVALID_FIELD");
  });

  it.each(["not-a-time", "2026-13-25T10:00:00.000Z", "2026-08-25T10:00:00Z"])(
    "rejects invalid or non-canonical timestamp %s",
    (timestamp) => {
      const input = createValidVehicleInput();
      input.timestamp = timestamp;
      expectCode(input, "INVALID_TIMESTAMP");
    },
  );

  it("rejects a future timestamp", () => {
    const input = createValidVehicleInput();
    input.timestamp = "2026-08-25T10:00:00.001Z";
    expectCode(input, "INVALID_TIMESTAMP");
  });

  it("rejects an invalid injected current time", () => {
    expect(() => parseVehicleState(createValidVehicleInput(), { nowMs: Number.NaN })).toThrow(
      DomainValidationError,
    );
  });

  it("rejects an epoch outside the JavaScript Date range", () => {
    expect(() => toUtcTimestamp(Number.MAX_SAFE_INTEGER)).toThrow(DomainValidationError);
  });

  it("serializes structured domain errors without a raw stack", () => {
    const error = new DomainValidationError([
      { code: "INVALID_FIELD", path: "vehicle.soc", message: "invalid" },
    ]);
    expect(error.toJSON()).toEqual({
      code: "INVALID_FIELD",
      issues: [{ code: "INVALID_FIELD", path: "vehicle.soc", message: "invalid" }],
    });
  });

  it("freezes structured issue records against later mutation", () => {
    const error = new DomainValidationError([
      { code: "INVALID_FIELD", path: "vehicle.soc", message: "invalid" },
    ]);
    expect(Reflect.set(error.issues[0] ?? {}, "path", "mutated")).toBe(false);
    expect(error.issues[0]?.path).toBe("vehicle.soc");
  });

  it("keeps nominal IDs separated by the TypeScript compiler", () => {
    const vehicleId = parseVehicleState(createValidVehicleInput(), {
      nowMs: PHASE_2_NOW_MS,
    }).vehicleId;
    // @ts-expect-error VehicleId must not be assignable to ContextSnapshotId.
    const snapshotId: ContextSnapshotId = vehicleId;
    expect(typeof snapshotId).toBe("string");
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid version %s", (version) => {
    const input = createValidVehicleInput();
    input.version = version;
    expectCode(input, "OUT_OF_RANGE");
  });

  it("rejects Park gear at non-zero speed with a named invariant", () => {
    const input = createValidVehicleInput();
    input.speedKph = 120;
    expectCode(input, "INVARIANT_VIOLATION", VEHICLE_INVARIANTS.parkedGearRequiresZeroSpeed);
  });

  it("rejects parked drive mode at non-zero speed with a named invariant", () => {
    const input = createValidVehicleInput();
    Object.assign(input, { speedKph: 120, gear: "D", driveMode: "parked" });
    expectCode(input, "INVARIANT_VIOLATION", VEHICLE_INVARIANTS.parkedModeRequiresZeroSpeed);
  });

  it("rejects active charging at non-zero speed with a named invariant", () => {
    const input = createValidVehicleInput();
    Object.assign(input, {
      speedKph: 1,
      gear: "D",
      driveMode: "driving",
      chargingState: "charging",
    });
    expectCode(input, "INVARIANT_VIOLATION", VEHICLE_INVARIANTS.chargingRequiresStationary);
  });

  it("rejects charging mode without a charging state", () => {
    const input = createValidVehicleInput();
    input.driveMode = "charging";
    expectCode(input, "INVARIANT_VIOLATION", VEHICLE_INVARIANTS.chargingModeRequiresChargingState);
  });

  it("rejects completed charging mode at non-zero speed with a named invariant", () => {
    const input = createValidVehicleInput();
    Object.assign(input, {
      speedKph: 120,
      gear: "D",
      driveMode: "charging",
      chargingState: "completed",
    });
    expectCode(input, "INVARIANT_VIOLATION", VEHICLE_INVARIANTS.chargingModeRequiresZeroSpeed);
  });

  it("rejects duplicate occupant seats", () => {
    const input = createValidVehicleInput();
    input.occupants[1] = { seat: "driver", presence: "vacant" };
    expectCode(input, "INVARIANT_VIOLATION", VEHICLE_INVARIANTS.occupantSeatsUnique);
  });

  it("returns cloned deeply immutable state", () => {
    const input = createValidVehicleInput();
    const parsed = parseVehicleState(input, { nowMs: PHASE_2_NOW_MS });
    input.doors.frontLeft = "open";
    expect(parsed.doors.frontLeft).toBe("locked");
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.doors)).toBe(true);
    expect(Object.isFrozen(parsed.occupants)).toBe(true);
  });

  it("rejects non-cloneable runtime input", () => {
    const input = createValidVehicleInput();
    Reflect.set(input, "callback", () => undefined);
    expectCode(input, "INVALID_FIELD");
  });
});
