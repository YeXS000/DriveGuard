import {
  CAPABILITY_NAMES,
  SERVICE_NAMES,
  type CapabilityName,
  type ServiceName,
} from "@driveguard/capabilities";
import {
  CONTEXT_RELEVANT_PATHS,
  type ContextRelevantPath,
  type FreshnessRequirement,
} from "@driveguard/context";
import { FORMAL_TOOL_NAMES, type FormalToolName, type ToolRiskLevel } from "@driveguard/tools";

export type ContextRequirement = "STATE_REFRESH" | "LATEST_REQUIRED";

export interface ToolPolicyProfile {
  readonly toolName: FormalToolName;
  readonly riskLevel: ToolRiskLevel;
  readonly sideEffect: boolean;
  readonly contextRequirement: ContextRequirement;
  readonly freshnessRequirement: FreshnessRequirement;
  readonly relevantContextPaths: readonly ContextRelevantPath[];
  readonly confirmationRequired: boolean;
  readonly requiredCapabilities: readonly CapabilityName[];
  readonly requiredServices: readonly ServiceName[];
}

export class ToolPolicyProfileError extends Error {
  readonly code = "INVALID_TOOL_POLICY_PROFILE" as const;

  constructor(message: string) {
    super(message);
    this.name = "ToolPolicyProfileError";
  }
}

const formalNames = new Set<string>(FORMAL_TOOL_NAMES);
const contextPaths = new Set<string>(CONTEXT_RELEVANT_PATHS);
const capabilityNames = new Set<string>(CAPABILITY_NAMES);
const serviceNames = new Set<string>(SERVICE_NAMES);

function uniqueKnown(values: readonly string[], known: ReadonlySet<string>): boolean {
  return (
    Array.isArray(values) &&
    values.every((value) => typeof value === "string" && known.has(value)) &&
    new Set(values).size === values.length
  );
}

function freezeProfile(profile: ToolPolicyProfile): ToolPolicyProfile {
  return Object.freeze({
    ...profile,
    freshnessRequirement: Object.freeze({ ...profile.freshnessRequirement }),
    relevantContextPaths: Object.freeze([...profile.relevantContextPaths]),
    requiredCapabilities: Object.freeze([...profile.requiredCapabilities]),
    requiredServices: Object.freeze([...profile.requiredServices]),
  });
}

function validateProfile(profile: ToolPolicyProfile): void {
  if (!formalNames.has(profile.toolName)) {
    throw new ToolPolicyProfileError("Policy profile Tool name is not formal");
  }
  if (!(["R0", "R1", "R2", "R3"] as const).includes(profile.riskLevel)) {
    throw new ToolPolicyProfileError("Policy profile risk is invalid");
  }
  if (typeof profile.sideEffect !== "boolean") {
    throw new ToolPolicyProfileError("Policy profile sideEffect is invalid");
  }
  if (
    profile.contextRequirement !== "STATE_REFRESH" &&
    profile.contextRequirement !== "LATEST_REQUIRED"
  ) {
    throw new ToolPolicyProfileError("Policy profile Context requirement is invalid");
  }
  if (
    !Number.isSafeInteger(profile.freshnessRequirement.maxAgeMs) ||
    profile.freshnessRequirement.maxAgeMs < 0 ||
    typeof profile.freshnessRequirement.requiresLatest !== "boolean"
  ) {
    throw new ToolPolicyProfileError("Policy profile freshness requirement is invalid");
  }
  if (!uniqueKnown(profile.relevantContextPaths, contextPaths)) {
    throw new ToolPolicyProfileError("Policy profile contains an unknown Context path");
  }
  if (!uniqueKnown(profile.requiredCapabilities, capabilityNames)) {
    throw new ToolPolicyProfileError("Policy profile capability requirement is invalid");
  }
  if (!uniqueKnown(profile.requiredServices, serviceNames)) {
    throw new ToolPolicyProfileError("Policy profile service requirement is invalid");
  }
  if (typeof profile.confirmationRequired !== "boolean") {
    throw new ToolPolicyProfileError("Policy profile confirmation flag is invalid");
  }
  const expectedConfirmation = profile.riskLevel === "R2" || profile.riskLevel === "R3";
  if (profile.confirmationRequired !== expectedConfirmation) {
    throw new ToolPolicyProfileError("Policy profile confirmation flag contradicts risk");
  }
  if (profile.sideEffect !== (profile.riskLevel !== "R0")) {
    throw new ToolPolicyProfileError("Policy profile side-effect flag contradicts risk");
  }
  if (
    profile.contextRequirement === "STATE_REFRESH" &&
    (profile.sideEffect || profile.riskLevel !== "R0")
  ) {
    throw new ToolPolicyProfileError("Only R0 reads may refresh stale state");
  }
}

export class ToolPolicyProfileRegistry {
  readonly #profiles = new Map<FormalToolName, ToolPolicyProfile>();

  constructor(profiles: readonly ToolPolicyProfile[]) {
    for (const profile of profiles) {
      validateProfile(profile);
      if (this.#profiles.has(profile.toolName)) {
        throw new ToolPolicyProfileError("Duplicate Tool policy profile");
      }
      this.#profiles.set(profile.toolName, freezeProfile(profile));
    }
  }

  get(toolName: string): ToolPolicyProfile | undefined {
    return this.#profiles.get(toolName as FormalToolName);
  }

  list(): readonly ToolPolicyProfile[] {
    return Object.freeze(
      FORMAL_TOOL_NAMES.flatMap((name) => {
        const profile = this.#profiles.get(name);
        return profile === undefined ? [] : [profile];
      }),
    );
  }
}

const readFreshness = Object.freeze({ maxAgeMs: 5_000, requiresLatest: false });
const lowRiskFreshness = Object.freeze({ maxAgeMs: 2_000, requiresLatest: true });
const sensitiveFreshness = Object.freeze({ maxAgeMs: 5_000, requiresLatest: true });

function profile(
  toolName: FormalToolName,
  riskLevel: ToolRiskLevel,
  requiredCapabilities: readonly CapabilityName[],
  requiredServices: readonly ServiceName[],
  relevantContextPaths: readonly ContextRelevantPath[],
): ToolPolicyProfile {
  const sideEffect = riskLevel !== "R0";
  return {
    toolName,
    riskLevel,
    sideEffect,
    contextRequirement: sideEffect ? "LATEST_REQUIRED" : "STATE_REFRESH",
    freshnessRequirement:
      riskLevel === "R0"
        ? readFreshness
        : riskLevel === "R1"
          ? lowRiskFreshness
          : sensitiveFreshness,
    relevantContextPaths,
    confirmationRequired: riskLevel === "R2" || riskLevel === "R3",
    requiredCapabilities,
    requiredServices,
  };
}

export const TOOL_POLICY_PROFILES = Object.freeze([
  profile("get_vehicle_state", "R0", [], ["vehicleSimulator"], []),
  profile("get_trip_state", "R0", ["navigation"], ["vehicleSimulator"], []),
  profile("get_weather", "R0", [], ["weather"], []),
  profile("search_charging_stations", "R0", ["charging"], ["vehicleSimulator"], []),
  profile("get_charging_status", "R0", ["charging"], ["vehicleSimulator"], []),
  profile(
    "set_cabin_temperature",
    "R1",
    ["cabinTemperature"],
    ["vehicleSimulator"],
    ["vehicle.cabinTemperature", "vehicle.occupants", "capabilities.cabinTemperature"],
  ),
  profile(
    "set_seat_heating",
    "R1",
    ["seatHeating"],
    ["vehicleSimulator"],
    ["vehicle.occupants", "capabilities.seatHeating"],
  ),
  profile("set_media_volume", "R1", ["media"], ["vehicleSimulator"], ["capabilities.media"]),
  profile(
    "set_navigation_destination",
    "R2",
    ["navigation"],
    ["vehicleSimulator"],
    [
      "vehicle.speedKph",
      "vehicle.gear",
      "vehicle.driveMode",
      "trip.destination",
      "trip.routeId",
      "trip.navigationActive",
      "capabilities.navigation",
    ],
  ),
  profile(
    "reroute_to_charger",
    "R2",
    ["navigation", "charging"],
    ["vehicleSimulator"],
    [
      "vehicle.soc",
      "vehicle.estimatedRangeKm",
      "vehicle.latitude",
      "vehicle.longitude",
      "trip.destination",
      "trip.routeId",
      "trip.navigationActive",
      "capabilities.navigation",
      "capabilities.charging",
    ],
  ),
  profile(
    "reserve_charging_slot",
    "R2",
    ["charging"],
    ["vehicleSimulator"],
    [
      "vehicle.soc",
      "vehicle.chargingState",
      "vehicle.latitude",
      "vehicle.longitude",
      "capabilities.charging",
    ],
  ),
  profile(
    "cancel_charging_reservation",
    "R2",
    ["charging"],
    ["vehicleSimulator"],
    ["vehicle.chargingState", "capabilities.charging"],
  ),
  profile(
    "request_roadside_assistance",
    "R3",
    ["roadsideAssistance"],
    ["vehicleSimulator"],
    [
      "vehicle.speedKph",
      "vehicle.gear",
      "vehicle.driveMode",
      "vehicle.latitude",
      "vehicle.longitude",
      "capabilities.roadsideAssistance",
    ],
  ),
  profile(
    "request_emergency_support",
    "R3",
    ["roadsideAssistance"],
    ["emergencySupport"],
    [
      "vehicle.speedKph",
      "vehicle.gear",
      "vehicle.driveMode",
      "vehicle.latitude",
      "vehicle.longitude",
      "capabilities.roadsideAssistance",
    ],
  ),
]);

export function createDefaultToolPolicyProfileRegistry(): ToolPolicyProfileRegistry {
  return new ToolPolicyProfileRegistry(TOOL_POLICY_PROFILES);
}
