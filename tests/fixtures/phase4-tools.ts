import type { CapabilityResolutionContext } from "@driveguard/capabilities";
import { FixedClock } from "@driveguard/shared";
import {
  createDriveGuardToolRegistry,
  DevelopmentEmergencySupportProvider,
  DevelopmentWeatherProvider,
  SimulatorClient,
} from "@driveguard/tools";
import { buildVehicleSimulator, VehicleSimulator } from "@driveguard/vehicle-simulator";
import type { AddressInfo } from "node:net";

export const PHASE4_NOW_MS = Date.parse("2026-08-27T08:00:00.000Z");

export const FULL_CAPABILITY_CONTEXT: CapabilityResolutionContext = Object.freeze({
  capabilities: Object.freeze({
    navigation: true,
    charging: true,
    cabinTemperature: true,
    seatHeating: true,
    media: true,
    roadsideAssistance: true,
  }),
  services: Object.freeze({
    vehicleSimulator: true,
    weather: true,
    emergencySupport: true,
  }),
});

export function contextWith(
  capabilities: Partial<CapabilityResolutionContext["capabilities"]> = {},
  services: Partial<CapabilityResolutionContext["services"]> = {},
): CapabilityResolutionContext {
  return {
    capabilities: { ...FULL_CAPABILITY_CONTEXT.capabilities, ...capabilities },
    services: { ...FULL_CAPABILITY_CONTEXT.services, ...services },
  };
}

export function createOfflineRegistry() {
  return createDriveGuardToolRegistry({
    simulator: new SimulatorClient({ baseUrl: "http://127.0.0.1:1", defaultTimeoutMs: 10 }),
    weatherProvider: new DevelopmentWeatherProvider(),
    emergencySupportProvider: new DevelopmentEmergencySupportProvider(),
  });
}

export async function createPhase4Harness() {
  const simulator = new VehicleSimulator({
    clock: new FixedClock(PHASE4_NOW_MS),
    seed: 12345,
  });
  const app = buildVehicleSimulator({ simulator });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as AddressInfo;
  const client = new SimulatorClient({ baseUrl: `http://127.0.0.1:${address.port}` });
  const registry = createDriveGuardToolRegistry({
    simulator: client,
    weatherProvider: new DevelopmentWeatherProvider({ condition: "clear", temperatureC: 26 }),
    emergencySupportProvider: new DevelopmentEmergencySupportProvider("phase4-emergency"),
  });
  return { app, simulator, client, registry };
}
