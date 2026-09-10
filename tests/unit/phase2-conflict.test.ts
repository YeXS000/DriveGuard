import { describe, expect, it } from "vitest";

import { ContextConflictDetector } from "@driveguard/context";
import { DomainValidationError, parseDrivingContext } from "@driveguard/domain";
import {
  createCapabilitiesInput,
  createSnapshotBuilder,
  createUserInput,
  createValidSnapshot,
  createValidTripInput,
  createValidVehicleInput,
  createWeatherInput,
  PHASE_2_NOW_MS,
} from "../fixtures/phase2-domain.js";

function source() {
  return {
    vehicle: createValidVehicleInput(),
    trip: createValidTripInput(),
    weather: createWeatherInput(),
    user: createUserInput(),
    capabilities: createCapabilitiesInput(),
  };
}

describe("Phase 2 ContextConflictDetector", () => {
  const detector = new ContextConflictDetector();

  it("reports no conflict for the same snapshot", () => {
    const snapshot = createValidSnapshot();
    expect(detector.detect(snapshot, snapshot, ["vehicle.speedKph"])).toMatchObject({
      status: "NO_CONFLICT",
      changedPaths: [],
      unknownPaths: [],
    });
  });

  it("reports no version change for an equivalent independently parsed snapshot", () => {
    const planning = createValidSnapshot();
    const execution = parseDrivingContext(structuredClone(planning), { nowMs: PHASE_2_NOW_MS });
    expect(detector.detectVersionChanges(planning, execution)).toEqual({
      snapshotIdChanged: false,
      contextVersionChanged: false,
      vehicleVersionChanged: false,
      tripVersionChanged: false,
      hasVersionChanged: false,
    });
  });

  it("detects a context version and snapshot ID change", () => {
    const builder = createSnapshotBuilder();
    const planning = builder.create(source());
    const execution = builder.create(source());
    expect(detector.detectVersionChanges(planning, execution)).toMatchObject({
      snapshotIdChanged: true,
      contextVersionChanged: true,
      hasVersionChanged: true,
    });
  });

  it("detects a vehicle version change", () => {
    const builder = createSnapshotBuilder();
    const planning = builder.create(source());
    const changed = source();
    changed.vehicle.version = 2;
    const execution = builder.create(changed);
    expect(detector.detectVersionChanges(planning, execution).vehicleVersionChanged).toBe(true);
  });

  it("detects a trip version change", () => {
    const builder = createSnapshotBuilder();
    const planning = builder.create(source());
    const changed = source();
    changed.trip.version = 2;
    const execution = builder.create(changed);
    expect(detector.detectVersionChanges(planning, execution).tripVersionChanged).toBe(true);
  });

  it("reports a version change as irrelevant when requested fields are unchanged", () => {
    const builder = createSnapshotBuilder();
    const planning = builder.create(source());
    const changed = source();
    changed.vehicle.version = 2;
    changed.weather.temperatureC = 29;
    const execution = builder.create(changed);
    expect(detector.detect(planning, execution, ["vehicle.speedKph"])).toMatchObject({
      status: "VERSION_CHANGED_BUT_IRRELEVANT",
      changedPaths: [],
    });
  });

  it("detects a relevant vehicle field change", () => {
    const builder = createSnapshotBuilder();
    const planning = builder.create(source());
    const changed = source();
    Object.assign(changed.vehicle, { version: 2, speedKph: 25, gear: "D", driveMode: "driving" });
    const execution = builder.create(changed);
    expect(detector.detect(planning, execution, ["vehicle.speedKph"])).toMatchObject({
      status: "RELEVANT_STATE_CHANGED",
      changedPaths: ["vehicle.speedKph"],
    });
  });

  it("detects a relevant trip field change", () => {
    const builder = createSnapshotBuilder();
    const planning = builder.create(source());
    const changed = source();
    Object.assign(changed.trip, { version: 2, routeId: "route-002" });
    const execution = builder.create(changed);
    expect(detector.detect(planning, execution, ["trip.routeId"])).toMatchObject({
      status: "RELEVANT_STATE_CHANGED",
      changedPaths: ["trip.routeId"],
    });
  });

  it("returns multiple changed paths in deterministic sorted order", () => {
    const builder = createSnapshotBuilder();
    const planning = builder.create(source());
    const changed = source();
    Object.assign(changed.vehicle, { version: 2, speedKph: 25, gear: "D", driveMode: "driving" });
    Object.assign(changed.trip, { version: 2, routeId: "route-002" });
    const execution = builder.create(changed);
    const result = detector.detect(planning, execution, [
      "trip.routeId",
      "vehicle.gear",
      "vehicle.speedKph",
      "trip.routeId",
    ]);
    expect(result.changedPaths).toEqual(["trip.routeId", "vehicle.gear", "vehicle.speedKph"]);
  });

  it("reports unknown relevant paths deterministically", () => {
    const snapshot = createValidSnapshot();
    const result = detector.detect(snapshot, snapshot, ["vehicle.unknown", "aaa.unknown"]);
    expect(result).toMatchObject({
      status: "UNKNOWN_RELEVANT_PATH",
      unknownPaths: ["aaa.unknown", "vehicle.unknown"],
      changedPaths: [],
    });
  });

  it("detects a nested door field change", () => {
    const builder = createSnapshotBuilder();
    const planning = builder.create(source());
    const changed = source();
    changed.vehicle.version = 2;
    changed.vehicle.doors.frontLeft = "open";
    const execution = builder.create(changed);
    expect(detector.detect(planning, execution, ["vehicle.doors.frontLeft"]).changedPaths).toEqual([
      "vehicle.doors.frontLeft",
    ]);
  });

  it("compares nested occupant arrays structurally", () => {
    const builder = createSnapshotBuilder();
    const planning = builder.create(source());
    const changed = source();
    changed.vehicle.version = 2;
    changed.vehicle.occupants[1] = { seat: "front_passenger", presence: "occupied" };
    const execution = builder.create(changed);
    expect(detector.detect(planning, execution, ["vehicle.occupants"]).changedPaths).toEqual([
      "vehicle.occupants",
    ]);
  });

  it("does not treat structurally equal nested arrays as changed", () => {
    const builder = createSnapshotBuilder();
    const planning = builder.create(source());
    const changed = source();
    changed.vehicle.version = 2;
    const execution = builder.create(changed);
    expect(detector.detect(planning, execution, ["vehicle.occupants"]).changedPaths).toEqual([]);
  });

  it("reports changed snapshot identity when no relevant paths are requested", () => {
    const builder = createSnapshotBuilder();
    const planning = builder.create(source());
    const execution = builder.create(source());
    expect(detector.detect(planning, execution, []).status).toBe("VERSION_CHANGED_BUT_IRRELEVANT");
  });

  it("detects snapshotId as an explicitly relevant field", () => {
    const builder = createSnapshotBuilder();
    const planning = builder.create(source());
    const execution = builder.create(source());
    expect(detector.detect(planning, execution, ["snapshotId"]).changedPaths).toEqual([
      "snapshotId",
    ]);
  });

  it("detects contextVersion as an explicitly relevant field", () => {
    const builder = createSnapshotBuilder();
    const planning = builder.create(source());
    const execution = builder.create(source());
    expect(detector.detect(planning, execution, ["contextVersion"]).changedPaths).toEqual([
      "contextVersion",
    ]);
  });

  it("detects capturedAt changes when explicitly relevant", () => {
    const planning = createValidSnapshot(createSnapshotBuilder(PHASE_2_NOW_MS, 0, "captured-a"));
    const laterMs = PHASE_2_NOW_MS + 1;
    const laterSource = source();
    laterSource.vehicle.timestamp = new Date(laterMs).toISOString();
    laterSource.trip.timestamp = new Date(laterMs).toISOString();
    const execution = createSnapshotBuilder(laterMs, 1, "captured-b").create(laterSource);
    expect(detector.detect(planning, execution, ["capturedAt"]).changedPaths).toEqual([
      "capturedAt",
    ]);
  });

  it("detects a relevant capability change", () => {
    const builder = createSnapshotBuilder();
    const planning = builder.create(source());
    const changed = source();
    changed.capabilities.media = false;
    const execution = builder.create(changed);
    expect(detector.detect(planning, execution, ["capabilities.media"]).changedPaths).toEqual([
      "capabilities.media",
    ]);
  });

  it("deduplicates unknown relevant paths", () => {
    const snapshot = createValidSnapshot();
    expect(
      detector.detect(snapshot, snapshot, ["unknown.path", "unknown.path"]).unknownPaths,
    ).toEqual(["unknown.path"]);
  });

  it("retains known changed paths while reporting an unknown path", () => {
    const builder = createSnapshotBuilder();
    const planning = builder.create(source());
    const changed = source();
    Object.assign(changed.vehicle, { speedKph: 5, gear: "D", driveMode: "driving" });
    const execution = builder.create(changed);
    const result = detector.detect(planning, execution, ["unknown.path", "vehicle.speedKph"]);
    expect(result.status).toBe("UNKNOWN_RELEVANT_PATH");
    expect(result.changedPaths).toEqual(["vehicle.speedKph"]);
  });

  it.each([null, 1, "vehicle.speedKph", { path: "vehicle.speedKph" }])(
    "rejects non-array relevantPaths runtime input",
    (relevantPaths) => {
      const snapshot = createValidSnapshot();
      expect(() => detector.detect(snapshot, snapshot, relevantPaths)).toThrow(
        DomainValidationError,
      );
    },
  );

  it.each([[[null]], [[1]], [[Symbol("path")]]])(
    "rejects non-string relevant path elements",
    (relevantPaths) => {
      const snapshot = createValidSnapshot();
      expect(() => detector.detect(snapshot, snapshot, relevantPaths)).toThrow(
        DomainValidationError,
      );
    },
  );
});
