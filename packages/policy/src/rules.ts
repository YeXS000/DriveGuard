import { FORBIDDEN_TOOL_NAMES } from "@driveguard/tools";

import { PolicyRuleRegistry } from "./registry.js";
import type { PolicyRule, PolicyRuleInput, PolicyRuleResult } from "./types.js";

const forbiddenNames = new Set<string>(FORBIDDEN_TOOL_NAMES);

function rule(
  ruleId: string,
  priority: number,
  appliesTo: (input: PolicyRuleInput) => boolean,
  evaluate: (input: PolicyRuleInput) => PolicyRuleResult,
): PolicyRule {
  return Object.freeze({ ruleId, priority, appliesTo, evaluate });
}

export const DEFAULT_POLICY_RULES = Object.freeze([
  rule(
    "DG-POL-001",
    0,
    (input) => forbiddenNames.has(input.toolName),
    () => ({ decision: "DENY", reasonCode: "FORBIDDEN_RX" }),
  ),
  rule(
    "DG-POL-002",
    1,
    (input) => !input.inputValid,
    () => ({ decision: "DENY", reasonCode: "INVALID_POLICY_INPUT" }),
  ),
  rule(
    "DG-POL-003",
    2,
    (input) => !input.capabilityAvailable || !input.serviceAvailable,
    (input) => ({
      decision: "DENY",
      reasonCode: input.capabilityAvailable ? "SERVICE_UNAVAILABLE" : "CAPABILITY_UNAVAILABLE",
    }),
  ),
  rule(
    "DG-POL-004",
    3,
    (input) => !input.contextPresent || !input.contextValid,
    () => ({ decision: "DENY", reasonCode: "CONTEXT_INVALID" }),
  ),
  rule(
    "DG-POL-005",
    4,
    (input) => input.contextRequirement !== "STATE_REFRESH" && input.freshnessStatus !== "FRESH",
    (input) => {
      if (input.freshnessStatus === "INVALID_FUTURE_TIMESTAMP") {
        return { decision: "DENY", reasonCode: "CONTEXT_FUTURE_TIMESTAMP" };
      }
      if (input.freshnessStatus === "NOT_LATEST") {
        return { decision: "REPLAN", reasonCode: "CONTEXT_NOT_LATEST" };
      }
      return { decision: "REPLAN", reasonCode: "CONTEXT_STALE" };
    },
  ),
  rule(
    "DG-POL-006",
    5,
    (input) =>
      input.contextRequirement !== "STATE_REFRESH" &&
      (input.conflictStatus === "RELEVANT_STATE_CHANGED" ||
        input.conflictStatus === "UNKNOWN_RELEVANT_PATH"),
    (input) => ({
      decision: input.conflictStatus === "UNKNOWN_RELEVANT_PATH" ? "DENY" : "REPLAN",
      reasonCode:
        input.conflictStatus === "UNKNOWN_RELEVANT_PATH"
          ? "CONTEXT_PATH_UNKNOWN"
          : "CONTEXT_RELEVANT_STATE_CHANGED",
    }),
  ),
  rule(
    "DG-POL-007",
    6,
    (input) => input.riskLevel === "R3",
    () => ({ decision: "REQUIRE_CONFIRMATION", reasonCode: "R3_CONFIRMATION_REQUIRED" }),
  ),
  rule(
    "DG-POL-008",
    7,
    (input) => input.riskLevel === "R2",
    () => ({ decision: "REQUIRE_CONFIRMATION", reasonCode: "R2_CONFIRMATION_REQUIRED" }),
  ),
  rule(
    "DG-POL-009",
    8,
    (input) => input.riskLevel === "R1",
    () => ({ decision: "ALLOW", reasonCode: "R1_ALLOWED" }),
  ),
  rule(
    "DG-POL-010",
    9,
    (input) => input.riskLevel === "R0",
    () => ({ decision: "ALLOW", reasonCode: "R0_ALLOWED" }),
  ),
  rule(
    "DG-POL-011",
    10,
    () => true,
    () => ({ decision: "DENY", reasonCode: "DEFAULT_DENY" }),
  ),
]);

export function createDefaultPolicyRuleRegistry(): PolicyRuleRegistry {
  return new PolicyRuleRegistry(DEFAULT_POLICY_RULES);
}
