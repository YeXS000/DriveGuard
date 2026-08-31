import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";

import { createActionFingerprint } from "@driveguard/action-lifecycle";
import {
  createProductionDriveGuardRuntime,
  DEFAULT_PHASE_5_CAPABILITIES,
  DEFAULT_PHASE_5_SERVICES,
} from "@driveguard/agent-runtime";
import { toUtcTimestamp } from "@driveguard/domain";
import {
  InMemoryConversationRepository,
  InMemorySessionCoordinator,
  InMemorySessionRepository,
  RepositoryConversationMemory,
} from "@driveguard/memory";
import { DriveGuardObservability } from "@driveguard/observability";
import { InMemoryExecutionRepository } from "@driveguard/persistence";
import {
  ReliableToolExecutor,
  type ExecutionAuthorizationConsumer,
  type ExecutionRequest,
  type Sleeper,
} from "@driveguard/executor";
import { PolicyEngine } from "@driveguard/policy";
import type { Clock } from "@driveguard/shared";
import {
  createDriveGuardToolRegistry,
  DevelopmentEmergencySupportProvider,
  DevelopmentWeatherProvider,
  SimulatorClient,
  type FormalToolName,
  type ToolDefinition,
} from "@driveguard/tools";
import { buildVehicleSimulator } from "@driveguard/vehicle-simulator";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApi } from "../../apps/api/src/app.js";
import {
  DriveGuardApiService,
  type Phase10RuntimeFactory,
  type Phase10RuntimeFactoryInput,
} from "../../apps/api/src/service.js";
import { PHASE6_EVALUATED_AT, policyInput } from "../fixtures/phase6-policy.js";
import { InMemoryPendingActionRepository } from "../../packages/action-lifecycle/src/repository.js";

const identityHeaders = {
  "x-driveguard-user-id": "user:phase11",
  "x-driveguard-vehicle-id": "simulator-vehicle-001",
};
const identity = { userId: "user:phase11", vehicleId: "simulator-vehicle-001" } as const;

function discardLogs(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

let simulator: FastifyInstance;
let simulatorBaseUrl: string;
const observabilitySystems: DriveGuardObservability[] = [];

beforeAll(async () => {
  simulator = buildVehicleSimulator();
  simulatorBaseUrl = await simulator.listen({ host: "127.0.0.1", port: 0 });
});

afterAll(async () => {
  await simulator.close();
});

beforeEach(async () => {
  const reset = await simulator.inject({
    method: "POST",
    url: "/simulator/reset",
    payload: { scenario: "low_soc", seed: 1111 },
  });
  expect(reset.statusCode).toBe(200);
});

afterEach(async () => {
  await Promise.all(observabilitySystems.splice(0).map(async (system) => system.shutdown()));
});

class ObservableRuntimeFactory implements Phase10RuntimeFactory {
  readonly pending = new InMemoryPendingActionRepository();
  readonly coordinator = new InMemorySessionCoordinator();
  readonly #conversation: RepositoryConversationMemory;
  readonly #observability: DriveGuardObservability;

  constructor(conversation: RepositoryConversationMemory, observability: DriveGuardObservability) {
    this.#conversation = conversation;
    this.#observability = observability;
  }

  create(input: Phase10RuntimeFactoryInput) {
    const faux = fauxProvider({
      provider: `phase11-integration-${randomUUID()}`,
      api: `phase11-integration-api-${randomUUID()}`,
      tokensPerSecond: 5_000,
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const prompt = input.prompt?.toLowerCase() ?? "";
    if (prompt.includes("roadside")) {
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall(
            "request_roadside_assistance",
            { reason: "flat tire" },
            { id: `tool:${randomUUID()}` },
          ),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("Confirmation is required."),
      ]);
    } else if (prompt.includes("reserve")) {
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall(
            "reserve_charging_slot",
            { stationId: "station-pudong-001" },
            { id: `tool:${randomUUID()}` },
          ),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("Confirmation is required."),
      ]);
    } else {
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("get_vehicle_state", {}, { id: `tool:${randomUUID()}` }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("Vehicle state retrieved."),
      ]);
    }
    const runtimeEventSink = {
      emit: async (event: Parameters<DriveGuardObservability["runtimeEventSink"]["emit"]>[0]) => {
        await input.runtimeEventSink?.emit(event);
        await this.#observability.runtimeEventSink.emit(event);
      },
    };
    const actionLifecycleEventSink = {
      emit: async (
        event: Parameters<DriveGuardObservability["actionLifecycleEventSink"]["emit"]>[0],
      ) => {
        await input.actionLifecycleEventSink?.emit(event);
        await this.#observability.actionLifecycleEventSink.emit(event);
      },
    };
    const executionEventSink = {
      emit: async (event: Parameters<DriveGuardObservability["executionEventSink"]["emit"]>[0]) => {
        await input.executionEventSink?.emit(event);
        await this.#observability.executionEventSink.emit(event);
      },
    };
    return createProductionDriveGuardRuntime({
      model: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
      simulatorBaseUrl,
      capabilities: DEFAULT_PHASE_5_CAPABILITIES,
      serviceAvailability: DEFAULT_PHASE_5_SERVICES,
      user: { userId: input.identity.userId as never, role: "driver" },
      mode: "development",
      developmentExecutionOptIn: true,
      pendingActionRepository: this.pending,
      conversationMemory: this.#conversation,
      sessionCoordinator: this.coordinator,
      actionLifecycleEventSink,
      executionEventSink,
      runtimeOverrides: {
        eventSink: runtimeEventSink,
        ...(input.assistantTextDeltaSink === undefined
          ? {}
          : { assistantTextDeltaSink: input.assistantTextDeltaSink }),
        modelUsageSink: (usage) => this.#observability.observeModelUsage(usage),
      },
    });
  }
}

function createHarness() {
  const observability = new DriveGuardObservability({
    service: "driveguard-api",
    logDestination: discardLogs(),
    collectProcessMetrics: false,
    captureInMemoryTracing: true,
  });
  observabilitySystems.push(observability);
  const sessions = new InMemorySessionRepository();
  const conversation = new RepositoryConversationMemory({
    sessions,
    conversation: new InMemoryConversationRepository(),
  });
  const runtimeFactory = new ObservableRuntimeFactory(conversation, observability);
  const service = new DriveGuardApiService({
    sessions,
    conversation,
    executions: new InMemoryExecutionRepository(),
    runtimeFactory,
  });
  const app = buildApi({ service, observability });
  return { app, service, observability };
}

describe("Phase 11 end-to-end observability flows", () => {
  it("observes an R0 API -> Runtime -> Policy -> Executor -> Tool flow", async () => {
    const { app, service, observability } = createHarness();
    await service.createSession(identity, "session:phase11-r0");
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions/session:phase11-r0/messages",
      headers: identityHeaders,
      payload: { prompt: "get vehicle state" },
    });
    expect(response.statusCode).toBe(200);
    const result = response.json<{ data: { traceId: string; runId: string } }>().data;
    expect(result.traceId).toMatch(/^[a-f0-9]{32}$/u);
    await observability.tracing.forceFlush();
    const spans = observability.tracing.finishedSpans();
    for (const name of [
      "http.request",
      "agent.run",
      "policy.evaluate",
      "executor.execute",
      "tool.execute",
      "simulator.request",
      "dependency.http",
      "persistence.write",
    ]) {
      expect(spans.some((span) => span.name === name)).toBe(true);
    }
    expect(new Set(spans.map((span) => span.spanContext().traceId))).toEqual(
      new Set([result.traceId]),
    );
    const metrics = await observability.metricsText();
    expect(metrics).toContain('driveguard_agent_runs_total{status="succeeded"} 1');
    expect(metrics).toContain(
      'driveguard_policy_decisions_total{decision="ALLOW",tool_name="get_vehicle_state"} 1',
    );
    expect(metrics).toContain(
      'driveguard_executions_total{tool_name="get_vehicle_state",status="succeeded"} 1',
    );
    await app.close();
  });

  it("observes an R2 Policy -> Confirmation -> revalidation -> Executor -> Tool flow", async () => {
    const { app, service, observability } = createHarness();
    await service.createSession(identity, "session:phase11-r2");
    const pending = await app.inject({
      method: "POST",
      url: "/v1/sessions/session:phase11-r2/messages",
      headers: identityHeaders,
      payload: { prompt: "reserve charging" },
    });
    expect(pending.statusCode).toBe(200);
    const data = pending.json<{
      data: {
        traceId: string;
        actions: { actionId: string; confirmationCredential: string }[];
      };
    }>().data;
    const action = data.actions[0];
    expect(action).toBeDefined();
    const confirmed = await app.inject({
      method: "POST",
      url: `/v1/actions/${action?.actionId}/confirm`,
      headers: identityHeaders,
      payload: {
        sessionId: "session:phase11-r2",
        confirmationCredential: action?.confirmationCredential,
      },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ data: { execution: { status: "SUCCEEDED" } } });
    await observability.tracing.forceFlush();
    const correlated = observability.tracing
      .finishedSpans()
      .filter((span) => span.attributes["driveguard.trace_id"] === data.traceId);
    for (const name of [
      "confirmation.wait",
      "confirmation.revalidate",
      "executor.execute",
      "tool.execute",
      "simulator.request",
      "dependency.http",
      "persistence.write",
    ]) {
      expect(correlated.some((span) => span.name === name)).toBe(true);
    }
    const executionSpan = correlated.find((span) => span.name === "executor.execute");
    expect(executionSpan?.attributes["driveguard.execution_id"]).toEqual(expect.any(String));
    expect(executionSpan?.attributes["driveguard.action_id"]).toBe(action?.actionId);
    const metrics = await observability.metricsText();
    expect(metrics).toContain(
      'driveguard_policy_decisions_total{decision="REQUIRE_CONFIRMATION",tool_name="reserve_charging_slot"} 1',
    );
    expect(metrics).toContain(
      'driveguard_executions_total{tool_name="reserve_charging_slot",status="succeeded"} 1',
    );
    await app.close();
  });

  it("observes an R3 Policy -> Confirmation -> revalidation -> Executor -> Tool flow", async () => {
    const { app, service, observability } = createHarness();
    await service.createSession(identity, "session:phase11-r3");
    const pending = await app.inject({
      method: "POST",
      url: "/v1/sessions/session:phase11-r3/messages",
      headers: identityHeaders,
      payload: { prompt: "request roadside assistance" },
    });
    expect(pending.statusCode).toBe(200);
    const data = pending.json<{
      data: {
        traceId: string;
        actions: { actionId: string; confirmationCredential: string }[];
      };
    }>().data;
    const action = data.actions[0];
    expect(action).toBeDefined();
    const confirmed = await app.inject({
      method: "POST",
      url: `/v1/actions/${action?.actionId}/confirm`,
      headers: identityHeaders,
      payload: {
        sessionId: "session:phase11-r3",
        confirmationCredential: action?.confirmationCredential,
      },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ data: { execution: { status: "SUCCEEDED" } } });
    await observability.tracing.forceFlush();
    const correlated = observability.tracing
      .finishedSpans()
      .filter((span) => span.attributes["driveguard.trace_id"] === data.traceId);
    for (const name of [
      "confirmation.wait",
      "confirmation.revalidate",
      "executor.execute",
      "tool.execute",
      "simulator.request",
      "dependency.http",
      "persistence.write",
    ]) {
      expect(correlated.some((span) => span.name === name)).toBe(true);
    }
    const executionSpan = correlated.find((span) => span.name === "executor.execute");
    expect(executionSpan?.attributes["driveguard.execution_id"]).toEqual(expect.any(String));
    expect(executionSpan?.attributes["driveguard.action_id"]).toBe(action?.actionId);
    const metrics = await observability.metricsText();
    expect(metrics).toContain(
      'driveguard_policy_decisions_total{decision="REQUIRE_CONFIRMATION",tool_name="request_roadside_assistance"} 1',
    );
    expect(metrics).toContain(
      'driveguard_executions_total{tool_name="request_roadside_assistance",status="succeeded"} 1',
    );
    await app.close();
  });

  it("makes a real Simulator 503 retry and failure layer observable", async () => {
    const observability = new DriveGuardObservability({
      service: "driveguard-api",
      logDestination: discardLogs(),
      collectProcessMetrics: false,
      captureInMemoryTracing: true,
    });
    observabilitySystems.push(observability);
    const client = new SimulatorClient({ baseUrl: simulatorBaseUrl });
    const registry = createDriveGuardToolRegistry({
      simulator: client,
      weatherProvider: new DevelopmentWeatherProvider(),
      emergencySupportProvider: new DevelopmentEmergencySupportProvider(),
    });
    const definition = registry.get("get_vehicle_state");
    if (definition === undefined) throw new Error("Tool missing");
    const fault = await fetch(`${simulatorBaseUrl}/simulator/faults`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: "vehicle.get_state",
        mode: "http_503",
        probability: 1,
        delayMs: 0,
      }),
    });
    expect(fault.status).toBe(201);
    const sleeper: Sleeper = {
      sleep: async () => {
        const cleared = await fetch(`${simulatorBaseUrl}/simulator/faults`, { method: "DELETE" });
        expect(cleared.status).toBe(204);
      },
    };
    class MutableClock implements Clock {
      value = Date.now();
      nowMs(): number {
        return this.value++;
      }
    }
    const executor = new ReliableToolExecutor({
      registry,
      authorizationConsumer: {
        consumeExecutionAuthorization: () => Promise.reject(new Error("not used for R0")),
      } satisfies ExecutionAuthorizationConsumer,
      clock: new MutableClock(),
      sleeper,
      eventSink: observability.executionEventSink,
    });
    const request = r0Request(definition, registry);
    const result = await executor.execute(request);
    expect(result).toMatchObject({ status: "SUCCEEDED", attemptCount: 2 });
    const metrics = await observability.metricsText();
    expect(metrics).toContain(
      'driveguard_retries_total{tool_name="get_vehicle_state",error_code="DEPENDENCY_UNAVAILABLE"} 1',
    );
    await observability.tracing.forceFlush();
    const failedAttempt = observability.tracing
      .finishedSpans()
      .find(
        (span) =>
          span.name === "executor.attempt" &&
          span.attributes["error.type"] === "DEPENDENCY_UNAVAILABLE",
      );
    expect(failedAttempt).toBeDefined();
  });
});

function r0Request(
  definition: ToolDefinition,
  registry: ReturnType<typeof createDriveGuardToolRegistry>,
): ExecutionRequest {
  const input = policyInput(definition.name as FormalToolName, {
    toolDefinition: definition,
    validatedArguments: {},
  });
  const runId = "run:phase11-fault";
  const sessionId = "session:phase11-fault";
  const traceId = "a".repeat(32);
  const actionFingerprint = createActionFingerprint({
    toolName: definition.name,
    validatedArguments: {},
    sessionId,
    userId: input.contextSnapshot.user.userId,
    vehicleId: input.contextSnapshot.vehicle.vehicleId,
    contextSnapshotId: input.contextSnapshot.snapshotId,
    contextVersion: input.contextSnapshot.contextVersion,
  });
  const policyDecision = new PolicyEngine().evaluate(
    policyInput(definition.name as FormalToolName, {
      toolDefinition: registry.get(definition.name) ?? definition,
      validatedArguments: {},
      executionBinding: { runId, sessionId, traceId, actionFingerprint },
    }),
    PHASE6_EVALUATED_AT,
  );
  return {
    executionId: "execution:phase11-fault",
    toolName: definition.name,
    validatedArguments: {},
    actionFingerprint,
    runId,
    sessionId,
    userId: input.contextSnapshot.user.userId,
    vehicleId: input.contextSnapshot.vehicle.vehicleId,
    traceId,
    riskLevel: definition.riskLevel,
    policyDecision,
    contextSnapshotId: input.contextSnapshot.snapshotId,
    contextVersion: input.contextSnapshot.contextVersion,
    idempotencyKey: "idempotency:phase11-fault",
    createdAt: toUtcTimestamp(Date.now()),
  };
}
