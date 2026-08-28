import {
  PolicyEngine,
  ToolPolicyProfileRegistry,
  createDefaultToolPolicyProfileRegistry,
  policyEvaluationEpoch,
} from "@driveguard/policy";
import { FORBIDDEN_TOOL_NAMES, FORMAL_TOOL_NAMES, type FormalToolName } from "@driveguard/tools";
import { describe, expect, it } from "vitest";

import {
  PHASE6_EVALUATED_AT,
  availabilityWith,
  conflict,
  nextSnapshot,
  policyInput,
} from "../fixtures/phase6-policy.js";

const engine = new PolicyEngine();

const normalExpected: Readonly<Record<FormalToolName, readonly [string, string]>> = {
  get_vehicle_state: ["ALLOW", "DG-POL-010"],
  get_trip_state: ["ALLOW", "DG-POL-010"],
  get_weather: ["ALLOW", "DG-POL-010"],
  search_charging_stations: ["ALLOW", "DG-POL-010"],
  get_charging_status: ["ALLOW", "DG-POL-010"],
  set_cabin_temperature: ["ALLOW", "DG-POL-009"],
  set_seat_heating: ["ALLOW", "DG-POL-009"],
  set_media_volume: ["ALLOW", "DG-POL-009"],
  set_navigation_destination: ["REQUIRE_CONFIRMATION", "DG-POL-008"],
  reroute_to_charger: ["REQUIRE_CONFIRMATION", "DG-POL-008"],
  reserve_charging_slot: ["REQUIRE_CONFIRMATION", "DG-POL-008"],
  cancel_charging_reservation: ["REQUIRE_CONFIRMATION", "DG-POL-008"],
  request_roadside_assistance: ["REQUIRE_CONFIRMATION", "DG-POL-007"],
  request_emergency_support: ["REQUIRE_CONFIRMATION", "DG-POL-007"],
};

function evaluate(input: unknown, evaluatedAt: unknown = PHASE6_EVALUATED_AT) {
  return engine.evaluate(input, evaluatedAt);
}

describe("Phase 6 deterministic PolicyEngine normal decisions", () => {
  it.each(FORMAL_TOOL_NAMES)("%s has its exact default decision and rule", (toolName) => {
    const [decision, ruleId] = normalExpected[toolName];
    expect(evaluate(policyInput(toolName))).toMatchObject({
      toolName,
      riskLevel: policyInput(toolName).toolDefinition.riskLevel,
      decision,
      ruleId,
    });
  });

  it.each(FORMAL_TOOL_NAMES)(
    "%s rejects schema-invalid arguments before risk rules",
    (toolName) => {
      expect(
        evaluate({
          ...policyInput(toolName),
          validatedArguments: { unexpected: true },
        }),
      ).toMatchObject({ decision: "DENY", ruleId: "DG-POL-002" });
    },
  );

  it.each(FORMAL_TOOL_NAMES)("%s rejects an untrusted direct definition", (toolName) => {
    expect(evaluate({ ...policyInput(toolName), trustedDefinition: false })).toMatchObject({
      decision: "DENY",
      ruleId: "DG-POL-002",
    });
  });

  it("returns an immutable complete safe decision model", () => {
    const result = evaluate(policyInput("set_cabin_temperature"));
    expect(result).toEqual({
      decision: "ALLOW",
      ruleId: "DG-POL-009",
      reasonCode: "R1_ALLOWED",
      toolName: "set_cabin_temperature",
      riskLevel: "R1",
      contextSnapshotId: "phase2-snapshot:1",
      contextVersion: 1,
      evaluatedAt: PHASE6_EVALUATED_AT,
      evidence: {
        freshnessStatus: "FRESH",
        conflictStatus: "NOT_EVALUATED",
        contextChanged: false,
        requiredCapabilityAvailable: true,
        serviceAvailable: true,
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.evidence)).toBe(true);
  });

  it("never records Tool arguments, raw authorization, secrets, or reasoning", () => {
    const input = policyInput("request_emergency_support", {
      validatedArguments: { reason: "secret=do-not-retain" },
    });
    const serialized = JSON.stringify(evaluate(input));
    expect(serialized).not.toMatch(/do-not-retain|authorization|chain.of.thought|reasoning/iu);
  });
});

describe("Phase 6 fixed Policy precedence and fail-closed behavior", () => {
  it.each(FORBIDDEN_TOOL_NAMES)("P0 denies forged RX %s", (toolName) => {
    const base = policyInput("get_vehicle_state");
    expect(
      evaluate({
        ...base,
        trustedDefinition: false,
        toolDefinition: { ...base.toolDefinition, name: toolName, riskLevel: "RX" },
        availability: null,
        contextSnapshot: null,
      }),
    ).toMatchObject({
      decision: "DENY",
      ruleId: "DG-POL-001",
      reasonCode: "FORBIDDEN_RX",
      toolName,
    });
  });

  it("P1 denies an unknown forged Tool", () => {
    const base = policyInput("get_vehicle_state");
    expect(
      evaluate({
        ...base,
        toolDefinition: { ...base.toolDefinition, name: "forged_tool" },
      }),
    ).toMatchObject({ decision: "DENY", ruleId: "DG-POL-002" });
  });

  it("P1 denies an unknown risk level", () => {
    const base = policyInput("get_vehicle_state");
    expect(
      evaluate({
        ...base,
        toolDefinition: { ...base.toolDefinition, riskLevel: "RX" },
      }),
    ).toMatchObject({ decision: "DENY", riskLevel: "UNKNOWN", ruleId: "DG-POL-002" });
  });

  it("P1 denies a missing Tool policy profile", () => {
    const withoutProfiles = new PolicyEngine({ profiles: new ToolPolicyProfileRegistry([]) });
    expect(
      withoutProfiles.evaluate(policyInput("get_vehicle_state"), PHASE6_EVALUATED_AT),
    ).toMatchObject({ decision: "DENY", ruleId: "DG-POL-002" });
  });

  it("P1 denies reordered canonical requirements", () => {
    const base = policyInput("reroute_to_charger");
    expect(
      evaluate({
        ...base,
        toolDefinition: {
          ...base.toolDefinition,
          requiredCapabilities: [...base.toolDefinition.requiredCapabilities].reverse(),
        },
      }),
    ).toMatchObject({ decision: "DENY", ruleId: "DG-POL-002" });
  });

  it("P1 denies an input schema that cannot be compiled", () => {
    const base = policyInput("get_vehicle_state");
    const inputSchema: Record<string, unknown> = { type: "object" };
    inputSchema.properties = { recursive: inputSchema };
    expect(
      evaluate({ ...base, toolDefinition: { ...base.toolDefinition, inputSchema } }),
    ).toMatchObject({ decision: "DENY", ruleId: "DG-POL-002" });
  });

  it("fails closed if profile lookup throws", () => {
    const brokenProfiles = {
      get() {
        throw new Error("profile registry failed");
      },
      list() {
        return [];
      },
    };
    expect(
      new PolicyEngine({ profiles: brokenProfiles as never }).evaluate(
        policyInput("get_vehicle_state"),
        PHASE6_EVALUATED_AT,
      ),
    ).toMatchObject({
      decision: "DENY",
      ruleId: "DG-POL-002",
      reasonCode: "INVALID_POLICY_INPUT",
    });
  });

  it("P1 denies an invalid evaluatedAt value", () => {
    expect(evaluate(policyInput("get_vehicle_state"), "not-a-time")).toMatchObject({
      decision: "DENY",
      ruleId: "DG-POL-002",
      evaluatedAt: null,
    });
  });

  it.each([
    { status: "FRESH", ageMs: 10_000 },
    { status: "STALE", ageMs: 0 },
    { status: "INVALID_FUTURE_TIMESTAMP", ageMs: 0 },
    { status: "NOT_LATEST", ageMs: 0 },
  ] as const)("P1 denies contradictory freshness %#", (freshnessPatch) => {
    const base = policyInput("set_media_volume");
    expect(
      evaluate({ ...base, freshness: { ...base.freshness, ...freshnessPatch } }),
    ).toMatchObject({ decision: "DENY", ruleId: "DG-POL-002" });
  });

  it("P1 denies a freshness threshold that does not match the Tool profile", () => {
    const base = policyInput("set_media_volume");
    expect(evaluate({ ...base, freshness: { ...base.freshness, maxAgeMs: 5_000 } })).toMatchObject({
      decision: "DENY",
      ruleId: "DG-POL-002",
    });
  });

  it("P1 denies a missing latest version required by the Tool profile", () => {
    const base = policyInput("set_media_volume");
    const freshness = { ...base.freshness } as Record<string, unknown>;
    delete freshness.latestVersion;
    expect(evaluate({ ...base, freshness })).toMatchObject({
      decision: "DENY",
      ruleId: "DG-POL-002",
    });
  });

  it.each([
    { status: "NO_CONFLICT", changedPaths: ["vehicle.speedKph"] },
    { status: "NO_CONFLICT", unknownPaths: ["vehicle.unknown"] },
    { changedPaths: ["vehicle.unknown"] },
    { unknownPaths: ["vehicle.speedKph"] },
    {
      versions: {
        snapshotIdChanged: false,
        contextVersionChanged: false,
        vehicleVersionChanged: false,
        tripVersionChanged: false,
        hasVersionChanged: true,
      },
    },
  ])("P1 denies contradictory conflict %#", (conflictPatch) => {
    const base = policyInput("set_media_volume");
    const noConflict = conflict(base.contextSnapshot, base.contextSnapshot, []);
    expect(evaluate({ ...base, conflict: { ...noConflict, ...conflictPatch } })).toMatchObject({
      decision: "DENY",
      ruleId: "DG-POL-002",
    });
  });

  it.each([undefined, null, "string", 1, [], {}, { toolDefinition: null }])(
    "P1 denies malformed Policy input %#",
    (input) => {
      expect(evaluate(input)).toMatchObject({ decision: "DENY", ruleId: "DG-POL-002" });
    },
  );

  it.each(FORMAL_TOOL_NAMES)("P2 denies unavailable requirements for %s", (toolName) => {
    const profile = createDefaultToolPolicyProfileRegistry().get(toolName)!;
    const availability = availabilityWith();
    const capabilities = { ...availability.capabilities };
    const services = { ...availability.services };
    const capability = profile.requiredCapabilities[0];
    const service = profile.requiredServices[0];
    if (capability !== undefined) capabilities[capability] = false;
    else if (service !== undefined) services[service] = false;
    const result = evaluate(policyInput(toolName, { availability: { capabilities, services } }));
    expect(result).toMatchObject({ decision: "DENY", ruleId: "DG-POL-003" });
  });

  it("P2 chooses capability unavailability before service unavailability", () => {
    expect(
      evaluate(
        policyInput("reserve_charging_slot", {
          availability: availabilityWith({ charging: false }, { vehicleSimulator: false }),
        }),
      ),
    ).toMatchObject({ reasonCode: "CAPABILITY_UNAVAILABLE", ruleId: "DG-POL-003" });
  });

  it("P2 precedes missing Context", () => {
    const input = policyInput("set_media_volume", {
      availability: availabilityWith({ media: false }),
    }) as unknown as Record<string, unknown>;
    delete input.contextSnapshot;
    delete input.freshness;
    expect(evaluate(input)).toMatchObject({ ruleId: "DG-POL-003" });
  });

  it("P3 denies missing Context", () => {
    const input = policyInput("set_media_volume") as unknown as Record<string, unknown>;
    delete input.contextSnapshot;
    delete input.freshness;
    expect(evaluate(input)).toMatchObject({
      decision: "DENY",
      ruleId: "DG-POL-004",
      reasonCode: "CONTEXT_INVALID",
    });
  });

  it("P3 denies schema-invalid Context", () => {
    const base = policyInput("set_media_volume");
    expect(
      evaluate({
        ...base,
        contextSnapshot: {
          ...base.contextSnapshot,
          vehicle: { ...base.contextSnapshot.vehicle, soc: 101 },
        },
      }),
    ).toMatchObject({ decision: "DENY", ruleId: "DG-POL-004" });
  });

  it.each([
    ["INVALID_FUTURE_TIMESTAMP", "DENY", "CONTEXT_FUTURE_TIMESTAMP"],
    ["STALE", "REPLAN", "CONTEXT_STALE"],
    ["NOT_LATEST", "REPLAN", "CONTEXT_NOT_LATEST"],
  ] as const)("P4 maps %s to %s", (status, decision, reasonCode) => {
    const base = policyInput("set_media_volume");
    expect(
      evaluate({
        ...base,
        freshness: {
          ...base.freshness,
          status,
          ageMs: status === "INVALID_FUTURE_TIMESTAMP" ? -1 : 10_000,
          ...(status === "NOT_LATEST" ? { latestVersion: 2 } : {}),
        },
      }),
    ).toMatchObject({ decision, reasonCode, ruleId: "DG-POL-005" });
  });

  it.each(["STALE", "NOT_LATEST", "INVALID_FUTURE_TIMESTAMP"] as const)(
    "R0 state refresh bypasses %s without a side effect",
    (status) => {
      const base = policyInput("get_vehicle_state");
      expect(
        evaluate({
          ...base,
          freshness: {
            ...base.freshness,
            status,
            ageMs: status === "INVALID_FUTURE_TIMESTAMP" ? -1 : 10_000,
            ...(status === "NOT_LATEST" ? { latestVersion: 2 } : {}),
          },
        }),
      ).toMatchObject({ decision: "ALLOW", ruleId: "DG-POL-010" });
    },
  );

  it("P5 replans a relevant state change", () => {
    const base = policyInput("set_navigation_destination");
    const execution = nextSnapshot(base.contextSnapshot, (candidate) => {
      const vehicle = candidate.vehicle as Record<string, unknown>;
      Object.assign(vehicle, { version: 2, speedKph: 30, gear: "D", driveMode: "driving" });
    });
    const changed = conflict(base.contextSnapshot, execution, ["vehicle.speedKph"]);
    expect(
      evaluate({
        ...base,
        contextSnapshot: execution,
        freshness: {
          ...base.freshness,
          snapshotVersion: execution.contextVersion,
          latestVersion: execution.contextVersion,
        },
        conflict: changed,
      }),
    ).toMatchObject({
      decision: "REPLAN",
      ruleId: "DG-POL-006",
      reasonCode: "CONTEXT_RELEVANT_STATE_CHANGED",
    });
  });

  it("P5 does not replan an irrelevant state change", () => {
    const base = policyInput("set_media_volume");
    const execution = nextSnapshot(base.contextSnapshot, (candidate) => {
      const weather = candidate.weather as Record<string, unknown>;
      weather.temperatureC = 29;
    });
    const changed = conflict(base.contextSnapshot, execution, ["capabilities.media"]);
    expect(changed.status).toBe("VERSION_CHANGED_BUT_IRRELEVANT");
    expect(
      evaluate({
        ...base,
        contextSnapshot: execution,
        freshness: {
          ...base.freshness,
          snapshotVersion: execution.contextVersion,
          latestVersion: execution.contextVersion,
        },
        conflict: changed,
      }),
    ).toMatchObject({ decision: "ALLOW", ruleId: "DG-POL-009" });
  });

  it("P5 fails closed on UNKNOWN_RELEVANT_PATH", () => {
    const base = policyInput("set_media_volume");
    const unknown = conflict(base.contextSnapshot, base.contextSnapshot, ["vehicle.unknown"]);
    expect(evaluate({ ...base, conflict: unknown })).toMatchObject({
      decision: "DENY",
      ruleId: "DG-POL-006",
      reasonCode: "CONTEXT_PATH_UNKNOWN",
    });
  });

  it("P4 stale precedence prevents a lower-priority conflict result", () => {
    const base = policyInput("request_roadside_assistance");
    const unknown = conflict(base.contextSnapshot, base.contextSnapshot, ["vehicle.unknown"]);
    expect(
      evaluate({
        ...base,
        freshness: { ...base.freshness, status: "STALE", ageMs: 10_000 },
        conflict: unknown,
      }),
    ).toMatchObject({ ruleId: "DG-POL-005", reasonCode: "CONTEXT_STALE" });
  });
});

describe("Phase 6 Policy determinism", () => {
  it("repeats the decision triple identically while evaluatedAt changes", () => {
    const input = policyInput("reserve_charging_slot");
    const triples = new Set<string>();
    for (let index = 0; index < 100; index += 1) {
      const evaluatedAt = new Date(Date.parse(PHASE6_EVALUATED_AT) + index).toISOString();
      const result = evaluate(input, evaluatedAt);
      triples.add(`${result.decision}|${result.ruleId}|${result.reasonCode}`);
    }
    expect(triples).toEqual(new Set(["REQUIRE_CONFIRMATION|DG-POL-008|R2_CONFIRMATION_REQUIRED"]));
  });

  it("does not mutate Policy input", () => {
    const input = policyInput("set_media_volume");
    const before = structuredClone({
      args: input.validatedArguments,
      context: input.contextSnapshot,
      availability: input.availability,
      freshness: input.freshness,
    });
    evaluate(input);
    expect({
      args: input.validatedArguments,
      context: input.contextSnapshot,
      availability: input.availability,
      freshness: input.freshness,
    }).toEqual(before);
  });

  it("keeps profile registry construction deterministic", () => {
    const left = createDefaultToolPolicyProfileRegistry().list();
    const right = createDefaultToolPolicyProfileRegistry().list();
    expect(left).toEqual(right);
  });

  it("converts valid evaluation timestamps and preserves null", () => {
    expect(policyEvaluationEpoch(evaluate(policyInput("get_vehicle_state")))).toBe(
      Date.parse(PHASE6_EVALUATED_AT),
    );
    expect(policyEvaluationEpoch(evaluate(policyInput("get_vehicle_state"), null))).toBeNull();
  });
});
