import { FixedClock } from "@driveguard/shared";
import {
  buildVehicleSimulator,
  VehicleSimulator,
  VehicleSimulatorFleet,
} from "@driveguard/vehicle-simulator";
import { SimulatorClient } from "@driveguard/tools";
import { afterEach, describe, expect, it } from "vitest";

const applications: ReturnType<typeof buildVehicleSimulator>[] = [];
const now = Date.parse("2026-09-09T08:00:00.000Z");

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.close()));
});

async function harness() {
  const fleet = new VehicleSimulatorFleet({
    defaultSimulator: new VehicleSimulator({ clock: new FixedClock(now) }),
    createSimulator: (vehicleId) => new VehicleSimulator({ clock: new FixedClock(now), vehicleId }),
  });
  const app = buildVehicleSimulator({ fleet });
  applications.push(app);
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, baseUrl, fleet };
}

describe("Phase 15.1 independent vehicle routing", () => {
  it("isolates reads and writes for independent vehicle identities", async () => {
    const { baseUrl, fleet } = await harness();
    const first = new SimulatorClient({ baseUrl, vehicleId: "vehicle:alpha" });
    const second = new SimulatorClient({ baseUrl, vehicleId: "vehicle:beta" });

    await first.setMediaVolume(11);
    await second.setMediaVolume(77);

    expect((await first.getVehicleState()).vehicleId).toBe("vehicle:alpha");
    expect((await second.getVehicleState()).vehicleId).toBe("vehicle:beta");
    expect((await first.setMediaVolume(12)).volume).toBe(12);
    expect((await second.setMediaVolume(78)).volume).toBe(78);
    expect(fleet.size).toBe(3);
  });

  it("shares state only when sessions intentionally use the same vehicle", async () => {
    const { baseUrl } = await harness();
    const firstSession = new SimulatorClient({ baseUrl, vehicleId: "vehicle:shared" });
    const secondSession = new SimulatorClient({ baseUrl, vehicleId: "vehicle:shared" });

    await firstSession.setMediaVolume(64);
    expect((await secondSession.setMediaVolume(65)).volume).toBe(65);
    expect((await secondSession.getVehicleState()).vehicleId).toBe("vehicle:shared");
  });

  it("scopes idempotency receipts by vehicle and rejects invalid routing headers", async () => {
    const { app } = await harness();
    const request = (vehicleId: string, stationId: string) =>
      app.inject({
        method: "POST",
        url: "/charging/reservations",
        headers: { "x-driveguard-vehicle-id": vehicleId, "idempotency-key": "same-key" },
        payload: { stationId },
      });

    expect((await request("vehicle:one", "station-pudong-001")).statusCode).toBe(201);
    expect((await request("vehicle:two", "station-hongqiao-002")).statusCode).toBe(201);
    const invalid = await app.inject({
      method: "GET",
      url: "/vehicle/state",
      headers: { "x-driveguard-vehicle-id": "bad vehicle" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  it("fails closed instead of evicting vehicle state when fleet capacity is exhausted", () => {
    const fleet = new VehicleSimulatorFleet({ maxVehicles: 2 });
    fleet.resolve("vehicle:one");

    expect(() => fleet.resolve("vehicle:two")).toThrowError(
      expect.objectContaining({ code: "INTERNAL_ERROR", statusCode: 503 }),
    );
    expect(fleet.size).toBe(2);
  });
});
