import {
  ActionLifecycleError,
  ConfirmationService,
  ContextRevalidator,
  canonicalSerialize,
  createConfirmationSummary,
} from "@driveguard/action-lifecycle";
import { InMemoryTrustedConfirmationChallengeChannel } from "@driveguard/agent-runtime";
import { ContextFreshnessEvaluator } from "@driveguard/context";
import { toUtcTimestamp } from "@driveguard/domain";
import { createDefaultToolPolicyProfileRegistry } from "@driveguard/policy";
import type { Clock } from "@driveguard/shared";
import { describe, expect, it } from "vitest";

import {
  InMemoryPendingActionRepository,
  type PendingActionRecord,
} from "../../packages/action-lifecycle/src/repository.js";
import { assertPendingActionIntegrity } from "../../packages/action-lifecycle/src/integrity.js";
import type { PendingAction } from "../../packages/action-lifecycle/src/types.js";

import { createValidSnapshot } from "../fixtures/phase2-domain.js";
import { createOfflineRegistry, FULL_CAPABILITY_CONTEXT } from "../fixtures/phase4-tools.js";
import { createPhase7Harness } from "../fixtures/phase7-lifecycle.js";

describe("Phase 7 serialization, summary, error, and repository boundaries", () => {
  it.each([
    [null, "null"],
    [true, "true"],
    [false, "false"],
    [-0, "0"],
    ["text", '"text"'],
    [[1, "two", null], '[1,"two",null]'],
  ])("canonically serializes %j", (value, expected) => {
    expect(canonicalSerialize(value)).toBe(expected);
  });

  it("serializes null-prototype objects", () => {
    const value = Object.create(null) as Record<string, unknown>;
    value.z = 1;
    value.a = 2;
    expect(canonicalSerialize(value)).toBe('{"a":2,"z":1}');
  });

  it.each([new Date(), new Map(), new Set()])("rejects non-plain object %s", (value) => {
    expect(() => canonicalSerialize(value)).toThrowError(/plain objects/u);
  });

  it("rejects symbol properties on objects and arrays", () => {
    const object = { value: 1 };
    Reflect.set(object, Symbol("secret"), 2);
    const array = [1];
    Reflect.set(array, Symbol("secret"), 2);
    expect(() => canonicalSerialize(object)).toThrowError(/symbols/u);
    expect(() => canonicalSerialize(array)).toThrowError(/symbols/u);
  });

  it("rejects sparse arrays and arrays with extra properties", () => {
    const sparse = new Array(2);
    sparse[1] = "value";
    const extended = ["value"];
    Reflect.set(extended, "extra", true);
    expect(() => canonicalSerialize(sparse)).toThrowError(/dense/u);
    expect(() => canonicalSerialize(extended)).toThrowError(/extra properties/u);
  });

  it.each([
    [{}, "Confirm: no arguments. Risk R2."],
    [{ destination: "The Bund" }, "Confirm: destination=The Bund. Risk R2."],
    [{ level: 2 }, "Confirm: level=2. Risk R2."],
    [{ enabled: true }, "Confirm: enabled=true. Risk R2."],
    [{ value: null }, "Confirm: value=null. Risk R2."],
    [{ nested: { b: 2, a: 1 } }, 'Confirm: nested={"a":1,"b":2}. Risk R2.'],
    [["station-pudong-001"], 'Confirm: ["station-pudong-001"]. Risk R2.'],
  ])("creates deterministic summary for %j", (argumentsValue, expected) => {
    expect(createConfirmationSummary({ label: "Confirm", riskLevel: "R2" }, argumentsValue)).toBe(
      expected,
    );
  });

  it("serializes structured lifecycle errors", () => {
    const error = new ActionLifecycleError("INVALID_STATE", "invalid", "action:1", "REJECTED");
    expect(error.toJSON()).toEqual({
      error: {
        code: "INVALID_STATE",
        actionId: "action:1",
        state: "REJECTED",
        message: "invalid",
      },
    });
  });

  it("keeps trusted challenges in a separate one-time application channel", () => {
    let nowMs = Date.parse("2026-08-28T12:59:00.000Z");
    const clock: Clock = { nowMs: () => nowMs };
    const channel = new InMemoryTrustedConfirmationChallengeChannel(clock);
    const challenge = {
      actionId: "action:channel",
      confirmationToken: "opaque-confirmation-token",
      sessionId: "session:channel",
      userId: "user:channel",
      expiresAt: toUtcTimestamp(Date.parse("2026-08-28T13:00:00.000Z")),
    };
    channel.publish(challenge);
    expect(() => channel.publish(challenge)).toThrowError(/already exists/u);
    expect(channel.take(challenge.actionId)).toEqual(challenge);
    expect(channel.take(challenge.actionId)).toBeUndefined();
    channel.publish(challenge);
    channel.discard(challenge.actionId);
    expect(channel.take(challenge.actionId)).toBeUndefined();

    channel.publish(challenge);
    nowMs = Date.parse("2026-08-28T13:00:00.000Z");
    expect(channel.take(challenge.actionId)).toBeUndefined();
    expect(() => channel.publish(challenge)).toThrowError(/expired/u);
  });

  it("repository rejects duplicates, missing records, and duplicate authorization", async () => {
    const harness = createPhase7Harness({ withEvents: false });
    const command = harness.command();
    const created = await harness.service.create(command);
    const repository = new InMemoryPendingActionRepository();
    const record: PendingActionRecord = {
      action: created.action,
      originalContext: command.contextSnapshot,
      tokenHash: "hash",
      confirmationId: null,
      authorization: null,
    };
    await repository.create(record);
    await expect(repository.create(record)).rejects.toThrowError(/Duplicate actionId/u);
    await expect(
      repository.transition("action:missing", "CANCELLED", created.action.createdAt),
    ).rejects.toThrowError(/not found/u);
    const outcome = await harness.service.confirm({
      actionId: created.action.actionId,
      confirmationToken: created.trustedChallenge.confirmationToken,
      sessionId: created.action.sessionId,
      userId: created.action.userId,
    });
    expect(outcome.authorization).not.toBeNull();
    await repository.acceptConfirmation(
      created.action.actionId,
      "confirmation:test",
      created.action.createdAt,
    );
    await repository.authorize(
      created.action.actionId,
      outcome.authorization!,
      outcome.action.updatedAt,
    );
    await expect(
      repository.authorize(
        created.action.actionId,
        outcome.authorization!,
        outcome.action.updatedAt,
      ),
    ).rejects.toThrowError(/already has/u);
  });

  it.each([
    [
      "argument tampering",
      (action: PendingAction): PendingAction => ({
        ...action,
        validatedArguments: { stationId: "tampered-station" },
      }),
    ],
    [
      "Tool substitution",
      (action: PendingAction): PendingAction => ({
        ...action,
        toolName: "set_navigation_destination",
      }),
    ],
    [
      "fingerprint mismatch",
      (action: PendingAction): PendingAction => ({ ...action, actionFingerprint: "0".repeat(64) }),
    ],
  ])("fails closed on %s", async (_label, mutate) => {
    const harness = createPhase7Harness({ withEvents: false });
    const created = await harness.service.create(harness.command());
    expect(() => assertPendingActionIntegrity(mutate(created.action))).toThrowError(
      expect.objectContaining({ code: "ACTION_INTEGRITY_FAILED" }),
    );
  });
});

describe("Phase 7 fail-closed service and revalidation boundaries", () => {
  it.each([0, -1, 300_001, 1.5, Number.NaN])("rejects invalid confirmation TTL %s", (ttl) => {
    const harness = createPhase7Harness({ withEvents: false });
    expect(
      () =>
        new ConfirmationService({
          clock: harness.clock,
          revalidator: harness.revalidator,
          isTrustedDefinition: () => true,
          confirmationTtlMs: ttl,
        }),
    ).toThrowError(/confirmationTtlMs/u);
  });

  it.each([0, -1, 300_001, 1.5, Number.NaN])("rejects invalid authorization TTL %s", (ttl) => {
    const harness = createPhase7Harness({ withEvents: false });
    expect(
      () =>
        new ConfirmationService({
          clock: harness.clock,
          revalidator: harness.revalidator,
          isTrustedDefinition: () => true,
          authorizationTtlMs: ttl,
        }),
    ).toThrowError(/authorizationTtlMs/u);
  });

  it("uses secure production defaults and process-local repository", async () => {
    const harness = createPhase7Harness({ withEvents: false });
    const service = new ConfirmationService({
      clock: harness.clock,
      revalidator: harness.revalidator,
      isTrustedDefinition: () => true,
    });
    const created = await service.create(harness.command());
    expect(created.action.actionId).toMatch(/^action:/u);
    expect(created.trustedChallenge.confirmationToken.length).toBeGreaterThan(32);
    await expect(
      service.confirm({
        actionId: created.action.actionId,
        confirmationToken: created.trustedChallenge.confirmationToken,
        sessionId: created.action.sessionId,
        userId: created.action.userId,
      }),
    ).resolves.toMatchObject({ action: { state: "READY_FOR_EXECUTION" } });
  });

  it.each([
    ["runId", " bad"],
    ["sessionId", ""],
    ["traceId", "bad value"],
    ["userId", "user/value"],
    ["vehicleId", "vehicle value"],
  ] as const)("rejects invalid identity field %s", async (field, value) => {
    const harness = createPhase7Harness({ withEvents: false });
    await expect(
      harness.service.create({ ...harness.command(), [field]: value }),
    ).rejects.toMatchObject({
      code: "INVALID_COMMAND",
    });
  });

  it("rejects action identities that do not match the Context snapshot", async () => {
    const harness = createPhase7Harness({ withEvents: false });
    await expect(
      harness.service.create({ ...harness.command(), userId: "another-driver" }),
    ).rejects.toMatchObject({ code: "INVALID_COMMAND" });
    await expect(
      harness.service.create({ ...harness.command(), vehicleId: "another-vehicle" }),
    ).rejects.toMatchObject({ code: "INVALID_COMMAND" });
  });

  it("stores an immutable clone of the bound Context snapshot", async () => {
    const harness = createPhase7Harness({ withEvents: false });
    const command = harness.command();
    const mutableContext = structuredClone(command.contextSnapshot);
    const created = await harness.service.create({ ...command, contextSnapshot: mutableContext });
    const originalSoc = mutableContext.vehicle.soc;
    (mutableContext.vehicle as { soc: number }).soc = originalSoc - 1;
    const outcome = await harness.service.confirm({
      actionId: created.action.actionId,
      confirmationToken: created.trustedChallenge.confirmationToken,
      sessionId: created.action.sessionId,
      userId: created.action.userId,
    });
    expect(outcome.action.state).toBe("READY_FOR_EXECUTION");
  });

  it("rejects uncloneable and schema-invalid arguments", async () => {
    const harness = createPhase7Harness({ withEvents: false });
    await expect(
      harness.service.create({ ...harness.command(), validatedArguments: { stationId: () => 1 } }),
    ).rejects.toMatchObject({ code: "INVALID_COMMAND" });
    await expect(
      harness.service.create({ ...harness.command(), validatedArguments: { stationId: "" } }),
    ).rejects.toMatchObject({ code: "INVALID_COMMAND" });
  });

  it("rejects an un-compilable Tool Contract", async () => {
    const harness = createPhase7Harness({ withEvents: false });
    const command = harness.command();
    await expect(
      harness.service.create({
        ...command,
        definition: { ...command.definition, inputSchema: { type: "not-real" } },
      }),
    ).rejects.toMatchObject({ code: "INVALID_COMMAND" });
  });

  it.each([
    [() => " bad", "generation failed"],
    [() => "", "generation failed"],
    [
      () => {
        throw new Error("secret");
      },
      "generation failed",
    ],
  ])("fails safely for invalid action ID factory", async (factory, message) => {
    const harness = createPhase7Harness({ withEvents: false });
    const service = new ConfirmationService({
      clock: harness.clock,
      revalidator: harness.revalidator,
      isTrustedDefinition: () => true,
      actionIdFactory: factory,
    });
    await expect(service.create(harness.command())).rejects.toThrowError(message);
  });

  it.each([
    () => "short",
    () => "x".repeat(1_025),
    () => {
      throw new Error("secret");
    },
  ])("fails safely for invalid token generator", async (tokenGenerator) => {
    const harness = createPhase7Harness({ withEvents: false });
    const service = new ConfirmationService({
      clock: harness.clock,
      revalidator: harness.revalidator,
      isTrustedDefinition: () => true,
      tokenGenerator,
    });
    await expect(service.create(harness.command())).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
  });

  it.each([
    () => false,
    () => {
      throw new Error("secret");
    },
  ])("rejects untrusted Tool definitions", async (isTrustedDefinition) => {
    const harness = createPhase7Harness({ withEvents: false });
    const service = new ConfirmationService({
      clock: harness.clock,
      revalidator: harness.revalidator,
      isTrustedDefinition,
    });
    await expect(service.create(harness.command())).rejects.toMatchObject({
      code: "INVALID_COMMAND",
    });
  });

  it("confirmation ID failure leaves the action awaiting confirmation", async () => {
    const harness = createPhase7Harness({ withEvents: false });
    const service = new ConfirmationService({
      clock: harness.clock,
      revalidator: harness.revalidator,
      isTrustedDefinition: () => true,
      confirmationIdFactory: () => " bad",
      tokenGenerator: () => "valid-deterministic-token",
    });
    const created = await service.create(harness.command());
    await expect(
      service.confirm({
        actionId: created.action.actionId,
        confirmationToken: created.trustedChallenge.confirmationToken,
        sessionId: created.action.sessionId,
        userId: created.action.userId,
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect((await service.get(created.action.actionId))?.state).toBe("AWAITING_CONFIRMATION");
  });

  it("authorization ID failure terminally replans without authorization", async () => {
    const harness = createPhase7Harness({ withEvents: false });
    const service = new ConfirmationService({
      clock: harness.clock,
      revalidator: harness.revalidator,
      isTrustedDefinition: () => true,
      authorizationIdFactory: () => " bad",
      tokenGenerator: () => "valid-deterministic-token",
    });
    const created = await service.create(harness.command());
    await expect(
      service.confirm({
        actionId: created.action.actionId,
        confirmationToken: created.trustedChallenge.confirmationToken,
        sessionId: created.action.sessionId,
        userId: created.action.userId,
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect((await service.get(created.action.actionId))?.state).toBe("REPLAN_REQUIRED");
  });

  it("event ID generation failure is secret-safe", async () => {
    const harness = createPhase7Harness({ withEvents: false });
    const service = new ConfirmationService({
      clock: harness.clock,
      revalidator: harness.revalidator,
      isTrustedDefinition: () => true,
      eventSink: { emit: () => undefined },
      actionIdFactory: () => "action:event-id-failure",
      eventIdFactory: () => " bad",
    });
    await expect(service.create(harness.command())).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    expect((await service.get("action:event-id-failure"))?.state).toBe("CANCELLED");
  });

  it("fails closed when lifecycle event delivery fails", async () => {
    const harness = createPhase7Harness({ withEvents: false });
    const service = new ConfirmationService({
      clock: harness.clock,
      revalidator: harness.revalidator,
      isTrustedDefinition: () => true,
      actionIdFactory: () => "action:event-delivery-failure",
      eventSink: { emit: () => Promise.reject(new Error("secret")) },
    });
    await expect(service.create(harness.command())).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    expect((await service.get("action:event-delivery-failure"))?.state).toBe("CANCELLED");
  });

  it("replans after confirmation event delivery fails", async () => {
    const harness = createPhase7Harness({ withEvents: false });
    const service = new ConfirmationService({
      clock: harness.clock,
      revalidator: harness.revalidator,
      isTrustedDefinition: () => true,
      eventSink: {
        emit: (event) => {
          if (event.eventType === "confirmation.accepted") return Promise.reject(new Error("down"));
          return undefined;
        },
      },
    });
    const created = await service.create(harness.command());
    await expect(
      service.confirm({
        actionId: created.action.actionId,
        confirmationToken: created.trustedChallenge.confirmationToken,
        sessionId: created.action.sessionId,
        userId: created.action.userId,
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect((await service.get(created.action.actionId))?.state).toBe("REPLAN_REQUIRED");
  });

  it("keeps an authorized READY action terminal when ready event delivery fails", async () => {
    const harness = createPhase7Harness({ withEvents: false });
    const service = new ConfirmationService({
      clock: harness.clock,
      revalidator: harness.revalidator,
      isTrustedDefinition: () => true,
      eventSink: {
        emit: (event) => {
          if (event.eventType === "action.ready_for_execution") {
            return Promise.reject(new Error("down"));
          }
          return undefined;
        },
      },
    });
    const created = await service.create(harness.command());
    await expect(
      service.confirm({
        actionId: created.action.actionId,
        confirmationToken: created.trustedChallenge.confirmationToken,
        sessionId: created.action.sessionId,
        userId: created.action.userId,
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect((await service.get(created.action.actionId))?.state).toBe("READY_FOR_EXECUTION");
    await expect(
      service.confirm({
        actionId: created.action.actionId,
        confirmationToken: created.trustedChallenge.confirmationToken,
        sessionId: created.action.sessionId,
        userId: created.action.userId,
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("validates confirmation, rejection, and cancellation commands at the boundary", async () => {
    const harness = createPhase7Harness({ withEvents: false });
    const created = await harness.service.create(harness.command());
    await expect(
      harness.service.confirm({
        actionId: created.action.actionId,
        confirmationToken: "",
        sessionId: created.action.sessionId,
        userId: created.action.userId,
      }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_TOKEN_INVALID" });
    await expect(
      harness.service.reject({
        actionId: " bad",
        sessionId: created.action.sessionId,
        userId: created.action.userId,
      }),
    ).rejects.toMatchObject({ code: "INVALID_COMMAND" });
    await expect(
      harness.service.cancel({
        actionId: created.action.actionId,
        sessionId: "bad value",
        userId: created.action.userId,
      }),
    ).rejects.toMatchObject({ code: "INVALID_COMMAND" });
  });

  it("returns ACTION_NOT_FOUND for a wrong actionId", async () => {
    const harness = createPhase7Harness({ withEvents: false });
    await expect(
      harness.service.confirm({
        actionId: "action:missing",
        confirmationToken: "wrong-token",
        sessionId: "session:phase7",
        userId: "phase2-driver",
      }),
    ).rejects.toMatchObject({ code: "ACTION_NOT_FOUND" });
  });

  it("fails closed when current Context reload throws", async () => {
    const harness = createPhase7Harness({ withEvents: false });
    const registry = createOfflineRegistry();
    const revalidator = new ContextRevalidator({
      freshnessEvaluator: new ContextFreshnessEvaluator(harness.clock),
      profiles: createDefaultToolPolicyProfileRegistry(),
      definitionProvider: (name) => registry.get(name),
      currentContextProvider: () => Promise.reject(new Error("unavailable")),
    });
    const service = new ConfirmationService({
      clock: harness.clock,
      revalidator,
      isTrustedDefinition: () => true,
    });
    const created = await service.create(harness.command());
    const outcome = await service.confirm({
      actionId: created.action.actionId,
      confirmationToken: created.trustedChallenge.confirmationToken,
      sessionId: created.action.sessionId,
      userId: created.action.userId,
    });
    expect(outcome).toMatchObject({
      action: { state: "REPLAN_REQUIRED" },
      authorization: null,
      revalidation: { reason: "CONTEXT_RELOAD_FAILED" },
    });
  });

  it("fails closed when an injected revalidator throws unexpectedly", async () => {
    const harness = createPhase7Harness({ withEvents: false });
    const service = new ConfirmationService({
      clock: harness.clock,
      isTrustedDefinition: () => true,
      revalidator: {
        revalidate: () => Promise.reject(new Error("unexpected")),
      } as unknown as ContextRevalidator,
    });
    const created = await service.create(harness.command());
    const outcome = await service.confirm({
      actionId: created.action.actionId,
      confirmationToken: created.trustedChallenge.confirmationToken,
      sessionId: created.action.sessionId,
      userId: created.action.userId,
    });
    expect(outcome).toMatchObject({
      action: { state: "REPLAN_REQUIRED" },
      authorization: null,
      revalidation: { reason: "CONTEXT_RELOAD_FAILED" },
    });
  });

  it("fails closed when Tool is unavailable during confirmation", async () => {
    const harness = createPhase7Harness({ withEvents: false });
    const revalidator = new ContextRevalidator({
      freshnessEvaluator: new ContextFreshnessEvaluator(harness.clock),
      profiles: createDefaultToolPolicyProfileRegistry(),
      definitionProvider: () => undefined,
      currentContextProvider: () =>
        Promise.resolve({
          snapshot: createValidSnapshot(),
          latestContextVersion: createValidSnapshot().contextVersion,
          availability: FULL_CAPABILITY_CONTEXT,
        }),
    });
    const service = new ConfirmationService({
      clock: harness.clock,
      revalidator,
      isTrustedDefinition: () => true,
    });
    const created = await service.create(harness.command());
    const outcome = await service.confirm({
      actionId: created.action.actionId,
      confirmationToken: created.trustedChallenge.confirmationToken,
      sessionId: created.action.sessionId,
      userId: created.action.userId,
    });
    expect(outcome.revalidation.reason).toBe("TOOL_UNAVAILABLE");
  });

  it("fails closed when latest Context version is invalid", async () => {
    const harness = createPhase7Harness({ withEvents: false });
    harness.setLatest("invalid");
    const created = await harness.service.create(harness.command());
    const outcome = await harness.service.confirm({
      actionId: created.action.actionId,
      confirmationToken: created.trustedChallenge.confirmationToken,
      sessionId: created.action.sessionId,
      userId: created.action.userId,
    });
    expect(outcome.revalidation.reason).toBe("CONTEXT_RELOAD_FAILED");
  });

  it("replans when current user or vehicle identity changes", async () => {
    const harness = createPhase7Harness({ withEvents: false });
    const created = await harness.service.create(harness.command());
    harness.setCurrent({
      ...createValidSnapshot(),
      user: { ...createValidSnapshot().user, userId: "other-user" as never },
    });
    const outcome = await harness.service.confirm({
      actionId: created.action.actionId,
      confirmationToken: created.trustedChallenge.confirmationToken,
      sessionId: created.action.sessionId,
      userId: created.action.userId,
    });
    expect(outcome.revalidation.reason).toBe("RELEVANT_STATE_CHANGED");
    expect(outcome.authorization).toBeNull();
  });
});
