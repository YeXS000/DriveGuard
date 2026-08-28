import { CAPABILITY_NAMES, SERVICE_NAMES } from "@driveguard/capabilities";
import { CONTEXT_RELEVANT_PATHS } from "@driveguard/context";
import {
  POLICY_DECISION_TYPES,
  POLICY_REASON_CODES,
  TOOL_POLICY_PROFILES,
  ToolPolicyProfileError,
  ToolPolicyProfileRegistry,
  createDefaultToolPolicyProfileRegistry,
} from "@driveguard/policy";
import { FORMAL_TOOL_NAMES } from "@driveguard/tools";
import { describe, expect, it } from "vitest";

import { createOfflineRegistry } from "../fixtures/phase4-tools.js";

describe("Phase 6 Policy contracts", () => {
  const profiles = createDefaultToolPolicyProfileRegistry();
  const tools = createOfflineRegistry();

  it("defines the four terminal Policy decisions", () => {
    expect(POLICY_DECISION_TYPES).toEqual(["ALLOW", "DENY", "REQUIRE_CONFIRMATION", "REPLAN"]);
  });

  it("uses a closed safe reason-code vocabulary", () => {
    expect(new Set(POLICY_REASON_CODES).size).toBe(POLICY_REASON_CODES.length);
    expect(POLICY_REASON_CODES).not.toContain("CHAIN_OF_THOUGHT" as never);
  });

  it("maps exactly all 14 formal Tools once", () => {
    expect(profiles.list().map((profile) => profile.toolName)).toEqual(FORMAL_TOOL_NAMES);
    expect(profiles.list()).toHaveLength(14);
  });

  it.each(FORMAL_TOOL_NAMES)("%s profile matches accepted Tool metadata", (toolName) => {
    const profile = profiles.get(toolName);
    const definition = tools.get(toolName);
    expect(profile).toBeDefined();
    expect(definition).toBeDefined();
    expect(profile).toMatchObject({
      riskLevel: definition?.riskLevel,
      sideEffect: definition?.sideEffect,
      requiredCapabilities: definition?.requiredCapabilities,
      requiredServices: definition?.requiredServices,
    });
    expect(profile?.confirmationRequired).toBe(
      definition?.riskLevel === "R2" || definition?.riskLevel === "R3",
    );
  });

  it.each(TOOL_POLICY_PROFILES)("%s uses only real Phase 2 Context paths", (profile) => {
    for (const path of profile.relevantContextPaths) {
      expect(CONTEXT_RELEVANT_PATHS).toContain(path);
    }
  });

  it.each(TOOL_POLICY_PROFILES)("%s profile arrays and facts are immutable", (profile) => {
    expect(Object.isFrozen(profiles.get(profile.toolName))).toBe(true);
    expect(Object.isFrozen(profiles.get(profile.toolName)?.relevantContextPaths)).toBe(true);
    expect(Object.isFrozen(profiles.get(profile.toolName)?.requiredCapabilities)).toBe(true);
    expect(Object.isFrozen(profiles.get(profile.toolName)?.requiredServices)).toBe(true);
  });

  it("keeps all R0 reads available as explicit state-refresh profiles", () => {
    expect(profiles.list().filter((profile) => profile.riskLevel === "R0")).toHaveLength(5);
    expect(
      profiles
        .list()
        .filter((profile) => profile.riskLevel === "R0")
        .every((profile) => profile.contextRequirement === "STATE_REFRESH"),
    ).toBe(true);
  });

  it("requires latest Context for every side-effect profile", () => {
    expect(
      profiles
        .list()
        .filter((profile) => profile.sideEffect)
        .every(
          (profile) =>
            profile.contextRequirement === "LATEST_REQUIRED" &&
            profile.freshnessRequirement.requiresLatest,
        ),
    ).toBe(true);
  });

  it.each(CAPABILITY_NAMES)("uses only supported capability %s", (name) => {
    expect(profiles.list().some((profile) => profile.requiredCapabilities.includes(name))).toBe(
      true,
    );
  });

  it.each(SERVICE_NAMES)("uses supported service %s", (name) => {
    expect(profiles.list().some((profile) => profile.requiredServices.includes(name))).toBe(true);
  });

  it("rejects duplicate profile names", () => {
    expect(
      () => new ToolPolicyProfileRegistry([TOOL_POLICY_PROFILES[0]!, TOOL_POLICY_PROFILES[0]!]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_TOOL_POLICY_PROFILE" }));
  });

  it.each([
    { toolName: "unknown_tool" },
    { riskLevel: "RX" },
    { sideEffect: "yes" },
    { contextRequirement: "OPTIONAL" },
    { freshnessRequirement: { maxAgeMs: -1, requiresLatest: true } },
    { freshnessRequirement: { maxAgeMs: 1.5, requiresLatest: true } },
    { freshnessRequirement: { maxAgeMs: 5_000, requiresLatest: "yes" } },
    { relevantContextPaths: null },
    { relevantContextPaths: [1] },
    { relevantContextPaths: ["vehicle.speedKph", "vehicle.speedKph"] },
    { relevantContextPaths: ["vehicle.nonexistent"] },
    { requiredCapabilities: null },
    { requiredCapabilities: [1] },
    { requiredCapabilities: ["navigation", "navigation"] },
    { requiredCapabilities: ["braking"] },
    { requiredServices: null },
    { requiredServices: [1] },
    { requiredServices: ["weather", "weather"] },
    { requiredServices: ["unknown"] },
    { confirmationRequired: "yes" },
  ])("rejects malformed profile patch %#", (patch) => {
    expect(
      () => new ToolPolicyProfileRegistry([{ ...TOOL_POLICY_PROFILES[0]!, ...patch } as never]),
    ).toThrow(ToolPolicyProfileError);
  });

  it("rejects risk and confirmation contradictions", () => {
    expect(
      () =>
        new ToolPolicyProfileRegistry([
          { ...TOOL_POLICY_PROFILES[0]!, confirmationRequired: true },
        ]),
    ).toThrow(ToolPolicyProfileError);
  });

  it("rejects risk and side-effect contradictions", () => {
    expect(
      () => new ToolPolicyProfileRegistry([{ ...TOOL_POLICY_PROFILES[0]!, sideEffect: true }]),
    ).toThrow(ToolPolicyProfileError);
  });

  it("rejects STATE_REFRESH on a non-R0 profile", () => {
    expect(
      () =>
        new ToolPolicyProfileRegistry([
          { ...TOOL_POLICY_PROFILES[5]!, contextRequirement: "STATE_REFRESH" },
        ]),
    ).toThrow(ToolPolicyProfileError);
  });
});
