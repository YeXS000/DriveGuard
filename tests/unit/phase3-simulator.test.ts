import { parseTripState, parseVehicleState } from "@driveguard/domain";
import { FixedClock } from "@driveguard/shared";
import {
  SCENARIO_IDS,
  SimulatorError,
  VehicleSimulator,
  type ScenarioId,
} from "@driveguard/vehicle-simulator";
import { describe, expect, it } from "vitest";
import { validateSimulatorState } from "../../services/vehicle-simulator/src/state.js";

const NOW_MS = Date.parse("2026-08-26T08:00:00.000Z");

function createSimulator(scenario: ScenarioId = "city_idle", seed = 12345): VehicleSimulator {
  return new VehicleSimulator({ clock: new FixedClock(NOW_MS), scenario, seed });
}

describe("Phase 3 scenarios and deterministic state", () => {
  it.each(SCENARIO_IDS)("loads valid built-in scenario %s", (scenario) => {
    const simulator = createSimulator(scenario);
    const state = simulator.state();
    expect(parseVehicleState(state.vehicle, { nowMs: NOW_MS })).toEqual(state.vehicle);
    expect(parseTripState(state.trip, { nowMs: NOW_MS })).toEqual(state.trip);
    expect(state.scenario).toBe(scenario);
    expect(state.simulationVersion).toBe(1);
    expect(simulator.isReady()).toBe(true);
  });

  it.each(SCENARIO_IDS)("replays scenario %s with the same seed", (scenario) => {
    expect(createSimulator(scenario, 77).state()).toEqual(createSimulator(scenario, 77).state());
  });

  it("lists every built-in scenario in stable order", () => {
    expect(createSimulator().scenarios.list()).toEqual(SCENARIO_IDS);
  });

  it("rejects an unknown scenario with a dedicated error", async () => {
    await expect(createSimulator().reset("unknown", 1)).rejects.toMatchObject({
      code: "SCENARIO_NOT_FOUND",
      statusCode: 404,
    });
  });

  it.each([-1, 0x1_0000_0000, 1.5, Number.NaN])("rejects invalid seed %s", async (seed) => {
    await expect(createSimulator().reset("city_idle", seed)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("returns isolated clones from state reads", () => {
    const simulator = createSimulator();
    const state = simulator.state();
    Reflect.set(state.vehicle, "soc", 1);
    expect(simulator.state().vehicle.soc).toBe(72);
  });
});

describe("Phase 3 transitions, versioning, atomicity, and reset", () => {
  it.each([0, 1, 100, 500])("sets valid speed %s", async (speedKph) => {
    const state = await createSimulator().setVehicleSpeed(speedKph);
    expect(state.vehicle.speedKph).toBe(speedKph);
    expect(state.vehicle.version).toBe(2);
    expect(state.trip.version).toBe(1);
    expect(state.simulationVersion).toBe(2);
  });

  it.each([-1, 501, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid speed %s atomically",
    async (speedKph) => {
      const simulator = createSimulator();
      const before = simulator.state();
      await expect(simulator.setVehicleSpeed(speedKph)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
      expect(simulator.state()).toEqual(before);
    },
  );

  it("rejects movement while charging without partial state", async () => {
    const simulator = createSimulator("charging");
    const before = simulator.state();
    await expect(simulator.setVehicleSpeed(1)).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
    });
    expect(simulator.state()).toEqual(before);
  });

  it.each([0, 1, 50, 100])("sets SOC %s and estimated range", async (soc) => {
    const state = await createSimulator().setSoc(soc);
    expect(state.vehicle.soc).toBe(soc);
    expect(state.vehicle.estimatedRangeKm).toBe(soc * 5);
    expect(state.vehicle.version).toBe(2);
    expect(state.trip.version).toBe(1);
  });

  it.each([-1, 101, Number.NaN])("rejects invalid SOC %s", async (soc) => {
    await expect(createSimulator().setSoc(soc)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it.each([16, 22.5, 30])("sets cabin temperature %s as vehicle state", async (value) => {
    const state = await createSimulator().setCabinTemperature(value);
    expect(state.vehicle.cabinTemperature).toBe(value);
    expect(state.vehicle.version).toBe(2);
    expect(state.trip.version).toBe(1);
  });

  it.each([15.9, 30.1])("rejects out-of-range cabin temperature %s", async (value) => {
    await expect(createSimulator().setCabinTemperature(value)).rejects.toBeInstanceOf(
      SimulatorError,
    );
  });

  it.each([
    ["driver", 0],
    ["driver", 1],
    ["driver", 2],
    ["driver", 3],
    ["front_passenger", 0],
    ["front_passenger", 1],
    ["front_passenger", 2],
    ["front_passenger", 3],
  ] as const)("sets %s seat heating to %s without domain version growth", async (seat, level) => {
    const state = await createSimulator().setSeatHeating(seat, level);
    expect(state.cabin.seatHeating[seat]).toBe(level);
    expect(state.vehicle.version).toBe(1);
    expect(state.trip.version).toBe(1);
    expect(state.simulationVersion).toBe(2);
  });

  it.each([0, 50, 100])("sets media volume %s", async (volume) => {
    const state = await createSimulator().setMediaVolume(volume);
    expect(state.cabin.mediaVolume).toBe(volume);
    expect(state.vehicle.version).toBe(1);
    expect(state.trip.version).toBe(1);
  });

  it.each([-1, 101, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid media volume %s atomically",
    async (volume) => {
      const simulator = createSimulator();
      const before = simulator.state();
      await expect(simulator.setMediaVolume(volume)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
      expect(simulator.state()).toEqual(before);
    },
  );

  it("sets deterministic navigation and only increments trip version", async () => {
    const left = createSimulator("city_idle", 99);
    const right = createSimulator("city_idle", 99);
    const first = await left.setDestination("The Bund");
    const replay = await right.setDestination("The Bund");
    expect(first).toEqual(replay);
    expect(first.trip.navigationActive).toBe(true);
    expect(first.trip.version).toBe(2);
    expect(first.vehicle.version).toBe(1);
  });

  it("reroutes active navigation using a new monotonic route ID", async () => {
    const simulator = createSimulator();
    const destination = await simulator.setDestination("The Bund");
    const rerouted = await simulator.reroute();
    expect(rerouted.trip.routeId).not.toBe(destination.trip.routeId);
    expect(rerouted.trip.destination).toBe("The Bund");
    expect(rerouted.trip.version).toBe(3);
  });

  it("rejects reroute without active navigation atomically", async () => {
    const simulator = createSimulator();
    const before = simulator.state();
    await expect(simulator.reroute()).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    expect(simulator.state()).toEqual(before);
    await simulator.setDestination("The Bund");
    expect(simulator.tripState().routeId).toBe("route-00003039-000001");
  });

  it.each(["", "   ", "x".repeat(513)])(
    "rejects invalid destination without consuming a route ID",
    async (destination) => {
      const simulator = createSimulator();
      await expect(simulator.setDestination(destination)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
      await simulator.setDestination("The Bund");
      expect(simulator.tripState().routeId).toBe("route-00003039-000001");
    },
  );

  it("lists fixed charging stations", () => {
    const stations = createSimulator().chargingStations();
    expect(stations).toHaveLength(3);
    expect(stations.map((station) => station.id)).toEqual([
      "station-pudong-001",
      "station-hongqiao-002",
      "station-empty-003",
    ]);
  });

  it("creates and cancels a reservation while restoring capacity", async () => {
    const simulator = createSimulator();
    const created = await simulator.createReservation("station-pudong-001");
    const reservation = created.charging.reservations[0];
    expect(reservation?.id).toBe("reservation-00003039-000001");
    expect(created.vehicle.version).toBe(1);
    expect(created.trip.version).toBe(1);
    expect(created.charging.stations[0]?.availableSlots).toBe(1);
    const cancelled = await simulator.cancelReservation(reservation?.id ?? "missing");
    expect(cancelled.charging.reservations).toHaveLength(0);
    expect(cancelled.charging.stations[0]?.availableSlots).toBe(2);
  });

  it("rejects a missing station", async () => {
    const simulator = createSimulator();
    await expect(simulator.createReservation("missing")).rejects.toMatchObject({
      code: "STATION_NOT_FOUND",
    });
    const state = await simulator.createReservation("station-pudong-001");
    expect(state.charging.reservations[0]?.id).toBe("reservation-00003039-000001");
  });

  it("rejects a station without capacity", async () => {
    await expect(createSimulator().createReservation("station-empty-003")).rejects.toMatchObject({
      code: "NO_AVAILABLE_SLOT",
    });
  });

  it("rejects duplicate active reservation", async () => {
    const simulator = createSimulator();
    await simulator.createReservation("station-pudong-001");
    await expect(simulator.createReservation("station-pudong-001")).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
    });
    expect(simulator.state().charging.reservations).toHaveLength(1);
  });

  it("rejects cancellation of a missing reservation", async () => {
    await expect(createSimulator().cancelReservation("missing")).rejects.toMatchObject({
      code: "RESERVATION_NOT_FOUND",
    });
  });

  it("creates deterministic monotonic roadside requests", async () => {
    const simulator = createSimulator("city_idle", 5);
    await simulator.requestRoadsideAssistance("flat tire");
    const state = await simulator.requestRoadsideAssistance("battery issue");
    expect(state.assistance.requests.map((request) => request.id)).toEqual([
      "assistance-00000005-000001",
      "assistance-00000005-000002",
    ]);
  });

  it.each(["", "   ", "x".repeat(513)])(
    "rejects invalid roadside reason without consuming an ID",
    async (reason) => {
      const simulator = createSimulator();
      await expect(simulator.requestRoadsideAssistance(reason)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
      const state = await simulator.requestRoadsideAssistance("valid reason");
      expect(state.assistance.requests[0]?.id).toBe("assistance-00003039-000001");
    },
  );

  it("rejects an invalid runtime seat-heating level", async () => {
    const simulator = createSimulator();
    await expect(
      (
        simulator as unknown as {
          setSeatHeating(seat: string, level: number): Promise<unknown>;
        }
      ).setSeatHeating("driver", 4),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(simulator.state().simulationVersion).toBe(1);
  });

  it("rejects an invalid runtime seat key", async () => {
    const simulator = createSimulator();
    await expect(
      (
        simulator as unknown as {
          setSeatHeating(seat: string, level: number): Promise<unknown>;
        }
      ).setSeatHeating("rear", 1),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(simulator.state().simulationVersion).toBe(1);
  });

  it("reset clears mutations, reservations, assistance, faults, history, and counters", async () => {
    const simulator = createSimulator();
    await simulator.setSoc(12);
    await simulator.createReservation("station-pudong-001");
    await simulator.requestRoadsideAssistance("flat tire");
    simulator.configureFault({
      target: "vehicle.get_state",
      mode: "stale_response",
      probability: 1,
      delayMs: 0,
    });
    const reset = await simulator.reset("city_idle", 12345);
    expect(reset).toEqual(createSimulator().state());
    expect(simulator.listFaults()).toHaveLength(0);
    expect(simulator.historySize()).toBe(1);
    expect(simulator.vehicleState(true)).toEqual(reset.vehicle);
    const reservation = await simulator.createReservation("station-pudong-001");
    expect(reservation.charging.reservations[0]?.id).toBe("reservation-00003039-000001");
  });

  it("returns the prior validated vehicle state for stale reads", async () => {
    const simulator = createSimulator();
    await simulator.setSoc(50);
    await simulator.setMediaVolume(60);
    expect(simulator.vehicleState(true).version).toBe(1);
    expect(simulator.vehicleState(false).version).toBe(2);
    expect(parseVehicleState(simulator.vehicleState(true), { nowMs: NOW_MS }).version).toBe(1);
  });

  it("returns the prior validated trip version across unrelated mutations", async () => {
    const simulator = createSimulator();
    await simulator.setDestination("The Bund");
    await simulator.setSoc(50);
    expect(simulator.tripState(true).version).toBe(1);
    expect(simulator.tripState(false).version).toBe(2);
  });

  it("retains a bounded history and returns the immediately previous state", async () => {
    const simulator = createSimulator();
    for (let soc = 10; soc < 22; soc += 1) await simulator.setSoc(soc);
    expect(simulator.vehicleState().soc).toBe(21);
    expect(simulator.vehicleState(true).soc).toBe(20);
    expect(simulator.historySize()).toBe(10);
  });

  it("serializes concurrent vehicle mutations with monotonic versions", async () => {
    const simulator = createSimulator();
    const [first, second] = await Promise.all([
      simulator.setSoc(40),
      simulator.setVehicleSpeed(60),
    ]);
    expect([first.vehicle.version, second.vehicle.version].sort()).toEqual([2, 3]);
    expect(simulator.state()).toMatchObject({ simulationVersion: 3, vehicle: { version: 3 } });
    expect(simulator.state().vehicle).toMatchObject({ soc: 40, speedKph: 60 });
  });

  it("serializes concurrent reservations without duplicate IDs or corruption", async () => {
    const simulator = createSimulator();
    const [first, second] = await Promise.all([
      simulator.createReservation("station-pudong-001"),
      simulator.createReservation("station-hongqiao-002"),
    ]);
    expect([first.simulationVersion, second.simulationVersion].sort()).toEqual([2, 3]);
    const reservations = simulator.state().charging.reservations;
    expect(new Set(reservations.map((reservation) => reservation.id)).size).toBe(2);
    expect(reservations).toHaveLength(2);
    expect(simulator.state().charging.stations.map((station) => station.availableSlots)).toEqual([
      1, 0, 0,
    ]);
  });

  it("serializes same-station reservation contention with exactly one winner", async () => {
    const simulator = createSimulator();
    const results = await Promise.allSettled([
      simulator.createReservation("station-pudong-001"),
      simulator.createReservation("station-pudong-001"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "INVALID_TRANSITION" },
    });
    const state = simulator.state();
    expect(state.charging.reservations).toHaveLength(1);
    expect(state.charging.stations[0]?.availableSlots).toBe(1);
    expect(state.simulationVersion).toBe(2);
  });
});

describe("Phase 3 simulator-specific runtime state validation", () => {
  it.each([
    [
      "simulation version",
      (state: Record<string, unknown>) => Reflect.set(state, "simulationVersion", 0),
    ],
    ["seed", (state: Record<string, unknown>) => Reflect.set(state, "seed", -1)],
    ["scenario", (state: Record<string, unknown>) => Reflect.set(state, "scenario", "unknown")],
    [
      "future updatedAt",
      (state: Record<string, unknown>) =>
        Reflect.set(state, "updatedAt", "2026-08-26T08:00:00.001Z"),
    ],
    [
      "media volume",
      (state: Record<string, unknown>) => Reflect.set(state["cabin"] as object, "mediaVolume", 101),
    ],
    [
      "seat heating",
      (state: Record<string, unknown>) =>
        Reflect.set(Reflect.get(state["cabin"] as object, "seatHeating") as object, "driver", 4),
    ],
    [
      "station capacity",
      (state: Record<string, unknown>) => {
        const charging = state["charging"] as { stations: Array<Record<string, unknown>> };
        return Reflect.set(charging.stations[0] ?? {}, "availableSlots", -1);
      },
    ],
    [
      "station IDs",
      (state: Record<string, unknown>) => {
        const charging = state["charging"] as { stations: Array<Record<string, unknown>> };
        return Reflect.set(
          charging.stations[1] ?? {},
          "id",
          Reflect.get(charging.stations[0] ?? {}, "id"),
        );
      },
    ],
  ] as const)("rejects corrupt %s", (_label, corrupt) => {
    const state = createSimulator().state() as unknown as Record<string, unknown>;
    corrupt(state);
    expect(() => validateSimulatorState(state as never, NOW_MS)).toThrow(SimulatorError);
  });

  it.each([
    ["root", (state: Record<string, unknown>) => Reflect.set(state, "extra", true)],
    [
      "cabin",
      (state: Record<string, unknown>) => Reflect.set(state["cabin"] as object, "extra", true),
    ],
    [
      "charging station",
      (state: Record<string, unknown>) => {
        const charging = state["charging"] as { stations: Array<Record<string, unknown>> };
        return Reflect.set(charging.stations[0] ?? {}, "extra", true);
      },
    ],
    [
      "reservation",
      (state: Record<string, unknown>) => {
        const charging = state["charging"] as { reservations: Array<Record<string, unknown>> };
        return Reflect.set(charging.reservations[0] ?? {}, "extra", true);
      },
    ],
    [
      "assistance request",
      (state: Record<string, unknown>) => {
        const assistance = state["assistance"] as { requests: Array<Record<string, unknown>> };
        return Reflect.set(assistance.requests[0] ?? {}, "extra", true);
      },
    ],
  ] as const)("rejects unsupported %s fields", async (_label, addExtra) => {
    const simulator = createSimulator();
    await simulator.createReservation("station-pudong-001");
    const state = await simulator.requestRoadsideAssistance("flat tire");
    addExtra(state as unknown as Record<string, unknown>);
    expect(() => validateSimulatorState(state, NOW_MS)).toThrow(SimulatorError);
  });

  it.each(["stations", "reservations", "requests"] as const)(
    "rejects sparse %s arrays",
    (collection) => {
      const simulator = createSimulator();
      const state = simulator.state();
      if (collection === "stations") {
        Reflect.set(state.charging, "stations", new Array(1));
      } else if (collection === "reservations") {
        Reflect.set(state.charging, "reservations", new Array(1));
      } else {
        Reflect.set(state.assistance, "requests", new Array(1));
      }
      expect(() => validateSimulatorState(state, NOW_MS)).toThrow(SimulatorError);
    },
  );

  it("rejects a reservation referencing an unknown station", async () => {
    const state = await createSimulator().createReservation("station-pudong-001");
    Reflect.set(state.charging.reservations[0] ?? {}, "stationId", "missing");
    expect(() => validateSimulatorState(state, NOW_MS)).toThrow(SimulatorError);
  });

  it("rejects duplicate assistance IDs", async () => {
    const simulator = createSimulator();
    await simulator.requestRoadsideAssistance("first");
    const state = await simulator.requestRoadsideAssistance("second");
    Reflect.set(state.assistance.requests[1] ?? {}, "id", state.assistance.requests[0]?.id);
    expect(() => validateSimulatorState(state, NOW_MS)).toThrow(SimulatorError);
  });
});
