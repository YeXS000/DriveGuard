import { describe, expect, it } from "vitest";

import { createPhase7Harness } from "../fixtures/phase7-lifecycle.js";

async function authorized() {
  const harness = createPhase7Harness();
  const created = await harness.service.create(harness.command());
  const confirmed = await harness.service.confirm({
    actionId: created.action.actionId,
    confirmationToken: created.trustedChallenge.confirmationToken,
    sessionId: created.action.sessionId,
    userId: created.action.userId,
  });
  if (confirmed.authorization === null) throw new Error("Expected authorization");
  const authorization = confirmed.authorization;
  const command = {
    authorizationId: authorization.authorizationId,
    actionId: authorization.actionId,
    actionFingerprint: authorization.actionFingerprint,
    toolName: authorization.toolName,
    sessionId: confirmed.action.sessionId,
    userId: confirmed.action.userId,
    vehicleId: confirmed.action.vehicleId,
    contextSnapshotId: authorization.contextSnapshotId,
    contextVersion: authorization.contextVersion,
    validatedArguments: confirmed.action.validatedArguments,
  };
  return { harness, created, confirmed, authorization, command };
}

describe("Phase 8 trusted ExecutionAuthorization consumption", () => {
  it("rejects an action that is not READY_FOR_EXECUTION", async () => {
    const harness = createPhase7Harness();
    const created = await harness.service.create(harness.command());
    await expect(
      harness.service.consumeExecutionAuthorization({
        authorizationId: "authorization:missing",
        actionId: created.action.actionId,
        actionFingerprint: created.action.actionFingerprint,
        toolName: created.action.toolName,
        sessionId: created.action.sessionId,
        userId: created.action.userId,
        vehicleId: created.action.vehicleId,
        contextSnapshotId: created.action.contextSnapshotId,
        contextVersion: created.action.contextVersion,
        validatedArguments: created.action.validatedArguments,
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_MISMATCH" });
  });

  it("atomically consumes a valid READY authorization without changing Phase 7 state", async () => {
    const value = await authorized();
    const consumed = await value.harness.service.consumeExecutionAuthorization(value.command);
    expect(consumed).toEqual(value.authorization);
    expect((await value.harness.service.get(value.created.action.actionId))?.state).toBe(
      "READY_FOR_EXECUTION",
    );
  });

  it("rejects sequential replay", async () => {
    const value = await authorized();
    await value.harness.service.consumeExecutionAuthorization(value.command);
    await expect(
      value.harness.service.consumeExecutionAuthorization(value.command),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_ALREADY_USED" });
  });

  it("allows exactly one concurrent consumer", async () => {
    const value = await authorized();
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        value.harness.service.consumeExecutionAuthorization(value.command),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      results
        .filter((result) => result.status === "rejected")
        .every(
          (result) =>
            result.reason instanceof Error &&
            Reflect.get(result.reason, "code") === "AUTHORIZATION_ALREADY_USED",
        ),
    ).toBe(true);
  });

  it("rejects expiration before consumption", async () => {
    const value = await authorized();
    value.harness.clock.advance(10_000);
    await expect(
      value.harness.service.consumeExecutionAuthorization(value.command),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_EXPIRED" });
  });

  it.each([
    ["authorizationId", "authorization:forged"],
    ["actionId", "action:forged"],
    ["actionFingerprint", "f".repeat(64)],
    ["toolName", "cancel_charging_reservation"],
    ["sessionId", "session:other"],
    ["userId", "user:other"],
    ["vehicleId", "vehicle:other"],
    ["contextSnapshotId", "context:other"],
    ["contextVersion", 99],
    ["validatedArguments", { stationId: "station-hongqiao-002" }],
    ["validatedArguments", { stationId: undefined }],
  ] as const)("rejects forged %s binding without consuming", async (field, forged) => {
    const value = await authorized();
    await expect(
      value.harness.service.consumeExecutionAuthorization({
        ...value.command,
        [field]: forged,
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_MISMATCH" });
    await expect(
      value.harness.service.consumeExecutionAuthorization(value.command),
    ).resolves.toEqual(value.authorization);
  });
});
