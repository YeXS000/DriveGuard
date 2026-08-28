import type { CapabilityResolutionContext } from "@driveguard/capabilities";
import {
  createDefaultToolPolicyProfileRegistry,
  type PolicyDecisionType,
  type PolicyEvaluationInput,
} from "@driveguard/policy";
import type { FormalToolName, ToolRiskLevel } from "@driveguard/tools";

import { availabilityWith, policyInput } from "./phase6-policy.js";

export interface PolicyMatrixCase {
  readonly id: string;
  readonly tool: FormalToolName;
  readonly risk: ToolRiskLevel;
  readonly contextCondition: "FRESH" | "STALE" | "NOT_LATEST" | "INVALID_FUTURE_TIMESTAMP";
  readonly capabilityState: "AVAILABLE" | "CAPABILITY_UNAVAILABLE" | "SERVICE_UNAVAILABLE";
  readonly expectedDecision: PolicyDecisionType;
  readonly expectedRuleId: string;
}

const normalSource = [
  ["get_vehicle_state", "R0", "ALLOW", "DG-POL-010"],
  ["get_trip_state", "R0", "ALLOW", "DG-POL-010"],
  ["get_weather", "R0", "ALLOW", "DG-POL-010"],
  ["search_charging_stations", "R0", "ALLOW", "DG-POL-010"],
  ["get_charging_status", "R0", "ALLOW", "DG-POL-010"],
  ["set_cabin_temperature", "R1", "ALLOW", "DG-POL-009"],
  ["set_seat_heating", "R1", "ALLOW", "DG-POL-009"],
  ["set_media_volume", "R1", "ALLOW", "DG-POL-009"],
  ["set_navigation_destination", "R2", "REQUIRE_CONFIRMATION", "DG-POL-008"],
  ["reroute_to_charger", "R2", "REQUIRE_CONFIRMATION", "DG-POL-008"],
  ["reserve_charging_slot", "R2", "REQUIRE_CONFIRMATION", "DG-POL-008"],
  ["cancel_charging_reservation", "R2", "REQUIRE_CONFIRMATION", "DG-POL-008"],
  ["request_roadside_assistance", "R3", "REQUIRE_CONFIRMATION", "DG-POL-007"],
  ["request_emergency_support", "R3", "REQUIRE_CONFIRMATION", "DG-POL-007"],
] as const;

const normalRows: readonly PolicyMatrixCase[] = normalSource.map(
  ([tool, risk, expectedDecision, expectedRuleId], index) => ({
    id: `NORMAL-${String(index + 1).padStart(2, "0")}`,
    tool,
    risk,
    contextCondition: "FRESH" as const,
    capabilityState: "AVAILABLE" as const,
    expectedDecision,
    expectedRuleId,
  }),
);

const boundaryRows: readonly PolicyMatrixCase[] = [
  {
    id: "CONTEXT-STALE-R1",
    tool: "set_media_volume",
    risk: "R1",
    contextCondition: "STALE",
    capabilityState: "AVAILABLE",
    expectedDecision: "REPLAN",
    expectedRuleId: "DG-POL-005",
  },
  {
    id: "CONTEXT-NOT-LATEST-R2",
    tool: "reserve_charging_slot",
    risk: "R2",
    contextCondition: "NOT_LATEST",
    capabilityState: "AVAILABLE",
    expectedDecision: "REPLAN",
    expectedRuleId: "DG-POL-005",
  },
  {
    id: "CONTEXT-FUTURE-R3",
    tool: "request_roadside_assistance",
    risk: "R3",
    contextCondition: "INVALID_FUTURE_TIMESTAMP",
    capabilityState: "AVAILABLE",
    expectedDecision: "DENY",
    expectedRuleId: "DG-POL-005",
  },
  {
    id: "REFRESH-STALE-R0",
    tool: "get_vehicle_state",
    risk: "R0",
    contextCondition: "STALE",
    capabilityState: "AVAILABLE",
    expectedDecision: "ALLOW",
    expectedRuleId: "DG-POL-010",
  },
  {
    id: "CAPABILITY-DENY-R1",
    tool: "set_media_volume",
    risk: "R1",
    contextCondition: "FRESH",
    capabilityState: "CAPABILITY_UNAVAILABLE",
    expectedDecision: "DENY",
    expectedRuleId: "DG-POL-003",
  },
  {
    id: "SERVICE-DENY-R2",
    tool: "reserve_charging_slot",
    risk: "R2",
    contextCondition: "FRESH",
    capabilityState: "SERVICE_UNAVAILABLE",
    expectedDecision: "DENY",
    expectedRuleId: "DG-POL-003",
  },
];

export const PHASE6_POLICY_MATRIX = Object.freeze([...normalRows, ...boundaryRows]);

export const GENERATED_POLICY_SCENARIOS = [
  "NORMAL",
  "STALE",
  "NOT_LATEST",
  "INVALID_FUTURE_TIMESTAMP",
  "REQUIREMENT_UNAVAILABLE",
  "SERVICE_UNAVAILABLE",
  "RELEVANT_CONFLICT",
  "IRRELEVANT_CONFLICT",
  "UNKNOWN_PATH",
  "INVALID_CONTEXT",
  "MALFORMED_INPUT",
] as const;

export interface GeneratedPolicyCase {
  readonly id: string;
  readonly tool: FormalToolName;
  readonly risk: ToolRiskLevel;
  readonly scenario: (typeof GENERATED_POLICY_SCENARIOS)[number];
  readonly contextCondition: string;
  readonly capabilityState: string;
  readonly expectedDecision: PolicyDecisionType;
  readonly expectedRuleId: string;
  readonly input: unknown;
}

const profiles = createDefaultToolPolicyProfileRegistry();

function riskDecision(risk: ToolRiskLevel): readonly [PolicyDecisionType, string] {
  if (risk === "R0") return ["ALLOW", "DG-POL-010"];
  if (risk === "R1") return ["ALLOW", "DG-POL-009"];
  if (risk === "R2") return ["REQUIRE_CONFIRMATION", "DG-POL-008"];
  return ["REQUIRE_CONFIRMATION", "DG-POL-007"];
}

export function generatedPolicyCase(index: number): GeneratedPolicyCase {
  const tool = normalSource[index % normalSource.length]![0];
  const profile = profiles.get(tool)!;
  const scenario =
    GENERATED_POLICY_SCENARIOS[
      Math.floor(index / normalSource.length) % GENERATED_POLICY_SCENARIOS.length
    ]!;
  const base = policyInput(tool);
  const contextVersion = (index + 2) as PolicyEvaluationInput["contextSnapshot"]["contextVersion"];
  const contextSnapshot = {
    ...base.contextSnapshot,
    snapshotId: `matrix-snapshot:${index + 1}`,
    contextVersion,
  } as PolicyEvaluationInput["contextSnapshot"];
  let freshness: PolicyEvaluationInput["freshness"] = {
    ...base.freshness,
    snapshotVersion: contextVersion,
    ...(profile.freshnessRequirement.requiresLatest ? { latestVersion: contextVersion } : {}),
  };
  let availability: CapabilityResolutionContext = {
    capabilities: { ...base.availability.capabilities },
    services: { ...base.availability.services },
  };
  let conflict: PolicyEvaluationInput["conflict"];
  let trustedDefinition = true;
  let contextValue: unknown = contextSnapshot;
  let expected = riskDecision(profile.riskLevel);

  if (scenario === "MALFORMED_INPUT") {
    trustedDefinition = false;
    expected = ["DENY", "DG-POL-002"];
  } else if (scenario === "REQUIREMENT_UNAVAILABLE") {
    const capability = profile.requiredCapabilities[0];
    if (capability === undefined) {
      const service = profile.requiredServices[0]!;
      availability = {
        ...availability,
        services: { ...availability.services, [service]: false },
      };
    } else {
      availability = {
        ...availability,
        capabilities: { ...availability.capabilities, [capability]: false },
      };
    }
    expected = ["DENY", "DG-POL-003"];
  } else if (scenario === "SERVICE_UNAVAILABLE") {
    const service = profile.requiredServices[0]!;
    availability = {
      ...availability,
      services: { ...availability.services, [service]: false },
    };
    expected = ["DENY", "DG-POL-003"];
  } else if (scenario === "INVALID_CONTEXT") {
    contextValue = {
      ...contextSnapshot,
      vehicle: { ...contextSnapshot.vehicle, soc: 101 },
    };
    expected = ["DENY", "DG-POL-004"];
  } else if (
    scenario === "STALE" ||
    scenario === "NOT_LATEST" ||
    scenario === "INVALID_FUTURE_TIMESTAMP"
  ) {
    freshness = {
      ...freshness,
      status: scenario,
      ageMs:
        scenario === "INVALID_FUTURE_TIMESTAMP"
          ? -1
          : scenario === "STALE"
            ? profile.freshnessRequirement.maxAgeMs + 1
            : 0,
      ...(scenario === "NOT_LATEST"
        ? {
            latestVersion: (contextVersion +
              1) as PolicyEvaluationInput["contextSnapshot"]["contextVersion"],
          }
        : {}),
    };
    if (profile.contextRequirement !== "STATE_REFRESH") {
      expected = [scenario === "INVALID_FUTURE_TIMESTAMP" ? "DENY" : "REPLAN", "DG-POL-005"];
    }
  } else if (
    scenario === "RELEVANT_CONFLICT" ||
    scenario === "IRRELEVANT_CONFLICT" ||
    scenario === "UNKNOWN_PATH"
  ) {
    const relevant = scenario === "RELEVANT_CONFLICT";
    const unknown = scenario === "UNKNOWN_PATH";
    conflict = {
      status: unknown
        ? "UNKNOWN_RELEVANT_PATH"
        : relevant
          ? "RELEVANT_STATE_CHANGED"
          : "VERSION_CHANGED_BUT_IRRELEVANT",
      planningVersion: (contextVersion -
        1) as PolicyEvaluationInput["contextSnapshot"]["contextVersion"],
      executionVersion: contextVersion,
      changedPaths: relevant ? [profile.relevantContextPaths[0] ?? "vehicle.speedKph"] : [],
      unknownPaths: unknown ? ["vehicle.matrixUnknown"] : [],
      versions: {
        snapshotIdChanged: true,
        contextVersionChanged: true,
        vehicleVersionChanged: false,
        tripVersionChanged: false,
        hasVersionChanged: true,
      },
    };
    if (profile.contextRequirement !== "STATE_REFRESH" && (relevant || unknown)) {
      expected = [unknown ? "DENY" : "REPLAN", "DG-POL-006"];
    }
  }

  return {
    id: `GENERATED-${String(index + 1).padStart(5, "0")}`,
    tool,
    risk: profile.riskLevel,
    scenario,
    contextCondition: scenario,
    capabilityState:
      scenario === "REQUIREMENT_UNAVAILABLE" || scenario === "SERVICE_UNAVAILABLE"
        ? "UNAVAILABLE"
        : "AVAILABLE",
    expectedDecision: expected[0],
    expectedRuleId: expected[1],
    input: {
      ...base,
      trustedDefinition,
      contextSnapshot: contextValue,
      freshness,
      availability,
      ...(conflict === undefined ? {} : { conflict }),
    },
  };
}

export function matrixInput(row: PolicyMatrixCase): PolicyEvaluationInput {
  const base = policyInput(row.tool);
  const freshness = {
    ...base.freshness,
    status: row.contextCondition,
    ageMs:
      row.contextCondition === "INVALID_FUTURE_TIMESTAMP"
        ? -1
        : row.contextCondition === "FRESH"
          ? 0
          : 10_000,
    ...(row.contextCondition === "NOT_LATEST"
      ? { latestVersion: (base.contextSnapshot.contextVersion + 1) as never }
      : {}),
  } as PolicyEvaluationInput["freshness"];
  let availability: CapabilityResolutionContext = base.availability;
  if (row.capabilityState === "CAPABILITY_UNAVAILABLE") {
    availability = availabilityWith({ media: false });
  } else if (row.capabilityState === "SERVICE_UNAVAILABLE") {
    availability = availabilityWith({}, { vehicleSimulator: false });
  }
  return { ...base, freshness, availability };
}
