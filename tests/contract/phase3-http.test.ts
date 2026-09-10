import { FixedClock } from "@driveguard/shared";
import {
  buildVehicleSimulator,
  VehicleSimulator,
  type FaultMode,
  type FaultTarget,
} from "@driveguard/vehicle-simulator";
import { afterEach, describe, expect, it } from "vitest";

const NOW_MS = Date.parse("2026-08-26T08:00:00.000Z");
const applications: ReturnType<typeof buildVehicleSimulator>[] = [];

function createApi(seed = 12345) {
  const simulator = new VehicleSimulator({ clock: new FixedClock(NOW_MS), seed });
  const app = buildVehicleSimulator({ simulator });
  applications.push(app);
  return { app, simulator };
}

async function configureFault(
  app: ReturnType<typeof buildVehicleSimulator>,
  target: FaultTarget,
  mode: FaultMode,
  probability = 1,
  delayMs = 0,
) {
  return app.inject({
    method: "POST",
    url: "/simulator/faults",
    payload: { target, mode, probability, delayMs },
  });
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map(async (application) => application.close()));
});

describe("Phase 3 health and data-plane HTTP contract", () => {
  it.each([
    ["/health/live", { status: "ok" }],
    ["/health/ready", { status: "ready" }],
  ] as const)("GET %s returns independent healthy status", async (url, body) => {
    const { app } = createApi();
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(body);
  });

  it("GET /vehicle/state returns the Phase 2 domain shape", async () => {
    const { app } = createApi();
    const response = await app.inject({ method: "GET", url: "/vehicle/state" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      vehicleId: "simulator-vehicle-001",
      version: 1,
      soc: 72,
    });
  });

  it("GET /trip/state returns inactive navigation", async () => {
    const { app } = createApi();
    const response = await app.inject({ method: "GET", url: "/trip/state" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: 1,
      destination: null,
      routeId: null,
      navigationActive: false,
    });
  });

  it("GET /context/state atomically returns vehicle, trip, and simulator generation", async () => {
    const { app, simulator } = createApi();
    const response = await app.inject({ method: "GET", url: "/context/state" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      vehicle: simulator.state().vehicle,
      trip: simulator.state().trip,
      simulationVersion: simulator.state().simulationVersion,
    });
  });

  it.each([
    ["/cabin/temperature", { temperatureC: 24 }, "cabinTemperature", 24],
    ["/media/volume", { volume: 65 }, "volume", 65],
  ] as const)("POST %s mutates and returns %s", async (url, payload, key, value) => {
    const { app } = createApi();
    const response = await app.inject({ method: "POST", url, payload });
    expect(response.statusCode).toBe(200);
    expect(response.json<Record<string, number>>()[key]).toBe(value);
  });

  it.each([
    ["driver", 0],
    ["driver", 3],
    ["front_passenger", 1],
    ["front_passenger", 2],
  ] as const)("POST /cabin/seat-heating accepts %s level %s", async (seat, level) => {
    const { app } = createApi();
    const response = await app.inject({
      method: "POST",
      url: "/cabin/seat-heating",
      payload: { seat, level },
    });
    expect(response.statusCode).toBe(200);
    expect(
      response.json<{ seatHeating: Record<"driver" | "front_passenger", number> }>().seatHeating[
        seat
      ],
    ).toBe(level);
  });

  it("sets and reroutes navigation", async () => {
    const { app } = createApi();
    const destination = await app.inject({
      method: "POST",
      url: "/navigation/destination",
      payload: { destination: "The Bund" },
    });
    const routeId = destination.json<{ routeId: string }>().routeId;
    expect(destination.statusCode).toBe(200);
    expect(destination.json()).toMatchObject({ destination: "The Bund", navigationActive: true });
    const rerouted = await app.inject({ method: "POST", url: "/navigation/reroute" });
    expect(rerouted.statusCode).toBe(200);
    expect(rerouted.json<{ routeId: string }>().routeId).not.toBe(routeId);
  });

  it("lists charging stations and status", async () => {
    const { app } = createApi();
    const stations = await app.inject({ method: "GET", url: "/charging/stations" });
    const status = await app.inject({ method: "GET", url: "/charging/status" });
    expect(stations.statusCode).toBe(200);
    expect(stations.json<{ stations: readonly unknown[] }>().stations).toHaveLength(3);
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ chargingState: "not_charging", reservations: [] });
  });

  it("creates and cancels a charging reservation", async () => {
    const { app } = createApi();
    const created = await app.inject({
      method: "POST",
      url: "/charging/reservations",
      payload: { stationId: "station-pudong-001" },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ reservation: { id: string } }>().reservation.id;
    const cancelled = await app.inject({
      method: "DELETE",
      url: `/charging/reservations/${id}`,
    });
    expect(cancelled.statusCode).toBe(204);
  });

  it("creates a roadside assistance request", async () => {
    const { app } = createApi();
    const response = await app.inject({
      method: "POST",
      url: "/assistance/roadside",
      payload: { reason: "flat tire" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json<{ request: unknown }>().request).toMatchObject({
      reason: "flat tire",
      status: "requested",
    });
  });
});

describe("Phase 3 control-plane and structured error contract", () => {
  it("GET /simulator/state exposes complete control state", async () => {
    const { app } = createApi();
    const response = await app.inject({ method: "GET", url: "/simulator/state" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      scenario: "city_idle",
      seed: 12345,
      simulationVersion: 1,
      cabin: { mediaVolume: 35 },
      charging: { reservations: [] },
      assistance: { requests: [] },
    });
  });

  it("POST /simulator/reset loads a deterministic scenario", async () => {
    const { app } = createApi();
    const first = await app.inject({
      method: "POST",
      url: "/simulator/reset",
      payload: { scenario: "low_soc", seed: 7 },
    });
    const second = await app.inject({
      method: "POST",
      url: "/simulator/reset",
      payload: { scenario: "low_soc", seed: 7 },
    });
    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(first.json<{ vehicle: { soc: number } }>().vehicle.soc).toBe(8);
  });

  it.each([
    ["/simulator/vehicle/speed", { speedKph: 80 }, "speedKph", 80],
    ["/simulator/vehicle/soc", { soc: 15 }, "soc", 15],
  ] as const)("POST %s provides deterministic test control", async (url, payload, key, value) => {
    const { app } = createApi();
    const response = await app.inject({ method: "POST", url, payload });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ vehicle: Record<string, number> }>().vehicle[key]).toBe(value);
  });

  it("creates, lists, and clears fault configuration", async () => {
    const { app } = createApi();
    const created = await configureFault(app, "vehicle.get_state", "http_503");
    expect(created.statusCode).toBe(201);
    expect(created.json<{ fault: unknown }>().fault).toMatchObject({
      target: "vehicle.get_state",
      mode: "http_503",
      probability: 1,
    });
    const listed = await app.inject({ method: "GET", url: "/simulator/faults" });
    expect(listed.json<{ faults: readonly unknown[] }>().faults).toHaveLength(1);
    const cleared = await app.inject({ method: "DELETE", url: "/simulator/faults" });
    expect(cleared.statusCode).toBe(204);
  });

  it.each([
    ["/simulator/reset", { scenario: "missing", seed: 1 }, 404, "SCENARIO_NOT_FOUND"],
    ["/navigation/reroute", undefined, 409, "INVALID_TRANSITION"],
    ["/charging/reservations", { stationId: "missing" }, 404, "STATION_NOT_FOUND"],
    ["/charging/reservations", { stationId: "station-empty-003" }, 409, "NO_AVAILABLE_SLOT"],
    ["/charging/reservations/missing", undefined, 404, "RESERVATION_NOT_FOUND"],
  ] as const)("returns structured %s for %s", async (url, payload, status, code) => {
    const { app } = createApi();
    const method = url.includes("reservations/missing") ? "DELETE" : "POST";
    const response = await app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload }),
    });
    expect(response.statusCode).toBe(status);
    const body = response.json<{ error: { code: string; message: unknown } }>();
    expect(body.error.code).toBe(code);
    expect(typeof body.error.message).toBe("string");
    expect(response.body).not.toMatch(/stack|\/home\/|api_key/iu);
  });

  it.each([
    ["/cabin/temperature", []],
    ["/cabin/temperature", { temperatureC: "22" }],
    ["/cabin/temperature", { temperatureC: 22, extra: true }],
    ["/cabin/seat-heating", { seat: "rear", level: 1 }],
    ["/cabin/seat-heating", { seat: "driver", level: 4 }],
    ["/media/volume", { volume: Number.NaN }],
    ["/navigation/destination", { destination: "   " }],
    ["/charging/reservations", {}],
    ["/assistance/roadside", { reason: "" }],
    ["/simulator/vehicle/soc", { soc: "10" }],
  ] as const)("rejects invalid boundary input for %s", async (url, payload) => {
    const { app } = createApi();
    const response = await app.inject({ method: "POST", url, payload });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
  });

  it.each([
    ["GET", "/does-not-exist", undefined, 404],
    ["POST", "/vehicle/state", undefined, 404],
    ["POST", "/cabin/temperature", "<xml />", 415],
  ] as const)("normalizes HTTP %s %s errors", async (method, url, payload, statusCode) => {
    const { app } = createApi();
    const response = await app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload, headers: { "content-type": "application/xml" } }),
    });
    expect(response.statusCode).toBe(statusCode);
    expect(response.json<{ error: { code: string; message: string } }>()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
    expect(response.body).not.toMatch(/stack|statusCode/iu);
  });

  it("normalizes an oversized request body", async () => {
    const { app } = createApi();
    const response = await app.inject({
      method: "POST",
      url: "/assistance/roadside",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ reason: "x".repeat(1_100_000) }),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
  });
});

describe("Phase 3 HTTP fault behavior", () => {
  it.each([
    ["http_500", 500],
    ["http_503", 503],
    ["timeout", 504],
  ] as const)("injects %s as a structured failure", async (mode, statusCode) => {
    const { app } = createApi();
    await configureFault(app, "charging.create_reservation", mode, 1, 1);
    const response = await app.inject({
      method: "POST",
      url: "/charging/reservations",
      payload: { stationId: "station-pudong-001" },
    });
    expect(response.statusCode).toBe(statusCode);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("FAULT_INJECTED");
    const state = await app.inject({ method: "GET", url: "/simulator/state" });
    expect(
      state.json<{ charging: { reservations: readonly unknown[] } }>().charging.reservations,
    ).toHaveLength(0);
  });

  it("delays and then completes the targeted operation", async () => {
    const { app } = createApi();
    await configureFault(app, "vehicle.get_state", "delay", 1, 10);
    const started = performance.now();
    const response = await app.inject({ method: "GET", url: "/vehicle/state" });
    expect(response.statusCode).toBe(200);
    expect(performance.now() - started).toBeGreaterThanOrEqual(8);
  });

  it("returns a real validated prior state without mutating current", async () => {
    const { app } = createApi();
    await app.inject({
      method: "POST",
      url: "/simulator/vehicle/soc",
      payload: { soc: 50 },
    });
    await configureFault(app, "vehicle.get_state", "stale_response");
    const stale = await app.inject({ method: "GET", url: "/vehicle/state" });
    expect(stale.json()).toMatchObject({ version: 1, soc: 72 });
    await app.inject({ method: "DELETE", url: "/simulator/faults" });
    const current = await app.inject({ method: "GET", url: "/vehicle/state" });
    expect(current.json()).toMatchObject({ version: 2, soc: 50 });
  });

  it("probability zero leaves the target unaffected", async () => {
    const { app } = createApi();
    await configureFault(app, "vehicle.get_state", "http_500", 0);
    expect((await app.inject({ method: "GET", url: "/vehicle/state" })).statusCode).toBe(200);
  });

  it("a targeted vehicle fault leaves unrelated trip reads unaffected", async () => {
    const { app } = createApi();
    await configureFault(app, "vehicle.get_state", "http_503");
    expect((await app.inject({ method: "GET", url: "/trip/state" })).statusCode).toBe(200);
  });

  it("reset clears an injected fault", async () => {
    const { app } = createApi();
    await configureFault(app, "vehicle.get_state", "http_503");
    await app.inject({
      method: "POST",
      url: "/simulator/reset",
      payload: { scenario: "city_idle", seed: 12345 },
    });
    expect((await app.inject({ method: "GET", url: "/vehicle/state" })).statusCode).toBe(200);
  });

  it("reset invalidates a delayed in-flight mutation", async () => {
    const { app } = createApi();
    await configureFault(app, "charging.create_reservation", "delay", 1, 30);
    const delayed = app.inject({
      method: "POST",
      url: "/charging/reservations",
      payload: { stationId: "station-pudong-001" },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const reset = await app.inject({
      method: "POST",
      url: "/simulator/reset",
      payload: { scenario: "city_idle", seed: 12345 },
    });
    expect(reset.statusCode).toBe(200);
    const delayedResponse = await delayed;
    expect(delayedResponse.statusCode).toBe(409);
    expect(delayedResponse.json<{ error: { code: string } }>().error.code).toBe(
      "INVALID_TRANSITION",
    );
    const state = await app.inject({ method: "GET", url: "/simulator/state" });
    expect(
      state.json<{ simulationVersion: number; charging: { reservations: readonly unknown[] } }>(),
    ).toMatchObject({ simulationVersion: 1, charging: { reservations: [] } });
  });
});
