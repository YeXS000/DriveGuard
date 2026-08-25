import { describe, expect, it } from "vitest";

import { FixedClock } from "@driveguard/shared";
import {
  ContextSnapshotBuilder,
  ContextSnapshotIdAllocator,
  ContextVersionAllocator,
} from "@driveguard/context";
import { DomainValidationError } from "@driveguard/domain";
import {
  createCapabilitiesInput,
  createSnapshotBuilder,
  createUserInput,
  createValidSnapshot,
  createValidTripInput,
  createValidVehicleInput,
  createWeatherInput,
  PHASE_2_NOW,
  PHASE_2_NOW_MS,
} from "../fixtures/phase2-domain.js";

function validSource() {
  return {
    vehicle: createValidVehicleInput(),
    trip: createValidTripInput(),
    weather: createWeatherInput(),
    user: createUserInput(),
    capabilities: createCapabilitiesInput(),
  };
}

describe("Phase 2 ContextSnapshot and version semantics", () => {
  it("creates a complete snapshot with clock-derived capturedAt", () => {
    const snapshot = createValidSnapshot();
    expect(snapshot.capturedAt).toBe(PHASE_2_NOW);
    expect(snapshot.snapshotId).toBe("phase2-snapshot:1");
    expect(snapshot.contextVersion).toBe(1);
  });

  it("allocates unique snapshot IDs", () => {
    const builder = createSnapshotBuilder();
    const first = builder.create(validSource());
    const second = builder.create(validSource());
    expect(first.snapshotId).not.toBe(second.snapshotId);
    expect([first.snapshotId, second.snapshotId]).toEqual([
      "phase2-snapshot:1",
      "phase2-snapshot:2",
    ]);
  });

  it("allocates monotonically increasing context versions", () => {
    const builder = createSnapshotBuilder(PHASE_2_NOW_MS, 100);
    const first = builder.create(validSource());
    const second = builder.create(validSource());
    expect(first.contextVersion).toBe(101);
    expect(second.contextVersion).toBe(102);
    expect(second.contextVersion).toBeGreaterThan(first.contextVersion);
  });

  it("shares the default context version sequence across allocator instances", () => {
    const first = new ContextVersionAllocator();
    const second = new ContextVersionAllocator();
    const firstVersion = first.next();
    const secondVersion = second.next();
    expect(secondVersion).toBe(firstVersion + 1);
  });

  it("shares a snapshot sequence across allocators using the same process prefix", () => {
    const first = new ContextSnapshotIdAllocator("process-wide-test");
    const second = new ContextSnapshotIdAllocator("process-wide-test");
    expect(first.next()).toBe("process-wide-test:1");
    expect(second.next()).toBe("process-wide-test:2");
  });

  it("deeply freezes the completed snapshot", () => {
    const snapshot = createValidSnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.vehicle)).toBe(true);
    expect(Object.isFrozen(snapshot.vehicle.doors)).toBe(true);
    expect(Object.isFrozen(snapshot.vehicle.occupants[0])).toBe(true);
    expect(Object.isFrozen(snapshot.trip)).toBe(true);
  });

  it("isolates a snapshot from later source mutation", () => {
    const source = validSource();
    const snapshot = createSnapshotBuilder().create(source);
    source.vehicle.soc = 2;
    source.vehicle.doors.frontLeft = "open";
    source.trip.destination = "Mutated destination";
    expect(snapshot.vehicle.soc).toBe(67);
    expect(snapshot.vehicle.doors.frontLeft).toBe("locked");
    expect(snapshot.trip.destination).toBe("Shanghai Railway Station");
  });

  it("rejects a vehicle identity change within one builder sequence", () => {
    const builder = createSnapshotBuilder();
    builder.create(validSource());
    const changed = validSource();
    changed.vehicle.vehicleId = "vehicle-002";
    try {
      builder.create(changed);
      throw new Error("Expected immutable vehicle identity invariant");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainValidationError);
      if (error instanceof DomainValidationError) {
        expect(error.issues[0]?.invariant).toBe("VEHICLE_IDENTITY_IMMUTABLE");
      }
    }
  });

  it("rejects invalid source vehicle state", () => {
    const source = validSource();
    source.vehicle.soc = 101;
    expect(() => createSnapshotBuilder().create(source)).toThrow(DomainValidationError);
  });

  it("rejects vehicle state newer than capturedAt", () => {
    const source = validSource();
    source.vehicle.timestamp = "2026-08-25T10:00:00.001Z";
    expect(() => createSnapshotBuilder().create(source)).toThrow(DomainValidationError);
  });

  it("rejects trip state newer than capturedAt", () => {
    const source = validSource();
    source.trip.timestamp = "2026-08-25T10:00:00.001Z";
    expect(() => createSnapshotBuilder().create(source)).toThrow(DomainValidationError);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER])(
    "rejects unusable initial context version %s",
    (initial) => {
      expect(() => new ContextVersionAllocator(initial)).toThrow(DomainValidationError);
    },
  );

  it("classifies a runtime non-number initial version as INVALID_FIELD", () => {
    try {
      Reflect.construct(ContextVersionAllocator, ["1"]);
      throw new Error("Expected invalid constructor input");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainValidationError);
      if (error instanceof DomainValidationError) expect(error.code).toBe("INVALID_FIELD");
    }
  });

  it("rejects null instead of treating it as the default process version", () => {
    expect(() => {
      Reflect.construct(ContextVersionAllocator, [null]);
    }).toThrow(DomainValidationError);
  });

  it("reports allocator current version without allocating", () => {
    const allocator = new ContextVersionAllocator(12);
    expect(allocator.current()).toBe(12);
    expect(allocator.next()).toBe(13);
    expect(allocator.current()).toBe(13);
  });

  it("rejects context version allocation beyond the safe integer limit", () => {
    const allocator = new ContextVersionAllocator(Number.MAX_SAFE_INTEGER - 1);
    expect(allocator.next()).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => allocator.next()).toThrow(DomainValidationError);
  });

  it.each(["", "contains spaces", "bad/slash"])("rejects invalid snapshot prefix %s", (prefix) => {
    expect(() => new ContextSnapshotIdAllocator(prefix)).toThrow(DomainValidationError);
  });

  it.each([null, 123, { prefix: "object" }, Symbol("prefix")])(
    "rejects a non-string snapshot prefix runtime value",
    (prefix) => {
      expect(() => {
        Reflect.construct(ContextSnapshotIdAllocator, [prefix, 0]);
      }).toThrow(DomainValidationError);
    },
  );

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER])(
    "rejects unusable snapshot sequence %s",
    (sequence) => {
      expect(() => new ContextSnapshotIdAllocator("valid", sequence)).toThrow(
        DomainValidationError,
      );
    },
  );

  it("rejects null instead of treating it as the default snapshot sequence", () => {
    expect(() => {
      Reflect.construct(ContextSnapshotIdAllocator, ["null-sequence", null]);
    }).toThrow(DomainValidationError);
  });

  it("rejects a snapshot ID whose next sequence exceeds the ID schema", () => {
    const allocator = new ContextSnapshotIdAllocator("valid", Number.MAX_SAFE_INTEGER - 1);
    expect(allocator.next()).toBe("valid:9007199254740991");
    expect(() => allocator.next()).toThrow(DomainValidationError);
  });

  it("rejects a growing snapshot ID that exceeds the configured ID length", () => {
    const allocator = new ContextSnapshotIdAllocator("a".repeat(126), 9);
    expect(() => allocator.next()).toThrow(DomainValidationError);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.25])(
    "rejects invalid injected clock value %s",
    (clockValue) => {
      const builder = new ContextSnapshotBuilder({
        clock: new FixedClock(clockValue),
        versionAllocator: new ContextVersionAllocator(),
        snapshotIdAllocator: new ContextSnapshotIdAllocator("clock-test"),
      });
      expect(() => builder.create(validSource())).toThrow(DomainValidationError);
    },
  );
});
