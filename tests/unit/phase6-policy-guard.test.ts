import { PolicyEngine } from "@driveguard/policy";
import { FixedClock } from "@driveguard/shared";
import type { ToolDefinition } from "@driveguard/tools";
import { describe, expect, it, vi } from "vitest";

import {
  PiToolAdapter,
  PolicyControlError,
  PolicyGuardedToolHandler,
  PolicyLifecycleError,
} from "../../packages/agent-runtime/src/index.js";
import { PHASE6_EVALUATED_AT, availabilityWith, policyInput } from "../fixtures/phase6-policy.js";

const clock = new FixedClock(Date.parse(PHASE6_EVALUATED_AT));

function guard(
  toolName: Parameters<typeof policyInput>[0],
  options: {
    input?: ReturnType<typeof policyInput>;
    trusted?: boolean;
    throwInput?: boolean;
    observer?: ConstructorParameters<typeof PolicyGuardedToolHandler>[0]["observer"];
  } = {},
) {
  const canonical = policyInput(toolName).toolDefinition;
  return {
    canonical,
    handler: new PolicyGuardedToolHandler({
      engine: new PolicyEngine(),
      clock,
      inputProvider: () => {
        if (options.throwInput) throw new Error("input provider failure");
        return options.input ?? policyInput(toolName, { toolDefinition: canonical });
      },
      isTrustedDefinition: (definition) => (options.trusted ?? true) && definition === canonical,
      ...(options.observer === undefined ? {} : { observer: options.observer }),
    }),
  };
}

describe("Phase 6 PolicyGuardedToolHandler", () => {
  it.each(["get_vehicle_state", "set_media_volume"] as const)(
    "ALLOW executes %s exactly once",
    async (toolName) => {
      const created = guard(toolName);
      const underlying = vi.fn(() => Promise.resolve({ ok: true }));
      await expect(
        created.handler.execute(
          created.canonical,
          policyInput(toolName).validatedArguments,
          underlying,
        ),
      ).resolves.toEqual({ ok: true });
      expect(underlying).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["reserve_charging_slot", "POLICY_CONFIRMATION_REQUIRED"],
    ["request_emergency_support", "POLICY_CONFIRMATION_REQUIRED"],
  ] as const)("confirmation decision for %s executes zero handlers", async (toolName, code) => {
    const created = guard(toolName);
    const underlying = vi.fn(() => Promise.resolve({ ok: true }));
    await expect(
      created.handler.execute(
        created.canonical,
        policyInput(toolName).validatedArguments,
        underlying,
      ),
    ).rejects.toMatchObject({ code });
    expect(underlying).not.toHaveBeenCalled();
  });

  it("REPLAN executes zero handlers", async () => {
    const base = policyInput("set_media_volume");
    const created = guard("set_media_volume", {
      input: {
        ...base,
        freshness: { ...base.freshness, status: "STALE", ageMs: 10_000 },
      },
    });
    const underlying = vi.fn(() => Promise.resolve({ ok: true }));
    await expect(
      created.handler.execute(created.canonical, base.validatedArguments, underlying),
    ).rejects.toMatchObject({ code: "POLICY_REPLAN_REQUIRED" });
    expect(underlying).not.toHaveBeenCalled();
  });

  it("DENY executes zero handlers", async () => {
    const base = policyInput("set_media_volume");
    const created = guard("set_media_volume", {
      input: { ...base, availability: availabilityWith({ media: false }) },
    });
    const underlying = vi.fn(() => Promise.resolve({ ok: true }));
    await expect(
      created.handler.execute(created.canonical, base.validatedArguments, underlying),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(underlying).not.toHaveBeenCalled();
  });

  it("denies a forged definition by canonical Registry identity", async () => {
    const created = guard("get_vehicle_state", { trusted: false });
    const forged = { ...created.canonical } as ToolDefinition;
    const underlying = vi.fn(() => Promise.resolve({ ok: true }));
    await expect(created.handler.execute(forged, {}, underlying)).rejects.toMatchObject({
      code: "POLICY_DENIED",
      decision: { ruleId: "DG-POL-002" },
    });
    expect(underlying).not.toHaveBeenCalled();
  });

  it.each(["apply_brake", "control_steering", "set_throttle", "disable_aeb", "disable_esc"])(
    "P0 denies forged RX %s and executes zero handlers",
    async (toolName) => {
      const created = guard("get_vehicle_state", { trusted: false });
      const forged = { ...created.canonical, name: toolName } as ToolDefinition;
      const underlying = vi.fn(() => Promise.resolve({ ok: true }));
      await expect(created.handler.execute(forged, {}, underlying)).rejects.toMatchObject({
        code: "POLICY_DENIED",
        decision: { ruleId: "DG-POL-001", reasonCode: "FORBIDDEN_RX" },
      });
      expect(underlying).not.toHaveBeenCalled();
    },
  );

  it("fails closed when Policy input construction throws", async () => {
    const created = guard("get_vehicle_state", { throwInput: true });
    const underlying = vi.fn(() => Promise.resolve({ ok: true }));
    await expect(created.handler.execute(created.canonical, {}, underlying)).rejects.toBeInstanceOf(
      PolicyControlError,
    );
    expect(underlying).not.toHaveBeenCalled();
  });

  it("fails closed when Policy input construction returns no input", async () => {
    const base = policyInput("get_vehicle_state");
    const guarded = new PolicyGuardedToolHandler({
      engine: new PolicyEngine(),
      clock,
      inputProvider: () => undefined as never,
      isTrustedDefinition: () => true,
    });
    const underlying = vi.fn(() => Promise.resolve({ ok: true }));
    await expect(guarded.execute(base.toolDefinition, {}, underlying)).rejects.toMatchObject({
      code: "POLICY_DENIED",
      decision: { ruleId: "DG-POL-002" },
    });
    expect(underlying).not.toHaveBeenCalled();
  });

  it("emits started, one decision, then blocked in stable order", async () => {
    const events: string[] = [];
    const created = guard("reserve_charging_slot", {
      observer: {
        evaluationStarted: () => {
          events.push("started");
        },
        decisionMade: (decision) => {
          events.push(`decision:${decision.ruleId}`);
        },
        executionBlocked: () => {
          events.push("blocked");
        },
      },
    });
    await expect(
      created.handler.execute(created.canonical, { stationId: "station-pudong-001" }, vi.fn()),
    ).rejects.toMatchObject({ code: "POLICY_CONFIRMATION_REQUIRED" });
    expect(events).toEqual(["started", "decision:DG-POL-008", "blocked"]);
  });

  it("emits started and exactly one final decision for ALLOW", async () => {
    const events: string[] = [];
    const created = guard("get_vehicle_state", {
      observer: {
        evaluationStarted: () => {
          events.push("started");
        },
        decisionMade: (decision) => {
          events.push(`decision:${decision.ruleId}`);
        },
        executionBlocked: () => {
          events.push("blocked");
        },
      },
    });
    await created.handler.execute(created.canonical, {}, () => Promise.resolve({ ok: true }));
    expect(events).toEqual(["started", "decision:DG-POL-010"]);
  });

  it("fails closed as a lifecycle error if final decision event delivery throws", async () => {
    const created = guard("get_vehicle_state", {
      observer: {
        evaluationStarted: () => undefined,
        decisionMade: () => {
          throw new Error("sink failed");
        },
        executionBlocked: () => undefined,
      },
    });
    const underlying = vi.fn(() => Promise.resolve({ ok: true }));
    await expect(created.handler.execute(created.canonical, {}, underlying)).rejects.toBeInstanceOf(
      PolicyLifecycleError,
    );
    expect(underlying).not.toHaveBeenCalled();
  });

  it("fails closed as a lifecycle error if blocked event delivery throws", async () => {
    const created = guard("reserve_charging_slot", {
      observer: {
        evaluationStarted: () => undefined,
        decisionMade: () => undefined,
        executionBlocked: () => {
          throw new Error("sink failed");
        },
      },
    });
    const underlying = vi.fn(() => Promise.resolve({ ok: true }));
    await expect(
      created.handler.execute(created.canonical, { stationId: "station-pudong-001" }, underlying),
    ).rejects.toBeInstanceOf(PolicyLifecycleError);
    expect(underlying).not.toHaveBeenCalled();
  });

  it("rechecks cancellation after Policy preparation and before dispatch", async () => {
    const base = policyInput("set_media_volume");
    let releaseInput: (() => void) | undefined;
    const inputReady = new Promise<void>((resolve) => {
      releaseInput = resolve;
    });
    const execute = vi.fn(base.toolDefinition.execute);
    const definition = { ...base.toolDefinition, execute } as ToolDefinition;
    const trustedGuard = new PolicyGuardedToolHandler({
      engine: new PolicyEngine(),
      clock,
      inputProvider: async () => {
        await inputReady;
        return { ...base, toolDefinition: definition };
      },
      isTrustedDefinition: (candidate) => candidate === definition,
    });
    const controller = new AbortController();
    const execution = new PiToolAdapter("development", undefined, trustedGuard)
      .adapt(definition)
      .execute("cancel-during-policy", base.validatedArguments, controller.signal);
    controller.abort();
    releaseInput?.();
    await expect(execution).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("PiToolAdapter uses the single guard after its schema validation", async () => {
    const base = policyInput("reserve_charging_slot");
    const execute = vi.fn(base.toolDefinition.execute);
    const definition = { ...base.toolDefinition, execute } as ToolDefinition;
    const guarded = new PolicyGuardedToolHandler({
      engine: new PolicyEngine(),
      clock,
      inputProvider: () => ({ ...base, toolDefinition: definition }),
      isTrustedDefinition: (candidate) => candidate === definition,
    });
    const adapted = new PiToolAdapter("development", undefined, guarded).adapt(definition);
    await expect(adapted.execute("raw", { stationId: "station-pudong-001" })).rejects.toMatchObject(
      {
        code: "POLICY_CONFIRMATION_REQUIRED",
      },
    );
    expect(execute).not.toHaveBeenCalled();
  });
});
