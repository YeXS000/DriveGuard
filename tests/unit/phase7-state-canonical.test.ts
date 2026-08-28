import {
  ACTION_STATES,
  ActionLifecycleError,
  allowedActionTransitions,
  canonicalSerialize,
  createActionFingerprint,
  transitionPendingAction,
  type ActionState,
} from "@driveguard/action-lifecycle";
import { describe, expect, it } from "vitest";

import { createPhase7Harness } from "../fixtures/phase7-lifecycle.js";

const legal = new Set([
  "AWAITING_CONFIRMATION->CONFIRMED",
  "AWAITING_CONFIRMATION->CANCELLED",
  "AWAITING_CONFIRMATION->EXPIRED",
  "AWAITING_CONFIRMATION->REJECTED",
  "CONFIRMED->REPLAN_REQUIRED",
  "CONFIRMED->READY_FOR_EXECUTION",
]);

describe("Phase 7 Action State Machine", () => {
  for (const from of ACTION_STATES) {
    for (const to of ACTION_STATES) {
      it(`${from} -> ${to} is enforced by the central transition table`, async () => {
        const harness = createPhase7Harness({ withEvents: false });
        const created = await harness.service.create(harness.command());
        let action = created.action;
        const at = created.action.createdAt;
        if (from === "CONFIRMED") {
          action = transitionPendingAction(action, "CONFIRMED", at);
        } else if (from !== "AWAITING_CONFIRMATION") {
          const first =
            from === "READY_FOR_EXECUTION" || from === "REPLAN_REQUIRED" ? "CONFIRMED" : from;
          action = transitionPendingAction(action, first, at);
          if (from === "READY_FOR_EXECUTION" || from === "REPLAN_REQUIRED") {
            action = transitionPendingAction(action, from, at);
          }
        }
        const key = `${from}->${to}`;
        if (legal.has(key)) {
          const next = transitionPendingAction(action, to, at);
          expect(next.state).toBe(to);
          expect(action.state).toBe(from);
          expect(next.stateHistory).toHaveLength(action.stateHistory.length + 1);
        } else {
          expect(() => transitionPendingAction(action, to, at)).toThrowError(ActionLifecycleError);
          expect(action.state).toBe(from);
        }
      });
    }
  }

  it.each(ACTION_STATES)("transition list for %s is immutable", (state) => {
    const transitions = allowedActionTransitions(state);
    expect(Object.isFrozen(transitions)).toBe(true);
    expect(() => (transitions as ActionState[]).push("CANCELLED")).toThrow();
  });

  it("never permits the confirmation bypass transition", async () => {
    const harness = createPhase7Harness({ withEvents: false });
    const created = await harness.service.create(harness.command());
    expect(() =>
      transitionPendingAction(created.action, "READY_FOR_EXECUTION", created.action.createdAt),
    ).toThrowError(/cannot transition/u);
  });
});

describe("Phase 7 canonical serialization and fingerprint", () => {
  const permutations = Array.from({ length: 40 }, (_, index) => index);

  it.each(permutations)("fingerprint is deterministic across key order case %i", (index) => {
    const left = {
      stationId: `station-${index}`,
      nested: { z: index, a: [true, null, index + 1] },
    };
    const right = {
      nested: { a: [true, null, index + 1], z: index },
      stationId: `station-${index}`,
    };
    const identity = {
      toolName: "reserve_charging_slot",
      sessionId: "session:phase7",
      userId: "phase2-driver",
      vehicleId: "vehicle-phase2",
      contextSnapshotId: "context:1",
      contextVersion: 1,
    };
    expect(createActionFingerprint({ ...identity, validatedArguments: left })).toBe(
      createActionFingerprint({ ...identity, validatedArguments: right }),
    );
    expect(canonicalSerialize(left)).toBe(canonicalSerialize(right));
  });

  it.each([
    ["toolName", "cancel_charging_reservation"],
    ["sessionId", "session:other"],
    ["userId", "other-user"],
    ["vehicleId", "other-vehicle"],
    ["contextSnapshotId", "context:other"],
    ["contextVersion", 2],
  ] as const)("fingerprint changes when %s changes", (field, value) => {
    const base = {
      toolName: "reserve_charging_slot",
      validatedArguments: { stationId: "station-1" },
      sessionId: "session:phase7",
      userId: "phase2-driver",
      vehicleId: "vehicle-phase2",
      contextSnapshotId: "context:1",
      contextVersion: 1,
    };
    expect(createActionFingerprint({ ...base, [field]: value })).not.toBe(
      createActionFingerprint(base),
    );
  });

  it.each([NaN, Infinity, undefined, 1n, Symbol("x"), () => undefined])(
    "rejects non-canonical value %s",
    (value) => {
      expect(() => canonicalSerialize({ value })).toThrowError(ActionLifecycleError);
    },
  );

  it("rejects cyclic data", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalSerialize(cyclic)).toThrowError(/cyclic/u);
  });
});
