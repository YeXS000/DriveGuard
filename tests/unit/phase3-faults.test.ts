import {
  DeterministicIdAllocator,
  FAULT_MODES,
  FAULT_TARGETS,
  FaultManager,
  SimulatorError,
  deterministicUnit,
  validateFaultConfig,
  validateSeed,
} from "@driveguard/vehicle-simulator";
import { describe, expect, it } from "vitest";

describe("Phase 3 deterministic helpers", () => {
  it.each([0, 1, 42, 0xffff_ffff])("accepts seed %s", (seed) => {
    expect(validateSeed(seed)).toBe(seed);
  });

  it.each([-1, 0x1_0000_0000, 1.2, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects seed %s",
    (seed) => {
      expect(() => validateSeed(seed)).toThrow(SimulatorError);
    },
  );

  it("produces stable unit values and namespace isolation", () => {
    expect(deterministicUnit(5, "a", 1)).toBe(deterministicUnit(5, "a", 1));
    expect(deterministicUnit(5, "a", 1)).not.toBe(deterministicUnit(5, "b", 1));
    expect(deterministicUnit(5, "a", 1)).toBeGreaterThanOrEqual(0);
    expect(deterministicUnit(5, "a", 1)).toBeLessThan(1);
  });

  it("allocates deterministic monotonic IDs by namespace", () => {
    const ids = new DeterministicIdAllocator(255);
    expect(ids.next("route")).toBe("route-000000ff-000001");
    expect(ids.next("route")).toBe("route-000000ff-000002");
    expect(ids.next("reservation")).toBe("reservation-000000ff-000001");
  });
});

describe("Phase 3 fault manager", () => {
  it.each(FAULT_MODES)("accepts supported mode %s", (mode) => {
    const target = mode === "stale_response" ? "vehicle.get_state" : "trip.get_state";
    expect(validateFaultConfig({ target, mode, probability: 1, delayMs: 5 }).mode).toBe(mode);
  });

  it.each(FAULT_TARGETS)("accepts explicit target %s", (target) => {
    expect(
      validateFaultConfig({ target, mode: "delay", probability: 0.5, delayMs: 0 }).target,
    ).toBe(target);
  });

  it.each([-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects probability %s",
    (probability) => {
      expect(() =>
        validateFaultConfig({
          target: "vehicle.get_state",
          mode: "delay",
          probability,
          delayMs: 0,
        }),
      ).toThrow(SimulatorError);
    },
  );

  it.each([-1, 30_001, 1.5, Number.NaN])("rejects delayMs %s", (delayMs) => {
    expect(() =>
      validateFaultConfig({
        target: "vehicle.get_state",
        mode: "delay",
        probability: 1,
        delayMs,
      }),
    ).toThrow(SimulatorError);
  });

  it("rejects an arbitrary target", () => {
    expect(() =>
      validateFaultConfig({
        target: "arbitrary.javascript" as "vehicle.get_state",
        mode: "delay",
        probability: 1,
        delayMs: 0,
      }),
    ).toThrow(SimulatorError);
  });

  it("rejects an arbitrary mode", () => {
    expect(() =>
      validateFaultConfig({
        target: "vehicle.get_state",
        mode: "eval" as "delay",
        probability: 1,
        delayMs: 0,
      }),
    ).toThrow(SimulatorError);
  });

  it("limits stale responses to state reads", () => {
    expect(() =>
      validateFaultConfig({
        target: "charging.create_reservation",
        mode: "stale_response",
        probability: 1,
        delayMs: 0,
      }),
    ).toThrow(SimulatorError);
  });

  it("never triggers probability zero", () => {
    const manager = new FaultManager(1);
    manager.set({
      target: "vehicle.get_state",
      mode: "http_503",
      probability: 0,
      delayMs: 0,
    });
    expect(manager.consume("vehicle.get_state")).toBeUndefined();
  });

  it("always triggers probability one", () => {
    const manager = new FaultManager(1);
    manager.set({
      target: "vehicle.get_state",
      mode: "http_503",
      probability: 1,
      delayMs: 0,
    });
    expect(manager.consume("vehicle.get_state")).toMatchObject({ triggered: true });
  });

  it("is deterministic for equal seed and call sequence", () => {
    const left = new FaultManager(88);
    const right = new FaultManager(88);
    const config = {
      target: "vehicle.get_state" as const,
      mode: "delay" as const,
      probability: 0.5,
      delayMs: 0,
    };
    left.set(config);
    right.set(config);
    expect(Array.from({ length: 20 }, () => Boolean(left.consume(config.target)))).toEqual(
      Array.from({ length: 20 }, () => Boolean(right.consume(config.target))),
    );
  });

  it("does not affect unrelated targets", () => {
    const manager = new FaultManager(1);
    manager.set({
      target: "vehicle.get_state",
      mode: "http_500",
      probability: 1,
      delayMs: 0,
    });
    expect(manager.consume("trip.get_state")).toBeUndefined();
  });

  it("lists faults in target order and replaces a target config", () => {
    const manager = new FaultManager(1);
    manager.set({
      target: "trip.get_state",
      mode: "delay",
      probability: 1,
      delayMs: 1,
    });
    manager.set({
      target: "vehicle.get_state",
      mode: "http_500",
      probability: 1,
      delayMs: 0,
    });
    manager.set({
      target: "trip.get_state",
      mode: "http_503",
      probability: 1,
      delayMs: 0,
    });
    expect(manager.list().map((fault) => fault.target)).toEqual([
      "trip.get_state",
      "vehicle.get_state",
    ]);
    expect(manager.list()[0]?.mode).toBe("http_503");
  });

  it("clear and reseed remove every fault", () => {
    const manager = new FaultManager(1);
    manager.set({
      target: "vehicle.get_state",
      mode: "delay",
      probability: 1,
      delayMs: 0,
    });
    manager.clear();
    expect(manager.list()).toEqual([]);
    manager.set({
      target: "trip.get_state",
      mode: "delay",
      probability: 1,
      delayMs: 0,
    });
    manager.setSeed(2);
    expect(manager.list()).toEqual([]);
  });

  it("serializes structured errors without stack or paths", () => {
    const error = new SimulatorError("STATION_NOT_FOUND", "missing", 404);
    expect(error.toJSON()).toEqual({
      error: { code: "STATION_NOT_FOUND", message: "missing" },
    });
    expect(JSON.stringify(error.toJSON())).not.toContain("stack");
  });
});
