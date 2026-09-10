import { CAPABILITY_NAMES, parseCapabilityResolutionContext } from "@driveguard/capabilities";
import {
  FORMAL_TOOL_NAMES,
  DevelopmentEmergencySupportProvider,
  DevelopmentWeatherProvider,
  SimulatorClient,
  createDriveGuardToolRegistry,
} from "@driveguard/tools";

const context = parseCapabilityResolutionContext({
  capabilities: Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, true])),
  services: { vehicleSimulator: true, weather: true, emergencySupport: true },
});
const registry = createDriveGuardToolRegistry({
  simulator: new SimulatorClient({ baseUrl: "http://127.0.0.1:1", defaultTimeoutMs: 10 }),
  weatherProvider: new DevelopmentWeatherProvider(),
  emergencySupportProvider: new DevelopmentEmergencySupportProvider(),
});

if (registry.resolve(context).length !== 14 || FORMAL_TOOL_NAMES.length !== 14) {
  throw new Error("Phase 4 public package export smoke failed");
}
