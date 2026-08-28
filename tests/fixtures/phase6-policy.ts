import type { CapabilityResolutionContext } from "@driveguard/capabilities";
import {
  ContextConflictDetector,
  type ContextConflictResult,
  type ContextFreshnessResult,
} from "@driveguard/context";
import { parseDrivingContext, type ContextSnapshot } from "@driveguard/domain";
import {
  createDefaultToolPolicyProfileRegistry,
  type PolicyEvaluationInput,
} from "@driveguard/policy";
import type { FormalToolName } from "@driveguard/tools";

import { createValidSnapshot, PHASE_2_NOW } from "./phase2-domain.js";
import { FULL_CAPABILITY_CONTEXT, createOfflineRegistry } from "./phase4-tools.js";

export const PHASE6_EVALUATED_AT = PHASE_2_NOW;

export const PHASE6_VALID_ARGUMENTS: Readonly<Record<FormalToolName, object>> = Object.freeze({
  get_vehicle_state: {},
  get_trip_state: {},
  get_weather: {},
  search_charging_stations: {},
  get_charging_status: {},
  set_cabin_temperature: { temperatureC: 23 },
  set_seat_heating: { seat: "driver", level: 2 },
  set_media_volume: { volume: 50 },
  set_navigation_destination: { destination: "The Bund" },
  reroute_to_charger: { stationId: "station-pudong-001" },
  reserve_charging_slot: { stationId: "station-pudong-001" },
  cancel_charging_reservation: { reservationId: "reservation-001" },
  request_roadside_assistance: { reason: "flat tire" },
  request_emergency_support: { reason: "medical support" },
});

export function fresh(
  snapshot: ContextSnapshot,
  maxAgeMs = 5_000,
  requiresLatest = true,
): ContextFreshnessResult {
  return {
    status: "FRESH",
    ageMs: 0,
    maxAgeMs,
    snapshotVersion: snapshot.contextVersion,
    ...(requiresLatest ? { latestVersion: snapshot.contextVersion } : {}),
  };
}

export function policyInput(
  toolName: FormalToolName,
  overrides: Partial<PolicyEvaluationInput> = {},
): PolicyEvaluationInput {
  const snapshot = createValidSnapshot();
  const definition = createOfflineRegistry().get(toolName);
  const profile = createDefaultToolPolicyProfileRegistry().get(toolName);
  if (definition === undefined) throw new Error(`Missing fixture Tool ${toolName}`);
  if (profile === undefined) throw new Error(`Missing fixture Policy profile ${toolName}`);
  return {
    toolDefinition: definition,
    validatedArguments: PHASE6_VALID_ARGUMENTS[toolName],
    trustedDefinition: true,
    contextSnapshot: snapshot,
    freshness: fresh(
      snapshot,
      profile.freshnessRequirement.maxAgeMs,
      profile.freshnessRequirement.requiresLatest,
    ),
    availability: FULL_CAPABILITY_CONTEXT,
    ...overrides,
  };
}

export function availabilityWith(
  capabilities: Partial<CapabilityResolutionContext["capabilities"]> = {},
  services: Partial<CapabilityResolutionContext["services"]> = {},
): CapabilityResolutionContext {
  return {
    capabilities: { ...FULL_CAPABILITY_CONTEXT.capabilities, ...capabilities },
    services: { ...FULL_CAPABILITY_CONTEXT.services, ...services },
  };
}

export function nextSnapshot(
  planning: ContextSnapshot,
  mutate: (candidate: Record<string, unknown>) => void,
): ContextSnapshot {
  const candidate = structuredClone(planning) as unknown as Record<string, unknown>;
  candidate.snapshotId = `${planning.snapshotId}-next`;
  candidate.contextVersion = planning.contextVersion + 1;
  mutate(candidate);
  return parseDrivingContext(candidate, { nowMs: Date.parse(planning.capturedAt) });
}

export function conflict(
  planning: ContextSnapshot,
  execution: ContextSnapshot,
  paths: readonly string[],
): ContextConflictResult {
  return new ContextConflictDetector().detect(planning, execution, paths);
}
