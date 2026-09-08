import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { toUtcTimestamp } from "@driveguard/domain";

import { buildApi } from "../../apps/api/src/app.js";
import {
  createFakeApiHarness,
  fakeAction,
  fakeExecution,
  fakeRunResult,
} from "../fixtures/phase10-api.js";

const validHeaders = {
  "x-driveguard-user-id": "user:test",
  "x-driveguard-vehicle-id": "vehicle:test",
};

describe("Phase 10 HTTP API contract", () => {
  let app: FastifyInstance;
  let harness: ReturnType<typeof createFakeApiHarness>;

  beforeEach(async () => {
    harness = createFakeApiHarness();
    app = buildApi({ service: harness.service });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("creates a durable identity-bound session", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: validHeaders,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-driveguard-identity-boundary"]).toBe(
      "DEVELOPMENT_IDENTITY_BOUNDARY",
    );
    expect(response.json()).toMatchObject({
      data: {
        userId: "user:test",
        vehicleId: "vehicle:test",
        identityBoundary: "DEVELOPMENT_IDENTITY_BOUNDARY",
        messages: [],
      },
    });
  });

  it("creates a requested safe session id", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: validHeaders,
      payload: { sessionId: "session:chosen" },
    });
    expect(response.json()).toMatchObject({ data: { sessionId: "session:chosen" } });
  });

  it("restores a session for its bound subject", async () => {
    await harness.service.createSession(
      { userId: "user:test", vehicleId: "vehicle:test" },
      "session:test",
    );
    const response = await app.inject({
      method: "GET",
      url: "/v1/sessions/session:test",
      headers: validHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { sessionId: "session:test" } });
  });

  it.each([
    ["missing user", { "x-driveguard-vehicle-id": "vehicle:test" }],
    ["missing vehicle", { "x-driveguard-user-id": "user:test" }],
    ["empty user", { ...validHeaders, "x-driveguard-user-id": "" }],
    ["empty vehicle", { ...validHeaders, "x-driveguard-vehicle-id": "" }],
    ["space in user", { ...validHeaders, "x-driveguard-user-id": "user bad" }],
    ["slash in user", { ...validHeaders, "x-driveguard-user-id": "user/bad" }],
    ["space in vehicle", { ...validHeaders, "x-driveguard-vehicle-id": "vehicle bad" }],
    ["slash in vehicle", { ...validHeaders, "x-driveguard-vehicle-id": "vehicle/bad" }],
    ["oversize user", { ...validHeaders, "x-driveguard-user-id": `u${"x".repeat(128)}` }],
    ["oversize vehicle", { ...validHeaders, "x-driveguard-vehicle-id": `v${"x".repeat(128)}` }],
  ])("rejects invalid development identity headers: %s", async (_name, headers) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: "VALIDATION_ERROR", message: "Request validation failed" },
    });
  });

  it.each([
    ["empty", ""],
    ["leading space", " session"],
    ["slash", "session/bad"],
    ["question", "session?bad"],
    ["hash", "session#bad"],
    ["unicode", "会话"],
    ["oversize", `s${"x".repeat(128)}`],
  ])("rejects an invalid requested session id: %s", async (_name, sessionId) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: validHeaders,
      payload: { sessionId },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
  });

  it.each([
    ["missing prompt", {}],
    ["empty prompt", { prompt: "" }],
    ["null prompt", { prompt: null }],
    ["number prompt", { prompt: 4 }],
    ["object prompt", { prompt: {} }],
    ["array prompt", { prompt: [] }],
    ["extra field", { prompt: "hello", raw: "forbidden" }],
    ["oversize prompt", { prompt: "x".repeat(32_001) }],
  ])("rejects malformed message payload: %s", async (_name, payload) => {
    await harness.service.createSession(
      { userId: "user:test", vehicleId: "vehicle:test" },
      "session:test",
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions/session:test/messages",
      headers: validHeaders,
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
  });

  it("returns SESSION_NOT_FOUND for an absent session", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/sessions/session:missing",
      headers: validHeaders,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("SESSION_NOT_FOUND");
  });

  it("hides a cross-user session as not found", async () => {
    await harness.service.createSession(
      { userId: "user:owner", vehicleId: "vehicle:test" },
      "session:test",
    );
    const response = await app.inject({
      method: "GET",
      url: "/v1/sessions/session:test",
      headers: validHeaders,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("SESSION_NOT_FOUND");
  });

  it("hides a cross-vehicle session as not found", async () => {
    await harness.service.createSession(
      { userId: "user:test", vehicleId: "vehicle:other" },
      "session:test",
    );
    const response = await app.inject({
      method: "GET",
      url: "/v1/sessions/session:test",
      headers: validHeaders,
    });
    expect(response.statusCode).toBe(404);
  });

  it("sends a message through the injected Runtime service", async () => {
    await harness.service.createSession(
      { userId: "user:test", vehicleId: "vehicle:test" },
      "session:test",
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions/session:test/messages",
      headers: validHeaders,
      payload: { prompt: "vehicle state" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: { status: "completed", response: "safe response", runId: "run:test" },
    });
    expect(harness.factory.inputs).toHaveLength(1);
  });

  it.each([
    ["SESSION_BUSY", 503, "SERVICE_BUSY"],
    ["POLICY_DENIED", 403, "POLICY_DENIED"],
    ["POLICY_REPLAN_REQUIRED", 409, "REPLAN_REQUIRED"],
    ["TOOL_ERROR", 503, "DEPENDENCY_UNAVAILABLE"],
    ["CONTEXT_LOAD_FAILED", 503, "DEPENDENCY_UNAVAILABLE"],
    ["MODEL_ERROR", 500, "INTERNAL_ERROR"],
    ["INTERNAL_ERROR", 500, "INTERNAL_ERROR"],
  ])("maps Runtime failure %s to a structured API error", async (code, status, apiCode) => {
    await harness.service.createSession(
      { userId: "user:test", vehicleId: "vehicle:test" },
      "session:test",
    );
    harness.factory.nextResult = fakeRunResult({ status: "failed", errorCode: code as never });
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions/session:test/messages",
      headers: validHeaders,
      payload: { prompt: "request" },
    });
    expect(response.statusCode).toBe(status);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(apiCode);
  });

  it("returns the intended application confirmation credential", async () => {
    await harness.service.createSession(
      { userId: "user:test", vehicleId: "vehicle:test" },
      "session:test",
    );
    const action = fakeAction();
    harness.factory.actions.set(action.actionId, action);
    harness.factory.challenges.set(action.actionId, {
      actionId: action.actionId,
      confirmationToken: "credential:test",
      sessionId: action.sessionId,
      userId: action.userId,
      expiresAt: action.expiresAt,
    });
    harness.factory.nextResult = fakeRunResult({
      status: "failed",
      errorCode: "POLICY_CONFIRMATION_REQUIRED",
      confirmation: {
        actionId: action.actionId,
        toolName: action.toolName,
        riskLevel: action.riskLevel,
        expiresAt: action.expiresAt,
        summary: action.confirmationSummary,
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions/session:test/messages",
      headers: validHeaders,
      payload: { prompt: "reserve charging" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        status: "confirmation_required",
        actions: [{ actionId: "action:test", confirmationCredential: "credential:test" }],
      },
    });
  });

  it("reads an action without exposing the credential or fingerprint", async () => {
    harness.factory.actions.set("action:test", fakeAction());
    const response = await app.inject({
      method: "GET",
      url: "/v1/actions/action:test",
      headers: validHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: { tool: "reserve_charging_slot", riskLevel: "R2" },
    });
    expect(response.body).not.toContain("confirmationCredential");
    expect(response.body).not.toContain("actionFingerprint");
  });

  it("hides a cross-user action", async () => {
    harness.factory.actions.set("action:test", fakeAction({ userId: "user:other" }));
    const response = await app.inject({
      method: "GET",
      url: "/v1/actions/action:test",
      headers: validHeaders,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("ACTION_NOT_FOUND");
  });

  it("confirms through ConfirmationService and Reliable Executor", async () => {
    harness.factory.actions.set("action:test", fakeAction());
    const response = await app.inject({
      method: "POST",
      url: "/v1/actions/action:test/confirm",
      headers: validHeaders,
      payload: { sessionId: "session:test", confirmationCredential: "credential:test" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { execution: { status: "SUCCEEDED" } } });
    expect(harness.factory.confirmCalls).toBe(1);
  });

  it.each([
    [
      "wrong token",
      { sessionId: "session:test", confirmationCredential: "wrong-token" },
      "CONFIRMATION_INVALID",
    ],
    [
      "wrong session",
      { sessionId: "session:other", confirmationCredential: "credential:test" },
      "ACTION_NOT_FOUND",
    ],
    [
      "short token",
      { sessionId: "session:test", confirmationCredential: "short" },
      "VALIDATION_ERROR",
    ],
    ["missing token", { sessionId: "session:test" }, "VALIDATION_ERROR"],
    [
      "extra property",
      { sessionId: "session:test", confirmationCredential: "credential:test", state: "CONFIRMED" },
      "VALIDATION_ERROR",
    ],
  ])("rejects confirmation bypass attempt: %s", async (_name, payload, code) => {
    harness.factory.actions.set("action:test", fakeAction());
    const response = await app.inject({
      method: "POST",
      url: "/v1/actions/action:test/confirm",
      headers: validHeaders,
      payload,
    });
    expect(response.json<{ error: { code: string } }>().error.code).toBe(code);
    expect(harness.factory.confirmCalls).toBe(code === "CONFIRMATION_INVALID" ? 1 : 0);
  });

  it("rejects an expired action before execution", async () => {
    harness.factory.actions.set(
      "action:test",
      fakeAction({ expiresAt: toUtcTimestamp(Date.now() - 1) }),
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/actions/action:test/confirm",
      headers: validHeaders,
      payload: { sessionId: "session:test", confirmationCredential: "credential:test" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("ACTION_EXPIRED");
    expect(harness.factory.confirmCalls).toBe(0);
  });

  it.each(["reject", "cancel"])(
    "transitions an action via ConfirmationService: %s",
    async (operation) => {
      harness.factory.actions.set("action:test", fakeAction());
      const response = await app.inject({
        method: "POST",
        url: `/v1/actions/action:test/${operation}`,
        headers: validHeaders,
        payload: { sessionId: "session:test" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ data: { state: string } }>().data.state).toBe(
        operation === "reject" ? "REJECTED" : "CANCELLED",
      );
    },
  );

  it("reads an identity-bound execution result", async () => {
    const request = {
      executionId: "execution:test",
      toolName: "reserve_charging_slot",
      validatedArguments: { stationId: "station-pudong-001" },
      actionFingerprint: "a".repeat(64),
      runId: "run:test",
      sessionId: "session:test",
      userId: "user:test",
      vehicleId: "vehicle:test",
      traceId: "trace:test",
      riskLevel: "R2",
      policyDecision: {} as never,
      actionId: "action:test",
      authorizationId: "authorization:test",
      contextSnapshotId: "context:test",
      contextVersion: 1,
      idempotencyKey: "confirmed:action:test",
      createdAt: toUtcTimestamp(Date.now()),
    } as const;
    harness.executions.set(
      {
        executionId: "execution:test",
        toolName: "reserve_charging_slot",
        actionFingerprint: "a".repeat(64),
        idempotencyKey: "confirmed:action:test",
        state: "SUCCEEDED",
        attempts: Object.freeze([]),
        stateHistory: Object.freeze([]),
        createdAt: request.createdAt,
        updatedAt: request.createdAt,
      },
      fakeExecution,
      request,
    );
    const response = await app.inject({
      method: "GET",
      url: "/v1/executions/execution:test",
      headers: validHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: { executionId: "execution:test", state: "SUCCEEDED" },
    });
  });

  it("hides a missing execution", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/executions/execution:missing",
      headers: validHeaders,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("EXECUTION_NOT_FOUND");
  });

  it("returns structured not-found errors without stack or filesystem paths", async () => {
    const response = await app.inject({ method: "GET", url: "/does-not-exist" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: "VALIDATION_ERROR", message: "Route was not found" },
    });
    expect(response.body).not.toMatch(/stack|\/home\/|[A-Z]:\\/iu);
  });

  it("streams only the public SSE contract", async () => {
    await harness.service.createSession(
      { userId: "user:test", vehicleId: "vehicle:test" },
      "session:test",
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions/session:test/messages/stream",
      headers: validHeaders,
      payload: { prompt: "hello" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("event: run.started");
    expect(response.body).toContain("event: assistant.delta");
    expect(response.body).toContain("event: assistant.completed");
    expect(response.body).not.toContain("context.loaded");
    expect(response.body).not.toContain("capabilities.resolved");
  });

  it("streams a structured failure when the session is absent", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions/session:missing/messages/stream",
      headers: validHeaders,
      payload: { prompt: "hello" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: run.failed");
    expect(response.body).toContain('"code":"SESSION_NOT_FOUND"');
  });

  it("streams a generic safe failure without exception details", async () => {
    await harness.service.createSession(
      { userId: "user:test", vehicleId: "vehicle:test" },
      "session:test",
    );
    harness.factory.createError = new Error("sensitive provider detail");
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions/session:test/messages/stream",
      headers: validHeaders,
      payload: { prompt: "hello" },
    });
    expect(response.body).toContain('"code":"INTERNAL_ERROR"');
    expect(response.body).not.toContain("sensitive provider detail");
  });

  it("cancels the active Runtime when an SSE client disconnects", async () => {
    await harness.service.createSession(
      { userId: "user:test", vehicleId: "vehicle:test" },
      "session:test",
    );
    harness.factory.delayRun = true;
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const response = await fetch(`${address}/v1/sessions/session:test/messages/stream`, {
      method: "POST",
      headers: { ...validHeaders, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "wait" }),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    controller.abort();
    await expect(response.text()).rejects.toMatchObject({ name: "AbortError" });
    for (let attempt = 0; attempt < 100 && harness.factory.cancelCalls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(harness.factory.cancelCalls).toBe(1);
    expect(harness.service.activeRequestCount).toBe(0);
  });
});
