import { describe, expect, it } from "vitest";

import { ApiError } from "../../apps/api/src/errors.js";
import { createRuntimePublicEventSink, type PublicRunEvent } from "../../apps/api/src/events.js";
import { createFakeApiHarness, fakeAction } from "../fixtures/phase10-api.js";
import { toUtcTimestamp } from "@driveguard/domain";
import type { RuntimeEvent } from "@driveguard/agent-runtime";

const identity = { userId: "user:test", vehicleId: "vehicle:test" } as const;
const at = toUtcTimestamp(Date.now());

describe("Phase 10 Service and streaming lifecycle", () => {
  it("rejects a concurrent request before a second Runtime is created", async () => {
    const harness = createFakeApiHarness();
    await harness.service.createSession(identity, "session:test");
    harness.factory.delayRun = true;
    const first = harness.service.sendMessage({
      sessionId: "session:test",
      prompt: "first",
      identity,
    });
    while (harness.service.activeRequestCount === 0) await Promise.resolve();
    await expect(
      harness.service.sendMessage({ sessionId: "session:test", prompt: "second", identity }),
    ).rejects.toMatchObject({ code: "SESSION_BUSY" });
    expect(harness.factory.inputs).toHaveLength(1);
    harness.factory.runRelease?.();
    await first;
  });

  it("cancels the active Runtime and releases the local request slot", async () => {
    const harness = createFakeApiHarness();
    await harness.service.createSession(identity, "session:test");
    harness.factory.delayRun = true;
    const run = harness.service.sendMessage({
      sessionId: "session:test",
      prompt: "wait",
      identity,
    });
    while (harness.service.activeRequestCount === 0) await Promise.resolve();
    expect(harness.service.cancelSession("session:test")).toBe(true);
    await run;
    expect(harness.factory.cancelCalls).toBe(1);
    expect(harness.service.activeRequestCount).toBe(0);
  });

  it("returns false when no cancellable request exists", () => {
    expect(createFakeApiHarness().service.cancelSession("session:none")).toBe(false);
  });

  it.each(["get", "confirm", "reject", "cancel"])(
    "hides a cross-vehicle action operation: %s",
    async (operation) => {
      const harness = createFakeApiHarness();
      harness.factory.actions.set("action:test", fakeAction({ vehicleId: "vehicle:other" }));
      const invoke = async () => {
        switch (operation) {
          case "get":
            return harness.service.getAction("action:test", identity);
          case "confirm":
            return harness.service.confirmAction({
              actionId: "action:test",
              sessionId: "session:test",
              confirmationCredential: "credential:test",
              identity,
            });
          case "reject":
            return harness.service.rejectAction("action:test", "session:test", identity);
          default:
            return harness.service.cancelAction("action:test", "session:test", identity);
        }
      };
      await expect(invoke()).rejects.toMatchObject({ code: "ACTION_NOT_FOUND" });
    },
  );

  it("does not expose exception details through a generic ApiError", () => {
    const error = new ApiError("INTERNAL_ERROR", "The request failed safely", 500);
    expect(error.message).not.toMatch(/stack|\/home\/|password|secret/iu);
  });

  it.each([
    ["agent.run.started", "run.started"],
    ["tool.requested", "tool.requested"],
    ["policy.decision.made", "policy.decision"],
    ["tool.completed", "tool.completed"],
    ["agent.run.failed", "run.failed"],
  ] as const)("maps Runtime event %s to public event %s", async (runtimeType, publicType) => {
    const events: PublicRunEvent[] = [];
    const sink = createRuntimePublicEventSink((event) => {
      events.push(event);
    });
    const event: RuntimeEvent = {
      eventId: "event:test",
      eventType: runtimeType,
      runId: "run:test",
      sessionId: "session:test",
      traceId: "trace:test",
      timestamp: at,
      metadata: {
        toolName: "get_vehicle_state",
        toolCallId: "tool-call:1",
        decision: "ALLOW",
        ruleId: "DG-POL-010",
        errorCode: "MODEL_ERROR",
      },
    };
    await sink.emit(event);
    expect(events.map((item) => item.event_type)).toEqual([publicType]);
    expect(JSON.stringify(events)).not.toMatch(/session:test|validatedArguments|reasoning/iu);
  });

  it.each(["context.loaded", "capabilities.resolved", "model.started", "model.resumed"] as const)(
    "does not expose internal Runtime event %s",
    async (runtimeType) => {
      const events: PublicRunEvent[] = [];
      const sink = createRuntimePublicEventSink((event) => {
        events.push(event);
      });
      await sink.emit({
        eventId: "event:test",
        eventType: runtimeType,
        runId: "run:test",
        sessionId: "session:test",
        traceId: "trace:test",
        timestamp: at,
      });
      expect(events).toEqual([]);
    },
  );

  it("suppresses Runtime's control failure when confirmation is the intended outcome", async () => {
    const events: PublicRunEvent[] = [];
    const sink = createRuntimePublicEventSink((event) => {
      events.push(event);
    });
    await sink.emit({
      eventId: "event:test",
      eventType: "agent.run.failed",
      runId: "run:test",
      sessionId: "session:test",
      traceId: "trace:test",
      timestamp: at,
      metadata: { errorCode: "POLICY_CONFIRMATION_REQUIRED" },
    });
    expect(events).toEqual([]);
  });
});
