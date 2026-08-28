import {
  DEFAULT_POLICY_RULES,
  PolicyEngine,
  PolicyRuleRegistry,
  PolicyRuleRegistryError,
  createDefaultPolicyRuleRegistry,
  type PolicyRule,
} from "@driveguard/policy";
import { describe, expect, it } from "vitest";

import { PHASE6_EVALUATED_AT, policyInput } from "../fixtures/phase6-policy.js";

function inertRule(ruleId: string, priority: number): PolicyRule {
  return {
    ruleId,
    priority,
    appliesTo: () => false,
    evaluate: () => ({ decision: "DENY", reasonCode: "DEFAULT_DENY" }),
  };
}

describe("Phase 6 PolicyRuleRegistry", () => {
  it("orders by numeric priority then stable ruleId without insertion dependence", () => {
    const registry = new PolicyRuleRegistry([
      inertRule("DG-POL-103", 102),
      inertRule("DG-POL-102", 101),
      inertRule("DG-POL-101", 101),
    ]);
    expect(registry.list().map((rule) => rule.ruleId)).toEqual([
      "DG-POL-101",
      "DG-POL-102",
      "DG-POL-103",
    ]);
  });

  it("returns frozen ordered snapshots", () => {
    expect(Object.isFrozen(createDefaultPolicyRuleRegistry().list())).toBe(true);
  });

  it("rejects duplicate rule IDs", () => {
    expect(
      () => new PolicyRuleRegistry([inertRule("DG-POL-101", 101), inertRule("DG-POL-101", 102)]),
    ).toThrowError(expect.objectContaining({ code: "DUPLICATE_RULE_ID" }));
  });

  it.each([
    { ...inertRule("BAD", 101) },
    { ...inertRule("DG-POL-101", -1) },
    { ...inertRule("DG-POL-101", 101), appliesTo: null },
    { ...inertRule("DG-POL-101", 101), evaluate: null },
  ])("rejects invalid rule %#", (rule) => {
    expect(() => new PolicyRuleRegistry([rule as never])).toThrow(PolicyRuleRegistryError);
  });

  it("stops at the first terminal matching rule", () => {
    const registry = new PolicyRuleRegistry([
      {
        ruleId: "DG-POL-101",
        priority: 101,
        appliesTo: () => true,
        evaluate: () => ({ decision: "DENY", reasonCode: "DEFAULT_DENY" }),
      },
      {
        ruleId: "DG-POL-102",
        priority: 102,
        appliesTo: () => true,
        evaluate: () => ({ decision: "ALLOW", reasonCode: "R0_ALLOWED" }),
      },
    ]);
    expect(
      new PolicyEngine({ rules: registry }).evaluate(
        policyInput("get_vehicle_state"),
        PHASE6_EVALUATED_AT,
      ),
    ).toMatchObject({ decision: "DENY", ruleId: "DG-POL-101" });
  });

  it("uses DEFAULT_DENY if a custom Registry has no matching terminal rule", () => {
    const decision = new PolicyEngine({
      rules: new PolicyRuleRegistry([inertRule("DG-POL-101", 101)]),
    }).evaluate(policyInput("get_vehicle_state"), PHASE6_EVALUATED_AT);
    expect(decision).toMatchObject({
      decision: "DENY",
      ruleId: "DG-POL-011",
      reasonCode: "DEFAULT_DENY",
    });
  });

  it("fails closed when a rule appliesTo throws", () => {
    const registry = new PolicyRuleRegistry([
      {
        ruleId: "DG-POL-101",
        priority: 100,
        appliesTo: () => {
          throw new Error("rule failure");
        },
        evaluate: () => ({ decision: "ALLOW", reasonCode: "R0_ALLOWED" }),
      },
    ]);
    expect(
      new PolicyEngine({ rules: registry }).evaluate(
        policyInput("get_vehicle_state"),
        PHASE6_EVALUATED_AT,
      ),
    ).toMatchObject({ decision: "DENY", ruleId: "DG-POL-002", reasonCode: "POLICY_EXCEPTION" });
  });

  it("fails closed when a rule evaluate throws", () => {
    const registry = new PolicyRuleRegistry([
      {
        ruleId: "DG-POL-101",
        priority: 100,
        appliesTo: () => true,
        evaluate: () => {
          throw new Error("rule failure");
        },
      },
    ]);
    expect(
      new PolicyEngine({ rules: registry }).evaluate(
        policyInput("get_vehicle_state"),
        PHASE6_EVALUATED_AT,
      ),
    ).toMatchObject({ decision: "DENY", reasonCode: "POLICY_EXCEPTION" });
  });

  it("defines the fixed P0-P10 precedence table", () => {
    expect(DEFAULT_POLICY_RULES.map((rule) => [rule.ruleId, rule.priority])).toEqual([
      ["DG-POL-001", 0],
      ["DG-POL-002", 1],
      ["DG-POL-003", 2],
      ["DG-POL-004", 3],
      ["DG-POL-005", 4],
      ["DG-POL-006", 5],
      ["DG-POL-007", 6],
      ["DG-POL-008", 7],
      ["DG-POL-009", 8],
      ["DG-POL-010", 9],
      ["DG-POL-011", 10],
    ]);
  });

  it("rejects attempts to replace reserved P0 precedence", () => {
    expect(() => new PolicyRuleRegistry([inertRule("DG-POL-000", 0)])).toThrowError(
      expect.objectContaining({ code: "INVALID_RULE" }),
    );
  });

  it("snapshots rules so later Registry mutation cannot change the same input", () => {
    const registry = new PolicyRuleRegistry([inertRule("DG-POL-101", 101)]);
    const engine = new PolicyEngine({ rules: registry });
    const input = policyInput("get_vehicle_state");
    const before = engine.evaluate(input, PHASE6_EVALUATED_AT);
    registry.register({
      ruleId: "DG-POL-102",
      priority: 100,
      appliesTo: () => true,
      evaluate: () => ({ decision: "ALLOW", reasonCode: "R0_ALLOWED" }),
    });
    const after = engine.evaluate(input, PHASE6_EVALUATED_AT);
    expect(after).toEqual(before);
    expect(after).toMatchObject({ decision: "DENY", ruleId: "DG-POL-011" });
  });

  it("keeps the final built-in rule as an explicit terminal DEFAULT_DENY", () => {
    const fallback = DEFAULT_POLICY_RULES.at(-1)!;
    const fabricatedInput = {
      toolName: "future_formal_tool",
      riskLevel: "UNKNOWN",
      inputValid: true,
      contextPresent: true,
      contextValid: true,
      capabilityAvailable: true,
      serviceAvailable: true,
      freshnessStatus: "FRESH",
      conflictStatus: "NOT_EVALUATED",
      contextChanged: false,
      contextRequirement: "LATEST_REQUIRED",
    } as const;
    expect(fallback.appliesTo(fabricatedInput)).toBe(true);
    expect(fallback.evaluate(fabricatedInput)).toEqual({
      decision: "DENY",
      reasonCode: "DEFAULT_DENY",
    });
  });
});
