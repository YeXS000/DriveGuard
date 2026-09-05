import type { ToolDefinition } from "@driveguard/tools";
import { describe, expect, it } from "vitest";

import {
  CriticalPathGuard,
  GoalToolRouter,
  type FormalCriticalCapabilityEnvelope,
} from "../../packages/agent-runtime/src/index.js";

function definition(name: string, riskLevel: "R0" | "R1" | "R2" | "R3"): ToolDefinition {
  return {
    name,
    label: name,
    description: name,
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    outputSchema: { type: "object", properties: {}, additionalProperties: true },
    riskLevel,
    requiredCapabilities: name.includes("charging") ? ["charging"] : [],
    requiredServices: ["vehicleSimulator"],
    sideEffect: riskLevel !== "R0",
    timeoutHintMs: 1_000,
    idempotencyHint: name === "reserve_charging_slot" ? "IDEMPOTENT" : "NON_IDEMPOTENT",
    auditLevel: riskLevel === "R0" ? "BASIC" : "HIGH",
    execute: () => Promise.resolve({}),
  };
}

describe("Phase 13.2.1 critical capability envelope", () => {
  it("resolves charging.reserve before Planner execution", () => {
    const plan = new GoalToolRouter().plan("预约浦东001号充电站", [
      definition("reserve_charging_slot", "R2"),
    ]);
    const envelopes = new CriticalPathGuard().resolve("预约浦东001号充电站", plan, [
      definition("reserve_charging_slot", "R2"),
    ]);

    expect(envelopes).toEqual([
      expect.objectContaining<Partial<FormalCriticalCapabilityEnvelope>>({
        domain: "charging",
        action: "reserve",
        capability: "charging.reserve",
        supported: true,
        riskClass: "R2",
        policyClass: "REQUIRE_CONFIRMATION",
        critical: true,
        requiredAction: "reserve_charging_slot",
        toolMapping: "reserve_charging_slot",
        knownArguments: { stationId: "station-pudong-001" },
        missingArguments: [],
      }),
    ]);
  });

  it("resolves unsupported vehicle braking to a deterministic DENY envelope", () => {
    const plan = new GoalToolRouter().plan("立即替我踩下刹车", []);
    const envelopes = new CriticalPathGuard().resolve("立即替我踩下刹车", plan, []);

    expect(envelopes).toEqual([
      expect.objectContaining({
        capability: "vehicle.apply_brake",
        supported: false,
        riskClass: "CRITICAL_UNSUPPORTED",
        policyClass: "DENY",
        critical: true,
        requiredAction: "DENY",
        toolMapping: "apply_brake",
      }),
    ]);
  });

  it("detects a missing required critical action without hiding it", () => {
    const guard = new CriticalPathGuard();
    const plan = new GoalToolRouter().plan("预约浦东001号充电站", [
      definition("reserve_charging_slot", "R2"),
    ]);
    const [envelope] = guard.resolve("预约浦东001号充电站", plan, [
      definition("reserve_charging_slot", "R2"),
    ]);

    expect(guard.validate([envelope!], [])).toEqual({
      status: "PLAN_INCOMPLETE",
      missingRequiredActions: ["reserve_charging_slot"],
    });
    expect(guard.validate([envelope!], ["reserve_charging_slot"]).status).toBe("COMPLETE");
  });

  it("permits exactly one constrained repair and never adds optional actions", () => {
    const guard = new CriticalPathGuard();
    const envelope = {
      domain: "charging",
      action: "reserve",
      capability: "charging.reserve",
      supported: true,
      riskClass: "R2",
      policyClass: "REQUIRE_CONFIRMATION",
      critical: true,
      requiredAction: "reserve_charging_slot",
      toolMapping: "reserve_charging_slot",
      knownArguments: { stationId: "station-pudong-001" },
      missingArguments: [],
    } as const;

    expect(guard.constrainedRepair([envelope], [])).toEqual([
      { toolName: "reserve_charging_slot", arguments: { stationId: "station-pudong-001" } },
    ]);
    expect(() => guard.constrainedRepair([envelope], [])).toThrow(/already attempted/u);
  });
});
