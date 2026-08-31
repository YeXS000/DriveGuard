import { describe, expect, it } from "vitest";

import { ActionLifecycleError } from "@driveguard/action-lifecycle";
import { AgentRuntimeError } from "@driveguard/agent-runtime";
import { toUtcTimestamp } from "@driveguard/domain";

import { actionApiError, runtimeApiError } from "../../apps/api/src/errors.js";
import {
  createRuntimePublicEventSink,
  publicEvent,
  type PublicRunEvent,
} from "../../apps/api/src/events.js";
import {
  createFakeApiHarness,
  fakeAction,
  fakeExecution,
  fakeRunResult,
} from "../fixtures/phase10-api.js";

const identity = { userId: "user:test", vehicleId: "vehicle:test" } as const;
const now = toUtcTimestamp(Date.now());

function lifecycleError(code: string): ActionLifecycleError {
  return new ActionLifecycleError(code as never, "private detail", "action:test");
}

function confirmationResult() {
  const action = fakeAction();
  return {
    action,
    result: fakeRunResult({
      status: "failed",
      errorCode: "POLICY_CONFIRMATION_REQUIRED",
      confirmation: {
        actionId: action.actionId,
        toolName: action.toolName,
        riskLevel: action.riskLevel,
        expiresAt: action.expiresAt,
        summary: action.confirmationSummary,
      },
    }),
  };
}

describe("Phase 10 API branch and failure behavior", () => {
  it.each([
    [new Error("private"), "INTERNAL_ERROR", 500],
    [lifecycleError("ACTION_NOT_FOUND"), "ACTION_NOT_FOUND", 404],
    [lifecycleError("CONFIRMATION_EXPIRED"), "ACTION_EXPIRED", 409],
    [lifecycleError("AUTHORIZATION_EXPIRED"), "ACTION_EXPIRED", 409],
    [lifecycleError("CONFIRMATION_TOKEN_INVALID"), "CONFIRMATION_INVALID", 403],
    [lifecycleError("CONFIRMATION_IDENTITY_MISMATCH"), "CONFIRMATION_INVALID", 403],
    [lifecycleError("INVALID_COMMAND"), "CONFIRMATION_INVALID", 403],
    [lifecycleError("INVALID_STATE"), "CONFIRMATION_INVALID", 403],
    [lifecycleError("REVALIDATION_FAILED"), "REPLAN_REQUIRED", 409],
    [lifecycleError("PERSISTENCE_FAILURE"), "INTERNAL_ERROR", 500],
  ])("maps action failure %# without leaking details", (error, code, statusCode) => {
    expect(actionApiError(error)).toMatchObject({ code, statusCode });
    expect(actionApiError(error).message).not.toContain("private detail");
  });

  it.each([
    [undefined, "INTERNAL_ERROR", 500],
    ["SESSION_BUSY", "SESSION_BUSY", 409],
    ["POLICY_DENIED", "POLICY_DENIED", 403],
    ["POLICY_REPLAN_REQUIRED", "REPLAN_REQUIRED", 409],
    ["TOOL_ERROR", "DEPENDENCY_UNAVAILABLE", 503],
    ["CONTEXT_LOAD_FAILED", "DEPENDENCY_UNAVAILABLE", 503],
  ])("maps Runtime failure %s", (runtimeCode, code, statusCode) => {
    expect(runtimeApiError(runtimeCode)).toMatchObject({ code, statusCode });
  });

  it("creates immutable public events with defaults and caller-provided ids", () => {
    const generated = publicEvent({
      eventType: "run.started",
      runId: "run:test",
      traceId: "trace:test",
      timestamp: now,
    });
    const fixed = publicEvent({
      eventType: "assistant.delta",
      eventId: "event:fixed",
      runId: "run:test",
      traceId: "trace:test",
      timestamp: now,
      data: { delta: "safe" },
    });
    expect(generated.event_id).toMatch(/^api-event:/u);
    expect(generated.data).toEqual({});
    expect(fixed).toMatchObject({ event_id: "event:fixed", data: { delta: "safe" } });
    expect(Object.isFrozen(fixed.data)).toBe(true);
  });

  it.each([
    ["tool.requested", { tool: "unregistered_tool", tool_call_id: "unknown" }],
    ["policy.decision.made", { tool: "unknown", decision: "DENY", rule_id: "unknown" }],
    ["tool.completed", { tool: "unregistered_tool", tool_call_id: "unknown", is_error: false }],
    ["agent.run.failed", { code: "INTERNAL_ERROR" }],
  ] as const)("uses safe defaults for %s metadata", async (eventType, expected) => {
    const events: PublicRunEvent[] = [];
    const sink = createRuntimePublicEventSink((event) => {
      events.push(event);
    });
    await sink.emit({
      eventId: "event:test",
      eventType,
      runId: "run:test",
      sessionId: "session:test",
      traceId: "trace:test",
      timestamp: now,
    });
    expect(events[0]?.data).toEqual(expected);
  });

  it.each(["cancelled", "failed"] as const)(
    "does not emit assistant.completed for a %s run",
    async (status) => {
      const harness = createFakeApiHarness();
      await harness.service.createSession(identity, "session:test");
      harness.factory.nextResult = fakeRunResult({ status, errorCode: "MODEL_ERROR" });
      const events: PublicRunEvent[] = [];
      const result = await harness.service.sendMessage({
        sessionId: "session:test",
        prompt: "safe prompt",
        identity,
        emit: (event) => {
          events.push(event);
        },
      });
      expect(result.status).toBe(status);
      expect(events.some((event) => event.event_type === "assistant.completed")).toBe(false);
    },
  );

  it.each([
    "missing_action",
    "missing_challenge",
    "wrong_action_session",
    "wrong_action_user",
    "wrong_challenge_session",
    "wrong_user",
    "wrong_vehicle",
  ] as const)("fails closed when the confirmation boundary has %s", async (condition) => {
    const harness = createFakeApiHarness();
    await harness.service.createSession(identity, "session:test");
    const { action, result } = confirmationResult();
    harness.factory.nextResult = result;
    if (condition !== "missing_action") {
      const actionOverrides =
        condition === "wrong_vehicle"
          ? { vehicleId: "vehicle:other" }
          : condition === "wrong_action_session"
            ? { sessionId: "session:other" }
            : condition === "wrong_action_user"
              ? { userId: "user:other" }
              : {};
      harness.factory.actions.set(action.actionId, fakeAction(actionOverrides));
    }
    if (condition !== "missing_challenge") {
      harness.factory.challenges.set(action.actionId, {
        actionId: action.actionId,
        confirmationToken: "credential:test",
        sessionId: condition === "wrong_challenge_session" ? "session:other" : action.sessionId,
        userId: condition === "wrong_user" ? "user:other" : action.userId,
        expiresAt: action.expiresAt,
      });
    }
    await expect(
      harness.service.sendMessage({
        sessionId: "session:test",
        prompt: "reserve",
        identity,
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(harness.service.activeRequestCount).toBe(0);
  });

  it("maps a ConfirmationService lookup failure", async () => {
    const harness = createFakeApiHarness();
    harness.factory.getError = lifecycleError("ACTION_NOT_FOUND");
    await expect(harness.service.getAction("action:test", identity)).rejects.toMatchObject({
      code: "ACTION_NOT_FOUND",
    });
  });

  it("resumes a durable READY_FOR_EXECUTION action even after confirmation expiry", async () => {
    const harness = createFakeApiHarness();
    harness.factory.actions.set(
      "action:test",
      fakeAction({
        state: "READY_FOR_EXECUTION",
        expiresAt: toUtcTimestamp(Date.now() - 1),
      }),
    );
    await expect(
      harness.service.confirmAction({
        actionId: "action:test",
        sessionId: "session:test",
        confirmationCredential: "credential:test",
        identity,
      }),
    ).resolves.toMatchObject({ execution: { status: "SUCCEEDED" } });
  });

  it.each([
    ["SESSION_BUSY", "SESSION_BUSY"],
    ["POLICY_REPLAN_REQUIRED", "REPLAN_REQUIRED"],
  ] as const)("maps confirm Runtime error %s", async (runtimeCode, apiCode) => {
    const harness = createFakeApiHarness();
    harness.factory.actions.set("action:test", fakeAction());
    harness.factory.confirmError = new AgentRuntimeError(runtimeCode, "internal runtime detail");
    await expect(
      harness.service.confirmAction({
        actionId: "action:test",
        sessionId: "session:test",
        confirmationCredential: "credential:test",
        identity,
      }),
    ).rejects.toMatchObject({ code: apiCode });
  });

  it("fails safely if the action disappears after confirmation", async () => {
    const harness = createFakeApiHarness();
    harness.factory.actions.set("action:test", fakeAction());
    harness.factory.disappearAfterConfirm = true;
    await expect(
      harness.service.confirmAction({
        actionId: "action:test",
        sessionId: "session:test",
        confirmationCredential: "credential:test",
        identity,
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it.each(["reject", "cancel"] as const)("maps %s persistence failure", async (operation) => {
    const harness = createFakeApiHarness();
    harness.factory.actions.set("action:test", fakeAction());
    harness.factory[operation === "reject" ? "rejectError" : "cancelError"] =
      lifecycleError("PERSISTENCE_FAILURE");
    const call =
      operation === "reject"
        ? harness.service.rejectAction("action:test", "session:test", identity)
        : harness.service.cancelAction("action:test", "session:test", identity);
    await expect(call).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it.each([
    ["user:other", "vehicle:test"],
    ["user:test", "vehicle:other"],
  ])("hides an execution bound to %s/%s", async (userId, vehicleId) => {
    const harness = createFakeApiHarness();
    const request = {
      executionId: "execution:test",
      toolName: "reserve_charging_slot",
      validatedArguments: {},
      actionFingerprint: "a".repeat(64),
      runId: "run:test",
      sessionId: "session:test",
      userId,
      vehicleId,
      traceId: "trace:test",
      riskLevel: "R2",
      policyDecision: {} as never,
      idempotencyKey: "confirmed:action:test",
      createdAt: now,
    } as const;
    harness.executions.set(
      {
        executionId: request.executionId,
        toolName: request.toolName,
        actionFingerprint: request.actionFingerprint,
        idempotencyKey: request.idempotencyKey,
        state: "SUCCEEDED",
        attempts: Object.freeze([]),
        stateHistory: Object.freeze([]),
        createdAt: now,
        updatedAt: now,
      },
      fakeExecution,
      request,
    );
    await expect(harness.service.getExecution("execution:test", identity)).rejects.toMatchObject({
      code: "EXECUTION_NOT_FOUND",
    });
  });

  it("maps failed and completed message results through failureFor", () => {
    const harness = createFakeApiHarness();
    const base = {
      response: "",
      runId: "run:test",
      traceId: "trace:test",
      context: null,
      policyDecisions: [],
      actions: [],
    } as const;
    expect(harness.service.failureFor({ ...base, status: "completed" })).toBeUndefined();
    expect(
      harness.service.failureFor({ ...base, status: "failed", errorCode: "TOOL_ERROR" }),
    ).toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
  });
});
