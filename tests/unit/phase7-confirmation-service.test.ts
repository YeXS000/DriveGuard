import { DEFAULT_CONFIRMATION_TTL_MS, createActionFingerprint } from "@driveguard/action-lifecycle";
import type { ContextSnapshot } from "@driveguard/domain";
import { describe, expect, it } from "vitest";

import { createValidSnapshot } from "../fixtures/phase2-domain.js";
import { FULL_CAPABILITY_CONTEXT } from "../fixtures/phase4-tools.js";
import { createPhase7Harness, PHASE7_NOW_MS } from "../fixtures/phase7-lifecycle.js";
import { nextSnapshot } from "../fixtures/phase6-policy.js";

async function pending() {
  const harness = createPhase7Harness();
  const created = await harness.service.create(harness.command());
  return { harness, created };
}

describe("Phase 7 PendingAction creation and immutable binding", () => {
  it.each([
    "set_navigation_destination",
    "reroute_to_charger",
    "reserve_charging_slot",
    "cancel_charging_reservation",
    "request_roadside_assistance",
    "request_emergency_support",
  ] as const)("creates a bound PendingAction for %s", async (toolName) => {
    const harness = createPhase7Harness();
    const command = harness.command(toolName);
    const created = await harness.service.create(command);
    expect(created.action).toMatchObject({
      toolName,
      state: "AWAITING_CONFIRMATION",
      sessionId: command.sessionId,
      userId: command.userId,
      contextSnapshotId: command.contextSnapshot.snapshotId,
      contextVersion: command.contextSnapshot.contextVersion,
      policyRuleId: command.policyDecision.ruleId,
    });
    expect(created.action.actionFingerprint).toHaveLength(64);
    expect(created.safeResult).not.toHaveProperty("confirmationToken");
    expect(created.trustedChallenge.confirmationToken).toContain("deterministic-token");
  });

  it.each(["ALLOW", "DENY", "REPLAN"] as const)(
    "does not create PendingAction for %s",
    async (decision) => {
      const harness = createPhase7Harness();
      const command = harness.command();
      await expect(
        harness.service.create({
          ...command,
          policyDecision: { ...command.policyDecision, decision },
        }),
      ).rejects.toMatchObject({ code: "INVALID_COMMAND" });
      expect(harness.service.get("action:1")).toBeUndefined();
    },
  );

  it.each([
    ["name", "cancel_charging_reservation"],
    ["riskLevel", "R3"],
  ] as const)("rejects mismatched definition %s policy binding", async (field, value) => {
    const harness = createPhase7Harness();
    const command = harness.command();
    await expect(
      harness.service.create({
        ...command,
        definition: { ...command.definition, [field]: value },
      }),
    ).rejects.toMatchObject({ code: "INVALID_COMMAND" });
  });

  it("deep-freezes arguments, policy, history, and public action", async () => {
    const { created } = await pending();
    expect(Object.isFrozen(created.action)).toBe(true);
    expect(Object.isFrozen(created.action.validatedArguments)).toBe(true);
    expect(Object.isFrozen(created.action.policyDecision)).toBe(true);
    expect(Object.isFrozen(created.action.stateHistory)).toBe(true);
    expect(Reflect.set(created.action.validatedArguments as object, "stationId", "evil")).toBe(
      false,
    );
    expect(created.action.validatedArguments).toEqual({ stationId: "station-pudong-001" });
  });

  it("does not retain plaintext token in repository-visible action or events", async () => {
    const { harness, created } = await pending();
    const serialized = JSON.stringify({ action: created.action, events: harness.events.slice() });
    expect(serialized).not.toContain(created.trustedChallenge.confirmationToken);
    expect(serialized).not.toMatch(/tokenHash|confirmationToken/u);
  });
});

describe("Phase 7 trusted confirmation, expiry, replay, and identity", () => {
  it("confirms, revalidates, and creates one short-lived authorization", async () => {
    const { harness, created } = await pending();
    const outcome = await harness.service.confirm({
      ...created.trustedChallenge,
      confirmationToken: created.trustedChallenge.confirmationToken,
    });
    expect(outcome.action.state).toBe("READY_FOR_EXECUTION");
    expect(outcome.revalidation.status).toBe("VALID");
    expect(outcome.authorization).toMatchObject({
      actionId: created.action.actionId,
      actionFingerprint: created.action.actionFingerprint,
      toolName: created.action.toolName,
      riskLevel: created.action.riskLevel,
      policyRuleId: created.action.policyRuleId,
      contextSnapshotId: created.action.contextSnapshotId,
      contextVersion: created.action.contextVersion,
    });
    expect(Object.isFrozen(outcome.authorization)).toBe(true);
    expect(outcome.action.stateHistory.map((entry) => entry.to)).toEqual([
      "AWAITING_CONFIRMATION",
      "CONFIRMED",
      "READY_FOR_EXECUTION",
    ]);
  });

  it.each(Array.from({ length: 30 }, (_, index) => `wrong-token-${index}`))(
    "rejects wrong token %s without changing state",
    async (wrongToken) => {
      const { harness, created } = await pending();
      await expect(
        harness.service.confirm({
          actionId: created.action.actionId,
          confirmationToken: wrongToken,
          sessionId: created.action.sessionId,
          userId: created.action.userId,
        }),
      ).rejects.toMatchObject({ code: "CONFIRMATION_TOKEN_INVALID" });
      expect(harness.service.get(created.action.actionId)?.state).toBe("AWAITING_CONFIRMATION");
    },
  );

  it.each([
    ["sessionId", "session:other"],
    ["userId", "other-user"],
  ] as const)("rejects cross-identity %s", async (field, value) => {
    const { harness, created } = await pending();
    await expect(
      harness.service.confirm({
        actionId: created.action.actionId,
        confirmationToken: created.trustedChallenge.confirmationToken,
        sessionId: created.action.sessionId,
        userId: created.action.userId,
        [field]: value,
      }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_IDENTITY_MISMATCH" });
    expect(harness.service.get(created.action.actionId)?.state).toBe("AWAITING_CONFIRMATION");
  });

  it.each([
    [DEFAULT_CONFIRMATION_TTL_MS - 1, "valid"],
    [DEFAULT_CONFIRMATION_TTL_MS, "expired"],
    [DEFAULT_CONFIRMATION_TTL_MS + 1, "expired"],
  ] as const)("enforces TTL boundary at offset %i", async (offset, expected) => {
    const { harness, created } = await pending();
    harness.clock.advance(offset);
    const confirmation = harness.service.confirm({
      actionId: created.action.actionId,
      confirmationToken: created.trustedChallenge.confirmationToken,
      sessionId: created.action.sessionId,
      userId: created.action.userId,
    });
    if (expected === "valid") {
      const outcome = await confirmation;
      expect(outcome.action.state).toBe("REPLAN_REQUIRED");
      expect(outcome.revalidation.reason).toBe("CONTEXT_STALE");
    } else {
      await expect(confirmation).rejects.toMatchObject({ code: "CONFIRMATION_EXPIRED" });
      expect(harness.service.get(created.action.actionId)?.state).toBe("EXPIRED");
    }
  });

  it("rejects replay and creates no duplicate authorization", async () => {
    const { harness, created } = await pending();
    const command = {
      actionId: created.action.actionId,
      confirmationToken: created.trustedChallenge.confirmationToken,
      sessionId: created.action.sessionId,
      userId: created.action.userId,
    };
    const first = await harness.service.confirm(command);
    await expect(harness.service.confirm(command)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(first.authorization).not.toBeNull();
    expect(harness.service.get(created.action.actionId)?.stateHistory).toHaveLength(3);
  });

  it.each(["reject", "cancel"] as const)(
    "%s is terminal and later confirmation fails",
    async (operation) => {
      const { harness, created } = await pending();
      const identity = {
        actionId: created.action.actionId,
        sessionId: created.action.sessionId,
        userId: created.action.userId,
      };
      const terminal = await harness.service[operation](identity);
      expect(terminal.state).toBe(operation === "reject" ? "REJECTED" : "CANCELLED");
      await expect(
        harness.service.confirm({
          ...identity,
          confirmationToken: created.trustedChallenge.confirmationToken,
        }),
      ).rejects.toMatchObject({ code: "INVALID_STATE" });
    },
  );

  it("explicit expire only succeeds at or after expiry", async () => {
    const { harness, created } = await pending();
    await expect(harness.service.expire(created.action.actionId)).rejects.toMatchObject({
      code: "INVALID_COMMAND",
    });
    harness.clock.advance(DEFAULT_CONFIRMATION_TTL_MS);
    await expect(harness.service.expire(created.action.actionId)).resolves.toMatchObject({
      state: "EXPIRED",
    });
  });

  it("two concurrent confirms have exactly one success", async () => {
    const { harness, created } = await pending();
    const command = {
      actionId: created.action.actionId,
      confirmationToken: created.trustedChallenge.confirmationToken,
      sessionId: created.action.sessionId,
      userId: created.action.userId,
    };
    const outcomes = await Promise.allSettled([
      harness.service.confirm(command),
      harness.service.confirm(command),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
  });

  it.each(["cancel", "expire"] as const)(
    "confirm/%s race has one legal terminal outcome",
    async (race) => {
      const { harness, created } = await pending();
      if (race === "expire") harness.clock.advance(DEFAULT_CONFIRMATION_TTL_MS);
      const identity = {
        actionId: created.action.actionId,
        sessionId: created.action.sessionId,
        userId: created.action.userId,
      };
      const outcomes = await Promise.allSettled([
        harness.service.confirm({
          ...identity,
          confirmationToken: created.trustedChallenge.confirmationToken,
        }),
        race === "cancel"
          ? harness.service.cancel(identity)
          : harness.service.expire(created.action.actionId),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(["READY_FOR_EXECUTION", "CANCELLED", "EXPIRED"]).toContain(
        harness.service.get(created.action.actionId)?.state,
      );
    },
  );
});

describe("Phase 7 Context, capability, and service revalidation", () => {
  it("allows an irrelevant Context version change", async () => {
    const { harness, created } = await pending();
    harness.setCurrent(
      nextSnapshot(createValidSnapshot(), (candidate) => {
        const weather = candidate.weather as Record<string, unknown>;
        weather.condition = "rain";
      }),
    );
    const outcome = await harness.service.confirm({
      actionId: created.action.actionId,
      confirmationToken: created.trustedChallenge.confirmationToken,
      sessionId: created.action.sessionId,
      userId: created.action.userId,
    });
    expect(outcome.revalidation.reason).toBe("IRRELEVANT_VERSION_CHANGE");
    expect(outcome.action.state).toBe("READY_FOR_EXECUTION");
  });

  it("replans when relevant state changed", async () => {
    const { harness, created } = await pending();
    harness.setCurrent(
      nextSnapshot(createValidSnapshot(), (candidate) => {
        const vehicle = candidate.vehicle as Record<string, unknown>;
        vehicle.soc = 20;
      }),
    );
    const outcome = await harness.service.confirm({
      actionId: created.action.actionId,
      confirmationToken: created.trustedChallenge.confirmationToken,
      sessionId: created.action.sessionId,
      userId: created.action.userId,
    });
    expect(outcome.action.state).toBe("REPLAN_REQUIRED");
    expect(outcome.authorization).toBeNull();
    expect(outcome.revalidation.reason).toBe("RELEVANT_STATE_CHANGED");
  });

  it.each([
    ["capability", { capabilities: { charging: false } }],
    ["service", { services: { vehicleSimulator: false } }],
  ] as const)("replans when required %s disappears", async (_label, override) => {
    const { harness, created } = await pending();
    harness.setAvailability({
      capabilities: {
        ...FULL_CAPABILITY_CONTEXT.capabilities,
        ...("capabilities" in override ? override.capabilities : {}),
      },
      services: {
        ...FULL_CAPABILITY_CONTEXT.services,
        ...("services" in override ? override.services : {}),
      },
    });
    const outcome = await harness.service.confirm({
      actionId: created.action.actionId,
      confirmationToken: created.trustedChallenge.confirmationToken,
      sessionId: created.action.sessionId,
      userId: created.action.userId,
    });
    expect(outcome.action.state).toBe("REPLAN_REQUIRED");
    expect(outcome.authorization).toBeNull();
    expect(outcome.revalidation.reason).toMatch(/UNAVAILABLE/u);
  });

  it("replans on NOT_LATEST", async () => {
    const { harness, created } = await pending();
    harness.setLatest(created.action.contextVersion + 1);
    const outcome = await harness.service.confirm({
      actionId: created.action.actionId,
      confirmationToken: created.trustedChallenge.confirmationToken,
      sessionId: created.action.sessionId,
      userId: created.action.userId,
    });
    expect(outcome.revalidation.reason).toBe("CONTEXT_NOT_LATEST");
    expect(outcome.authorization).toBeNull();
  });

  it("replans on future Context timestamp", async () => {
    const { harness, created } = await pending();
    const future = {
      ...createValidSnapshot(),
      capturedAt: new Date(PHASE7_NOW_MS + 1).toISOString(),
    } as ContextSnapshot;
    harness.setCurrent(future);
    const outcome = await harness.service.confirm({
      actionId: created.action.actionId,
      confirmationToken: created.trustedChallenge.confirmationToken,
      sessionId: created.action.sessionId,
      userId: created.action.userId,
    });
    expect(outcome.revalidation.reason).toBe("CONTEXT_FUTURE_TIMESTAMP");
    expect(outcome.authorization).toBeNull();
  });

  it("fingerprint covers immutable arguments and identity", async () => {
    const { created } = await pending();
    expect(created.action.actionFingerprint).toBe(
      createActionFingerprint({
        toolName: created.action.toolName,
        validatedArguments: created.action.validatedArguments,
        sessionId: created.action.sessionId,
        userId: created.action.userId,
        vehicleId: created.action.vehicleId,
        contextSnapshotId: created.action.contextSnapshotId,
        contextVersion: created.action.contextVersion,
      }),
    );
  });
});

describe("Phase 7 audit events", () => {
  it("records every successful transition without plaintext token", async () => {
    const { harness, created } = await pending();
    await harness.service.confirm({
      actionId: created.action.actionId,
      confirmationToken: created.trustedChallenge.confirmationToken,
      sessionId: created.action.sessionId,
      userId: created.action.userId,
    });
    const eventTypes = harness.events.slice().map((event) => event.eventType);
    expect(eventTypes).toEqual([
      "action.pending.created",
      "confirmation.accepted",
      "action.revalidation.started",
      "action.ready_for_execution",
    ]);
    for (const event of harness.events.slice()) {
      expect(event).toMatchObject({
        runId: created.action.runId,
        sessionId: created.action.sessionId,
        traceId: created.action.traceId,
        actionId: created.action.actionId,
        toolName: created.action.toolName,
      });
      expect(JSON.stringify(event)).not.toContain(created.trustedChallenge.confirmationToken);
    }
  });

  it("records rejection, cancellation, expiry, and revalidation failure", async () => {
    const rejected = await pending();
    await rejected.harness.service.reject({
      actionId: rejected.created.action.actionId,
      sessionId: rejected.created.action.sessionId,
      userId: rejected.created.action.userId,
    });
    expect(rejected.harness.events.slice().at(-1)?.eventType).toBe("confirmation.rejected");

    const cancelled = await pending();
    await cancelled.harness.service.cancel({
      actionId: cancelled.created.action.actionId,
      sessionId: cancelled.created.action.sessionId,
      userId: cancelled.created.action.userId,
    });
    expect(cancelled.harness.events.slice().at(-1)?.eventType).toBe("action.cancelled");

    const expired = await pending();
    expired.harness.clock.advance(DEFAULT_CONFIRMATION_TTL_MS);
    await expired.harness.service.expire(expired.created.action.actionId);
    expect(expired.harness.events.slice().at(-1)?.eventType).toBe("confirmation.expired");

    const conflict = await pending();
    conflict.harness.setCurrent(
      nextSnapshot(createValidSnapshot(), (candidate) => {
        (candidate.vehicle as Record<string, unknown>).soc = 10;
      }),
    );
    await conflict.harness.service.confirm({
      actionId: conflict.created.action.actionId,
      confirmationToken: conflict.created.trustedChallenge.confirmationToken,
      sessionId: conflict.created.action.sessionId,
      userId: conflict.created.action.userId,
    });
    expect(conflict.harness.events.slice().at(-1)?.eventType).toBe("action.revalidation.failed");
  });
});
