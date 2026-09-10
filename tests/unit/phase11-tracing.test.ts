import { Writable } from "node:stream";

import { DriveGuardObservability } from "@driveguard/observability";
import { toUtcTimestamp } from "@driveguard/domain";
import type { RuntimeEventMetadata } from "@driveguard/agent-runtime";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";

function discardLogs(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

const systems: DriveGuardObservability[] = [];

afterEach(async () => {
  await Promise.all(systems.splice(0).map(async (system) => system.shutdown()));
});

async function buildTrace(): Promise<{
  readonly observability: DriveGuardObservability;
  readonly traceId: string;
  readonly spans: readonly ReadableSpan[];
}> {
  const observability = new DriveGuardObservability({
    service: "driveguard-api",
    logDestination: discardLogs(),
    collectProcessMetrics: false,
    captureInMemoryTracing: true,
  });
  systems.push(observability);
  const http = observability.startHttpRequest({
    method: "POST",
    route: "/v1/sessions/:sessionId/messages",
  });
  const traceId = http.traceId;
  const baseMs = Date.now();
  let step = 0;
  const timestamp = () => toUtcTimestamp(baseMs + step++);
  const runtime = async (
    eventType:
      | "agent.run.started"
      | "context.loaded"
      | "capabilities.resolved"
      | "model.started"
      | "tool.requested"
      | "policy.evaluation.started"
      | "policy.decision.made"
      | "tool.completed"
      | "model.resumed"
      | "agent.run.completed",
    metadata?: RuntimeEventMetadata,
  ) => {
    await observability.runtimeEventSink.emit({
      eventId: `event:${step}`,
      eventType,
      runId: "run:trace",
      sessionId: "session:trace",
      traceId,
      timestamp: timestamp(),
      ...(metadata === undefined ? {} : { metadata }),
    });
  };

  await runtime("agent.run.started");
  await runtime("context.loaded", { contextVersion: 1 });
  await runtime("capabilities.resolved", { availableToolCount: 14 });
  await runtime("model.started");
  observability.observeModelUsage({
    runId: "run:trace",
    sessionId: "session:trace",
    traceId,
    modelName: "faux-model",
    inputTokens: 5,
    outputTokens: 2,
    cost: 0,
    isError: false,
  });
  await runtime("tool.requested", { toolName: "get_vehicle_state", toolCallId: "tool-call:1" });
  await runtime("policy.evaluation.started", { toolName: "get_vehicle_state" });
  await runtime("policy.decision.made", {
    toolName: "get_vehicle_state",
    decision: "ALLOW",
    ruleId: "DG-POL-001",
  });
  const executionBase = {
    executionId: "execution:trace",
    runId: "run:trace",
    sessionId: "session:trace",
    traceId,
    toolName: "get_vehicle_state",
    attempt: 1,
  } as const;
  await observability.executionEventSink.emit({
    ...executionBase,
    eventType: "execution.started",
    timestamp: timestamp(),
  });
  await observability.executionEventSink.emit({
    ...executionBase,
    eventType: "execution.attempt.started",
    timestamp: timestamp(),
  });
  await observability.executionEventSink.emit({
    ...executionBase,
    eventType: "execution.succeeded",
    timestamp: timestamp(),
  });
  await runtime("tool.completed", {
    toolName: "get_vehicle_state",
    toolCallId: "tool-call:1",
    isError: false,
  });
  await runtime("model.resumed");
  await runtime("model.started");
  observability.observeModelUsage({
    runId: "run:trace",
    sessionId: "session:trace",
    traceId,
    modelName: "faux-model",
    inputTokens: 8,
    outputTokens: 3,
    cost: 0,
    isError: false,
  });
  await runtime("agent.run.completed");

  const actionBase = {
    eventId: "event:action",
    runId: "run:trace",
    sessionId: "session:trace",
    traceId,
    actionId: "action:trace",
    toolName: "reserve_charging_slot",
  } as const;
  await observability.actionLifecycleEventSink.emit({
    ...actionBase,
    eventType: "action.pending.created",
    timestamp: timestamp(),
    state: "AWAITING_CONFIRMATION",
  });
  await observability.actionLifecycleEventSink.emit({
    ...actionBase,
    eventType: "confirmation.accepted",
    timestamp: timestamp(),
    state: "CONFIRMED",
  });
  await observability.actionLifecycleEventSink.emit({
    ...actionBase,
    eventType: "action.revalidation.started",
    timestamp: timestamp(),
    state: "CONFIRMED",
  });
  await observability.actionLifecycleEventSink.emit({
    ...actionBase,
    eventType: "action.ready_for_execution",
    timestamp: timestamp(),
    state: "READY_FOR_EXECUTION",
  });
  http.end({ statusCode: 200, method: "POST", route: "/v1/sessions/:sessionId/messages" });
  await observability.tracing.forceFlush();
  return { observability, traceId, spans: observability.tracing.finishedSpans() };
}

const requiredSpanNames = [
  "http.request",
  "agent.run",
  "context.load",
  "capability.resolve",
  "llm.request",
  "tool.request",
  "policy.evaluate",
  "confirmation.wait",
  "confirmation.revalidate",
  "executor.execute",
  "executor.attempt",
  "tool.execute",
  "simulator.request",
  "dependency.http",
  "persistence.write",
] as const;

describe("Phase 11 OpenTelemetry tracing", () => {
  it.each(requiredSpanNames)("creates the required span %s", async (name) => {
    const { spans } = await buildTrace();
    expect(spans.some((span) => span.name === name)).toBe(true);
  });

  it("uses the HTTP OpenTelemetry trace ID as the DriveGuard business trace ID", async () => {
    const { traceId, spans } = await buildTrace();
    expect(traceId).toMatch(/^[a-f0-9]{32}$/u);
    expect(new Set(spans.map((span) => span.spanContext().traceId))).toEqual(new Set([traceId]));
  });

  it("keeps completed non-Agent health requests as independent traces", async () => {
    const observability = new DriveGuardObservability({
      service: "test",
      logDestination: discardLogs(),
      collectProcessMetrics: false,
      captureInMemoryTracing: true,
    });
    systems.push(observability);
    for (let index = 0; index < 4_200; index += 1) {
      const http = observability.startHttpRequest({ method: "GET", route: "/health/live" });
      http.end({ statusCode: 200, method: "GET", route: "/health/live" });
    }
    await observability.tracing.forceFlush();
    const spans = observability.tracing.finishedSpans();
    expect(spans).toHaveLength(4_200);
    expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(4_200);
  });

  it("preserves the required HTTP -> Agent parent relationship", async () => {
    const { spans } = await buildTrace();
    const http = spans.find((span) => span.name === "http.request");
    const agent = spans.find((span) => span.name === "agent.run");
    expect(agent?.parentSpanContext?.spanId).toBe(http?.spanContext().spanId);
  });

  it("parents Context, capability, LLM, and Tool request spans under Agent", async () => {
    const { spans } = await buildTrace();
    const agentId = spans.find((span) => span.name === "agent.run")?.spanContext().spanId;
    for (const name of ["context.load", "capability.resolve", "llm.request", "tool.request"]) {
      expect(spans.find((span) => span.name === name)?.parentSpanContext?.spanId).toBe(agentId);
    }
  });

  it("parents Policy and Executor under the Tool request", async () => {
    const { spans } = await buildTrace();
    const toolRequestId = spans.find((span) => span.name === "tool.request")?.spanContext().spanId;
    expect(spans.find((span) => span.name === "policy.evaluate")?.parentSpanContext?.spanId).toBe(
      toolRequestId,
    );
    expect(spans.find((span) => span.name === "executor.execute")?.parentSpanContext?.spanId).toBe(
      toolRequestId,
    );
  });

  it("parents attempt -> Tool execute -> Simulator -> dependency HTTP correctly", async () => {
    const { spans } = await buildTrace();
    const execution = spans.find((span) => span.name === "executor.execute");
    const attempt = spans.find((span) => span.name === "executor.attempt");
    const tool = spans.find((span) => span.name === "tool.execute");
    const simulator = spans.find((span) => span.name === "simulator.request");
    const dependency = spans.find((span) => span.name === "dependency.http");
    expect(attempt?.parentSpanContext?.spanId).toBe(execution?.spanContext().spanId);
    expect(tool?.parentSpanContext?.spanId).toBe(attempt?.spanContext().spanId);
    expect(simulator?.parentSpanContext?.spanId).toBe(tool?.spanContext().spanId);
    expect(dependency?.parentSpanContext?.spanId).toBe(simulator?.spanContext().spanId);
  });

  it("attaches correlation fields to every defined business span", async () => {
    const { spans, traceId } = await buildTrace();
    const businessSpans = spans.filter((span) => span.name !== "http.request");
    expect(businessSpans.length).toBeGreaterThan(0);
    for (const span of businessSpans) {
      expect(span.attributes["driveguard.trace_id"]).toBe(traceId);
      expect(span.attributes["driveguard.run_id"]).toBe("run:trace");
      expect(span.attributes["driveguard.session_id"]).toBe("session:trace");
    }
  });

  it("marks failed attempts and dependencies with a safe error code", async () => {
    const observability = new DriveGuardObservability({
      service: "test",
      logDestination: discardLogs(),
      collectProcessMetrics: false,
      captureInMemoryTracing: true,
    });
    systems.push(observability);
    const traceId = "f".repeat(32);
    const base = {
      executionId: "execution:failed",
      runId: "run:failed",
      sessionId: "session:failed",
      traceId,
      toolName: "get_vehicle_state",
      attempt: 1,
      timestamp: toUtcTimestamp(Date.now()),
    } as const;
    await observability.executionEventSink.emit({ ...base, eventType: "execution.started" });
    await observability.executionEventSink.emit({
      ...base,
      eventType: "execution.attempt.started",
    });
    await observability.executionEventSink.emit({
      ...base,
      eventType: "execution.attempt.failed",
      errorCode: "DEPENDENCY_TIMEOUT",
    });
    await observability.executionEventSink.emit({
      ...base,
      eventType: "execution.failed",
      errorCode: "RETRY_EXHAUSTED",
    });
    await observability.tracing.forceFlush();
    const failed = observability.tracing
      .finishedSpans()
      .filter((span) =>
        ["executor.attempt", "tool.execute", "simulator.request", "dependency.http"].includes(
          span.name,
        ),
      );
    expect(failed).toHaveLength(4);
    expect(failed.every((span) => span.attributes["error.type"] === "DEPENDENCY_TIMEOUT")).toBe(
      true,
    );
  });

  it("isolates observer exceptions from event sink callers", async () => {
    const observability = new DriveGuardObservability({
      service: "test",
      logDestination: discardLogs(),
      collectProcessMetrics: false,
      captureInMemoryTracing: true,
    });
    systems.push(observability);
    (observability.metrics as unknown as { observeRuntime: () => void }).observeRuntime = () => {
      throw new Error("metrics backend failed");
    };
    await expect(
      Promise.resolve(
        observability.runtimeEventSink.emit({
          eventId: "event:isolation",
          eventType: "agent.run.started",
          runId: "run:isolation",
          sessionId: "session:isolation",
          traceId: "1".repeat(32),
          timestamp: toUtcTimestamp(Date.now()),
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
