import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { AgentRun, PiEventAdapter } from "@driveguard/agent-runtime";
import { FixedClock } from "@driveguard/shared";

import { RequestAdmissionController } from "../../apps/api/src/admission-control.js";
import { buildApi } from "../../apps/api/src/app.js";
import { gracefulShutdown, GracefulShutdownTimeoutError } from "../../apps/api/src/shutdown.js";
import { DriveGuardApiService } from "../../apps/api/src/service.js";
import { DriveGuardMetrics } from "../../packages/observability/src/metrics.js";
import { createFakeApiHarness } from "../../tests/fixtures/phase10-api.js";

const apps: ReturnType<typeof buildApi>[] = [];

afterEach(async () => {
  await Promise.allSettled(apps.splice(0).map((app) => app.close()));
});

async function eventually(predicate: () => boolean, attempts = 200): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not reached");
}

describe("Phase 14 timeout budget and graceful shutdown", () => {
  it("cancels an over-budget Agent run and waits for settlement", async () => {
    const harness = createFakeApiHarness();
    const service = new DriveGuardApiService({
      sessions: harness.sessions,
      conversation: harness.conversation,
      executions: harness.executions,
      runtimeFactory: harness.factory,
      agentTimeoutMs: 100,
    });
    const identity = { userId: "user:budget", vehicleId: "vehicle:budget" };
    await service.createSession(identity, "session:budget");
    harness.factory.delayRun = true;

    const result = service.sendMessage({
      sessionId: "session:budget",
      prompt: "phase14 timeout",
      identity,
    });
    await eventually(() => service.activeRequestCount === 1);
    expect((await result).status).toBe("completed");
    expect(harness.factory.cancelCalls).toBe(1);
    expect(service.activeRequestCount).toBe(0);
  });

  it("stops admission first and drains accepted HTTP work", async () => {
    const admissionController = new RequestAdmissionController({
      maxConcurrent: 2,
      maxQueue: 2,
      queueTimeoutMs: 1_000,
    });
    const app = buildApi({ admissionController });
    apps.push(app);
    app.get("/v1/drain", async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { drained: true };
    });
    const response = app.inject({ method: "GET", url: "/v1/drain" });
    await eventually(() => admissionController.snapshot().active === 1);

    await gracefulShutdown({ app, admissionController, timeoutMs: 1_000 });
    expect((await response).statusCode).toBe(200);
    expect(admissionController.snapshot()).toMatchObject({
      accepting: false,
      active: 0,
      queued: 0,
    });
  });

  it("reports a finite shutdown deadline breach", async () => {
    const admissionController = new RequestAdmissionController({
      maxConcurrent: 1,
      maxQueue: 1,
      queueTimeoutMs: 1_000,
    });
    let releaseClose: (() => void) | undefined;
    const closePromise = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const app = { close: () => closePromise } as FastifyInstance;
    await expect(
      gracefulShutdown({ app, admissionController, timeoutMs: 5 }),
    ).rejects.toBeInstanceOf(GracefulShutdownTimeoutError);
    expect(admissionController.snapshot().accepting).toBe(false);
    releaseClose?.();
  });
});

describe("Phase 14 capacity and dependency metrics", () => {
  it("measures provider streaming separately from Tool execution", async () => {
    const clock = new FixedClock(Date.parse("2026-09-06T00:00:00.000Z"));
    const run = new AgentRun(
      {
        runId: "run:provider-timing",
        sessionId: "session:provider-timing",
        traceId: "trace:provider-timing",
        createdAt: "2026-09-06T00:00:00.000Z" as never,
      },
      clock,
    );
    run.transition("CONTEXT_LOADING");
    run.transition("CAPABILITY_RESOLUTION");
    run.transition("MODEL_RUNNING");
    let nowMs = 1_000;
    const usage: unknown[] = [];
    const adapter = new PiEventAdapter({
      run,
      exposedToolNames: [],
      eventFactory: { create: () => ({}) as never },
      emit: () => undefined,
      nowMs: () => nowMs,
      modelUsage: (event) => {
        usage.push(event);
      },
    });
    await adapter.observe({ type: "turn_start" });
    nowMs = 1_125;
    const message = {
      role: "assistant",
      model: "faux",
      content: [],
      usage: { input: 10, output: 5, cost: { total: 0 } },
      stopReason: "stop",
    } as never;
    await adapter.observe({ type: "message_end", message });
    nowMs = 9_000;
    await adapter.observe({ type: "turn_end", message, toolResults: [] });
    expect(usage).toMatchObject([{ providerDurationMs: 125 }]);
  });

  it("exports bounded admission, Executor, pool, Redis, and NATS gauges", async () => {
    const metrics = new DriveGuardMetrics({ collectProcessMetrics: false });
    metrics.observeAdmission({ accepting: true, active: 3, queued: 4, rejected: 2 });
    metrics.observeExecutionCapacity({
      readActive: 4,
      writeActive: 2,
      activeVehicles: 2,
      queued: 5,
      rejected: 1,
    });
    metrics.observeInfrastructure({
      postgresTotal: 10,
      postgresIdle: 3,
      postgresWaiting: 2,
      redisReady: true,
      natsPending: 7,
      natsAckPending: 1,
    });
    metrics.observeModelUsage({
      runId: "run:phase14",
      sessionId: "session:phase14",
      traceId: "trace:phase14",
      modelName: "faux",
      inputTokens: 10,
      outputTokens: 5,
      cost: 0,
      isError: false,
      providerDurationMs: 125,
    });
    const text = await metrics.metrics();
    expect(text).toContain("driveguard_admission_active 3");
    expect(text).toContain("driveguard_admission_queued 4");
    expect(text).toContain("driveguard_admission_rejected_total 2");
    expect(text).toContain('driveguard_executor_active{kind="read"} 4');
    expect(text).toContain('driveguard_executor_active{kind="write"} 2');
    expect(text).toContain('driveguard_postgres_pool_connections{state="waiting"} 2');
    expect(text).toContain("driveguard_redis_connection_ready 1");
    expect(text).toContain('driveguard_nats_consumer_messages{state="pending"} 7');
    expect(text).toContain(
      'driveguard_llm_provider_duration_seconds_sum{model="faux",status="success"} 0.125',
    );
  });
});
