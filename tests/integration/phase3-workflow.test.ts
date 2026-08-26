import { FixedClock } from "@driveguard/shared";
import { buildVehicleSimulator, VehicleSimulator } from "@driveguard/vehicle-simulator";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

const NOW_MS = Date.parse("2026-08-26T08:00:00.000Z");
const applications: ReturnType<typeof buildVehicleSimulator>[] = [];

function createApi() {
  const simulator = new VehicleSimulator({ clock: new FixedClock(NOW_MS), seed: 12345 });
  const app = buildVehicleSimulator({ simulator });
  applications.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map(async (application) => application.close()));
});

describe("Phase 3 integration workflows", () => {
  it("runs reset -> vehicle -> navigation -> cabin -> charging -> simulator state", async () => {
    const app = createApi();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/simulator/reset",
          payload: { scenario: "city_idle", seed: 12345 },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/vehicle/state" })).json<{ soc: number }>().soc,
    ).toBe(72);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/navigation/destination",
          payload: { destination: "The Bund" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/cabin/temperature",
          payload: { temperatureC: 24 },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/charging/reservations",
          payload: { stationId: "station-pudong-001" },
        })
      ).statusCode,
    ).toBe(201);
    const state = (await app.inject({ method: "GET", url: "/simulator/state" })).json<unknown>();
    expect(state).toMatchObject({
      simulationVersion: 4,
      vehicle: { version: 2, cabinTemperature: 24 },
      trip: { version: 2, destination: "The Bund", navigationActive: true },
      charging: { reservations: [{ stationId: "station-pudong-001" }] },
    });
  });

  it("runs inject 503 -> charging fails -> clear -> charging succeeds", async () => {
    const app = createApi();
    await app.inject({
      method: "POST",
      url: "/simulator/faults",
      payload: {
        target: "charging.create_reservation",
        mode: "http_503",
        probability: 1,
        delayMs: 0,
      },
    });
    const failed = await app.inject({
      method: "POST",
      url: "/charging/reservations",
      payload: { stationId: "station-pudong-001" },
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.json<{ error: { code: string } }>().error.code).toBe("FAULT_INJECTED");
    await app.inject({ method: "DELETE", url: "/simulator/faults" });
    const succeeded = await app.inject({
      method: "POST",
      url: "/charging/reservations",
      payload: { stationId: "station-pudong-001" },
    });
    expect(succeeded.statusCode).toBe(201);
    expect(succeeded.json<{ reservation: { id: string } }>().reservation.id).toBe(
      "reservation-00003039-000001",
    );
  });

  it("aborts a real HTTP connection for connection_abort", async () => {
    const app = createApi();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    await app.inject({
      method: "POST",
      url: "/simulator/faults",
      payload: {
        target: "vehicle.get_state",
        mode: "connection_abort",
        probability: 1,
        delayMs: 0,
      },
    });
    await expect(fetch(`http://127.0.0.1:${address.port}/vehicle/state`)).rejects.toThrow();
  });
});
