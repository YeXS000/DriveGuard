import {
  createDriveGuardToolRegistry,
  DevelopmentEmergencySupportProvider,
  DevelopmentWeatherProvider,
  type ToolRegistry,
} from "@driveguard/tools";
import { afterEach, describe, expect, it } from "vitest";

import { FULL_CAPABILITY_CONTEXT, createPhase4Harness } from "../fixtures/phase4-tools.js";

const applications: Array<Awaited<ReturnType<typeof createPhase4Harness>>["app"]> = [];

async function harness() {
  const created = await createPhase4Harness();
  applications.push(created.app);
  return created;
}

async function execute(registry: ToolRegistry, name: string, input: object) {
  return registry.requireAvailable(name, FULL_CAPABILITY_CONTEXT).execute(input);
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map(async (application) => application.close()));
});

describe("Phase 4 Registry -> formal Tool -> Simulator integration", () => {
  it("resolves and executes validated vehicle and trip reads", async () => {
    const { registry } = await harness();
    expect(await execute(registry, "get_vehicle_state", {})).toMatchObject({
      vehicleId: "simulator-vehicle-001",
      soc: 72,
    });
    expect(await execute(registry, "get_trip_state", {})).toMatchObject({
      navigationActive: false,
      destination: null,
    });
  });

  it("executes cabin temperature with previous/current structured output", async () => {
    const { registry, simulator } = await harness();
    await expect(execute(registry, "set_cabin_temperature", { temperatureC: 24 })).resolves.toEqual(
      {
        applied: true,
        previousTemperatureC: 22,
        currentTemperatureC: 24,
      },
    );
    expect(simulator.state().vehicle.cabinTemperature).toBe(24);
  });

  it("executes seat heating and media mutations", async () => {
    const { registry, simulator } = await harness();
    await expect(
      execute(registry, "set_seat_heating", { seat: "driver", level: 3 }),
    ).resolves.toEqual({ applied: true, seat: "driver", level: 3 });
    await expect(execute(registry, "set_media_volume", { volume: 61 })).resolves.toEqual({
      applied: true,
      volume: 61,
    });
    expect(simulator.state().cabin).toMatchObject({
      seatHeating: { driver: 3 },
      mediaVolume: 61,
    });
  });

  it("executes navigation destination and charger reroute", async () => {
    const { registry, simulator } = await harness();
    await expect(
      execute(registry, "set_navigation_destination", { destination: "The Bund" }),
    ).resolves.toMatchObject({ destination: "The Bund", navigationActive: true });
    await expect(
      execute(registry, "reroute_to_charger", { stationId: "station-hongqiao-002" }),
    ).resolves.toMatchObject({ destination: "Hongqiao Charging Hub", navigationActive: true });
    expect(simulator.state().trip.destination).toBe("Hongqiao Charging Hub");
  });

  it("rejects a charger reroute to an unknown station", async () => {
    const { registry } = await harness();
    await expect(
      execute(registry, "reroute_to_charger", { stationId: "missing" }),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("executes charging search and status reads", async () => {
    const { registry } = await harness();
    const stations = (await execute(registry, "search_charging_stations", {})) as {
      stations: Array<{ id: string }>;
    };
    expect(stations.stations).toHaveLength(3);
    expect(stations.stations[0]).toMatchObject({ id: "station-pudong-001" });
    await expect(execute(registry, "get_charging_status", {})).resolves.toEqual({
      chargingState: "not_charging",
      reservations: [],
    });
  });

  it("executes reservation and cancellation through HTTP", async () => {
    const { registry, simulator } = await harness();
    const created = (await execute(registry, "reserve_charging_slot", {
      stationId: "station-pudong-001",
    })) as { reservation: { id: string } };
    expect(created.reservation.id).toBe("reservation-00003039-000001");
    await expect(
      execute(registry, "cancel_charging_reservation", {
        reservationId: created.reservation.id,
      }),
    ).resolves.toEqual({ cancelled: true, reservationId: created.reservation.id });
    expect(simulator.state().charging.reservations).toEqual([]);
  });

  it("executes simulator roadside assistance", async () => {
    const { registry, simulator } = await harness();
    await expect(
      execute(registry, "request_roadside_assistance", { reason: "flat tire" }),
    ).resolves.toMatchObject({ request: { reason: "flat tire", status: "requested" } });
    expect(simulator.state().assistance.requests).toHaveLength(1);
  });

  it("executes explicitly marked deterministic development providers", async () => {
    const { registry } = await harness();
    await expect(execute(registry, "get_weather", {})).resolves.toEqual({
      condition: "clear",
      temperatureC: 26,
      source: "DEVELOPMENT_PROVIDER",
    });
    await expect(
      execute(registry, "request_emergency_support", { reason: "medical support" }),
    ).resolves.toEqual({
      requestId: "phase4-emergency:000001",
      status: "requested",
      source: "DEVELOPMENT_PROVIDER",
    });
  });

  it("rejects a development provider response that violates its formal output schema", async () => {
    const { client } = await harness();
    const registry = createDriveGuardToolRegistry({
      simulator: client,
      weatherProvider: {
        getWeather: () => Promise.resolve({ unexpected: true } as never),
      },
      emergencySupportProvider: new DevelopmentEmergencySupportProvider(),
    });
    await expect(execute(registry, "get_weather", {})).rejects.toMatchObject({
      code: "DEPENDENCY_RESPONSE_INVALID",
    });
  });

  it("normalizes an unexpected provider failure", async () => {
    const { client } = await harness();
    const registry = createDriveGuardToolRegistry({
      simulator: client,
      weatherProvider: new DevelopmentWeatherProvider(),
      emergencySupportProvider: {
        requestEmergencySupport: () => Promise.reject(new Error("provider internals")),
      },
    });
    await expect(
      execute(registry, "request_emergency_support", { reason: "development drill" }),
    ).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", message: "Tool dependency failed" });
  });

  it("rejects invalid arguments before any simulator mutation", async () => {
    const { registry, simulator } = await harness();
    const before = simulator.state();
    await expect(
      execute(registry, "set_cabin_temperature", { temperatureC: 31 }),
    ).rejects.toMatchObject({ code: "TOOL_VALIDATION_ERROR" });
    expect(simulator.state()).toEqual(before);
  });

  it("rejects schema-valid but uncloneable tool arguments", async () => {
    const { registry } = await harness();
    const input = new Proxy({}, {});
    await expect(execute(registry, "get_weather", input)).rejects.toMatchObject({
      code: "TOOL_VALIDATION_ERROR",
      message: "Tool arguments must be cloneable data",
    });
  });

  it("rejects schema-valid but uncloneable provider output", async () => {
    const { client } = await harness();
    const output = new Proxy(
      { condition: "clear" as const, temperatureC: 25, source: "DEVELOPMENT_PROVIDER" as const },
      {},
    );
    const registry = createDriveGuardToolRegistry({
      simulator: client,
      weatherProvider: { getWeather: () => Promise.resolve(output) },
      emergencySupportProvider: new DevelopmentEmergencySupportProvider(),
    });
    await expect(execute(registry, "get_weather", {})).rejects.toMatchObject({
      code: "DEPENDENCY_RESPONSE_INVALID",
      message: "Tool output must be cloneable data",
    });
  });

  it.each([
    ["missing", "RESOURCE_NOT_FOUND"],
    ["station-empty-003", "CONFLICT"],
  ] as const)("maps reservation outcome for station %s", async (stationId, code) => {
    const { registry } = await harness();
    await expect(execute(registry, "reserve_charging_slot", { stationId })).rejects.toMatchObject({
      code,
    });
  });

  it.each(["http_500", "http_503"] as const)(
    "maps real Simulator %s fault to dependency unavailable",
    async (mode) => {
      const { registry, simulator } = await harness();
      simulator.configureFault({
        target: "charging.create_reservation",
        mode,
        probability: 1,
        delayMs: 0,
      });
      await expect(
        execute(registry, "reserve_charging_slot", { stationId: "station-pudong-001" }),
      ).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
      expect(simulator.state().charging.reservations).toEqual([]);
    },
  );

  it("enforces the client timeout boundary against the real Simulator", async () => {
    const { client, simulator } = await harness();
    simulator.configureFault({
      target: "vehicle.get_state",
      mode: "timeout",
      probability: 1,
      delayMs: 50,
    });
    await expect(client.getVehicleState(5)).rejects.toMatchObject({
      code: "DEPENDENCY_TIMEOUT",
    });
  });

  it("executes all 14 formal tools in one deterministic end-to-end workflow", async () => {
    const { registry } = await harness();
    const calls: Array<[string, object]> = [
      ["get_vehicle_state", {}],
      ["get_trip_state", {}],
      ["get_weather", {}],
      ["search_charging_stations", {}],
      ["get_charging_status", {}],
      ["set_cabin_temperature", { temperatureC: 23 }],
      ["set_seat_heating", { seat: "front_passenger", level: 1 }],
      ["set_media_volume", { volume: 40 }],
      ["set_navigation_destination", { destination: "People's Square" }],
      ["reroute_to_charger", { stationId: "station-pudong-001" }],
      ["reserve_charging_slot", { stationId: "station-pudong-001" }],
      ["request_roadside_assistance", { reason: "diagnostic request" }],
      ["request_emergency_support", { reason: "development drill" }],
    ];
    const results = [];
    for (const [name, input] of calls) results.push(await execute(registry, name, input));
    const reservation = results[10] as { reservation: { id: string } };
    results.push(
      await execute(registry, "cancel_charging_reservation", {
        reservationId: reservation.reservation.id,
      }),
    );
    expect(results).toHaveLength(14);
    expect(results.every((result) => result !== undefined)).toBe(true);
  });
});
