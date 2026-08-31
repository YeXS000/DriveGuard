import { Writable } from "node:stream";

import { DriveGuardLogger, DriveGuardMetrics, createPinoLogger } from "@driveguard/observability";
import { toUtcTimestamp } from "@driveguard/domain";
import { describe, expect, it } from "vitest";

function captureDestination(): { readonly lines: string[]; readonly destination: Writable } {
  const lines: string[] = [];
  return {
    lines,
    destination: new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    }),
  };
}

describe("Phase 11 structured logging", () => {
  it.each([
    "authorization",
    "Authorization",
    "cookie",
    "Cookie",
    "confirmationToken",
    "confirmationCredential",
    "executionAuthorization",
    "executionAuthorizationSecret",
    "DEEPSEEK_API_KEY",
    "apiKey",
    "prompt",
    "reasoning",
  ])("centrally redacts the sensitive field %s", (field) => {
    const capture = captureDestination();
    const logger = createPinoLogger({ service: "test", destination: capture.destination });
    logger.info({ [field]: "forbidden-secret-value" });
    logger.flush();
    const output = capture.lines.join("");
    expect(output).not.toContain("forbidden-secret-value");
    expect(output).toContain("[REDACTED]");
  });

  it("redacts nested request headers and bodies", () => {
    const capture = captureDestination();
    const logger = createPinoLogger({ service: "test", destination: capture.destination });
    logger.info({
      req: {
        headers: { authorization: "Bearer forbidden", cookie: "session=forbidden" },
        body: { prompt: "complete sensitive user input" },
      },
    });
    logger.flush();
    expect(capture.lines.join("")).not.toMatch(
      /Bearer forbidden|session=forbidden|sensitive user/u,
    );
  });

  it("always writes the required structured correlation fields", () => {
    const capture = captureDestination();
    const logger = new DriveGuardLogger({
      service: "driveguard-api",
      destination: capture.destination,
    });
    logger.write(
      "info",
      "policy.decision.made",
      { traceId: "a".repeat(32), runId: "run:test", sessionId: "session:test" },
      { policyDecision: "ALLOW" },
    );
    logger.flush();
    const record = JSON.parse(capture.lines[0] ?? "{}") as Record<string, unknown>;
    expect(record).toMatchObject({
      level: "info",
      service: "driveguard-api",
      event: "policy.decision.made",
      traceId: "a".repeat(32),
      runId: "run:test",
      sessionId: "session:test",
      policyDecision: "ALLOW",
    });
    expect(record.timestamp).toEqual(expect.any(String));
  });

  it("removes configured secret values even when supplied under an allowed detail", () => {
    const capture = captureDestination();
    const logger = new DriveGuardLogger({
      service: "driveguard-api",
      destination: capture.destination,
      sensitiveValues: ["live-provider-secret"],
    });
    logger.write(
      "error",
      "dependency.failed",
      { traceId: null, runId: null, sessionId: null },
      { errorCode: "live-provider-secret" },
    );
    logger.flush();
    expect(capture.lines.join("")).not.toContain("live-provider-secret");
  });
});

const requiredMetricNames = [
  "driveguard_http_requests_total",
  "driveguard_http_request_duration_seconds",
  "driveguard_agent_runs_total",
  "driveguard_agent_run_duration_seconds",
  "driveguard_tool_calls_total",
  "driveguard_tool_duration_seconds",
  "driveguard_policy_decisions_total",
  "driveguard_policy_duration_seconds",
  "driveguard_confirmations_total",
  "driveguard_confirmation_pending",
  "driveguard_executions_total",
  "driveguard_execution_duration_seconds",
  "driveguard_execution_attempts_total",
  "driveguard_retries_total",
  "driveguard_circuit_state",
  "driveguard_llm_tokens_total",
  "driveguard_llm_cost_total",
  "driveguard_context_conflicts_total",
  "driveguard_dependency_up",
] as const;

describe("Phase 11 Prometheus metrics", () => {
  it.each(requiredMetricNames)("registers the required metric family %s", async (name) => {
    const metrics = new DriveGuardMetrics({ collectProcessMetrics: false });
    expect(await metrics.metrics()).toContain(`# HELP ${name} `);
  });

  it("records HTTP counters and latency without request identities as labels", async () => {
    const metrics = new DriveGuardMetrics({ collectProcessMetrics: false });
    metrics.observeHttp({
      method: "POST",
      route: "/v1/sessions/:sessionId/messages",
      statusCode: 200,
      durationSeconds: 0.025,
    });
    const text = await metrics.metrics();
    expect(text).toContain(
      'driveguard_http_requests_total{method="POST",route="/v1/sessions/:sessionId/messages",status_code="200"} 1',
    );
    expect(text).not.toMatch(/userId=|sessionId=|runId=|traceId=|actionId=/u);
  });

  it("records all four bounded Policy decisions", async () => {
    const metrics = new DriveGuardMetrics({ collectProcessMetrics: false });
    const at = toUtcTimestamp(Date.now());
    for (const decision of ["ALLOW", "DENY", "REPLAN", "REQUIRE_CONFIRMATION"] as const) {
      metrics.observeRuntime({
        eventId: `event:${decision}:start`,
        eventType: "policy.evaluation.started",
        runId: `run:${decision}`,
        sessionId: "session:test",
        traceId: "b".repeat(32),
        timestamp: at,
        metadata: { toolName: "get_vehicle_state" },
      });
      metrics.observeRuntime({
        eventId: `event:${decision}:end`,
        eventType: "policy.decision.made",
        runId: `run:${decision}`,
        sessionId: "session:test",
        traceId: "b".repeat(32),
        timestamp: at,
        metadata: {
          toolName: "get_vehicle_state",
          decision,
          ...(decision === "REPLAN" ? { reasonCode: "CONTEXT_STALE" } : {}),
        },
      });
    }
    const text = await metrics.metrics();
    for (const decision of ["ALLOW", "DENY", "REPLAN", "REQUIRE_CONFIRMATION"]) {
      expect(text).toContain(`decision="${decision}"`);
    }
    expect(text).toContain('driveguard_context_conflicts_total{decision="REPLAN"} 1');
  });

  it("records confirmation pending and terminal lifecycle signals", async () => {
    const metrics = new DriveGuardMetrics({ collectProcessMetrics: false });
    const base = {
      eventId: "event:action",
      runId: "run:test",
      sessionId: "session:test",
      traceId: "c".repeat(32),
      actionId: "action:test",
      toolName: "reserve_charging_slot",
      timestamp: toUtcTimestamp(Date.now()),
    } as const;
    metrics.observeAction({
      ...base,
      eventType: "action.pending.created",
      state: "AWAITING_CONFIRMATION",
    });
    metrics.observeAction({
      ...base,
      eventType: "action.ready_for_execution",
      state: "READY_FOR_EXECUTION",
    });
    const text = await metrics.metrics();
    expect(text).toContain("driveguard_confirmation_pending 0");
    expect(text).toContain('driveguard_confirmations_total{event="action.pending.created"} 1');
    expect(text).toContain('driveguard_confirmations_total{event="action.ready_for_execution"} 1');
  });

  it("does not make the pending gauge negative for a terminal event restored after restart", async () => {
    const metrics = new DriveGuardMetrics({ collectProcessMetrics: false });
    metrics.observeAction({
      eventId: "event:restored-action",
      eventType: "action.ready_for_execution",
      runId: "run:restored",
      sessionId: "session:restored",
      traceId: "c".repeat(32),
      actionId: "action:restored",
      toolName: "reserve_charging_slot",
      timestamp: toUtcTimestamp(Date.now()),
      state: "READY_FOR_EXECUTION",
    });
    const text = await metrics.metrics();
    expect(text).toContain("driveguard_confirmation_pending 0");
    expect(text).not.toContain("driveguard_confirmation_pending -1");
  });

  it("records execution attempts, retry errors, terminal outcome, and circuit state", async () => {
    const metrics = new DriveGuardMetrics({ collectProcessMetrics: false });
    const base = {
      executionId: "execution:test",
      runId: "run:test",
      sessionId: "session:test",
      traceId: "d".repeat(32),
      toolName: "get_vehicle_state",
      attempt: 1,
      timestamp: toUtcTimestamp(Date.now()),
    } as const;
    metrics.observeExecution({ ...base, eventType: "execution.started" });
    metrics.observeExecution({ ...base, eventType: "execution.attempt.started" });
    metrics.observeExecution({
      ...base,
      eventType: "execution.retry.scheduled",
      errorCode: "DEPENDENCY_UNAVAILABLE",
      delayMs: 10,
    });
    metrics.observeExecution({ ...base, eventType: "circuit.opened" });
    metrics.observeExecution({
      ...base,
      eventType: "execution.failed",
      errorCode: "RETRY_EXHAUSTED",
    });
    const text = await metrics.metrics();
    expect(text).toContain('driveguard_execution_attempts_total{tool_name="get_vehicle_state"} 1');
    expect(text).toContain(
      'driveguard_retries_total{tool_name="get_vehicle_state",error_code="DEPENDENCY_UNAVAILABLE"} 1',
    );
    expect(text).toContain('driveguard_circuit_state{tool_name="get_vehicle_state"} 1');
    expect(text).toContain(
      'driveguard_executions_total{tool_name="get_vehicle_state",status="failed"} 1',
    );
  });

  it("records provider-reported tokens and cost without prompt labels", async () => {
    const metrics = new DriveGuardMetrics({ collectProcessMetrics: false });
    metrics.observeModelUsage({
      runId: "run:test",
      sessionId: "session:test",
      traceId: "e".repeat(32),
      modelName: "faux-model",
      inputTokens: 10,
      outputTokens: 4,
      cost: 0.001,
      isError: false,
    });
    const text = await metrics.metrics();
    expect(text).toContain('driveguard_llm_tokens_total{direction="input",model="faux-model"} 10');
    expect(text).toContain('driveguard_llm_tokens_total{direction="output",model="faux-model"} 4');
    expect(text).toContain('driveguard_llm_cost_total{model="faux-model"} 0.001');
    expect(text).not.toContain("prompt=");
  });
});
