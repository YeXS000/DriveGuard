import { randomUUID } from "node:crypto";

import { InMemoryPendingActionRepository } from "../../packages/action-lifecycle/src/repository.js";
import {
  createProductionDriveGuardRuntime,
  DEFAULT_PHASE_5_CAPABILITIES,
  DEFAULT_PHASE_5_SERVICES,
} from "@driveguard/agent-runtime";
import { buildVehicleSimulator } from "@driveguard/vehicle-simulator";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  InMemoryConversationRepository,
  InMemorySessionCoordinator,
  InMemorySessionRepository,
  RepositoryConversationMemory,
} from "@driveguard/memory";
import { InMemoryExecutionRepository } from "@driveguard/persistence";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApi } from "../../apps/api/src/app.js";
import {
  DriveGuardApiService,
  type Phase10RuntimeFactory,
  type Phase10RuntimeFactoryInput,
} from "../../apps/api/src/service.js";

const identityHeaders = {
  "x-driveguard-user-id": "user:phase10",
  "x-driveguard-vehicle-id": "simulator-vehicle-001",
};
const identity = { userId: "user:phase10", vehicleId: "simulator-vehicle-001" } as const;

let simulator: FastifyInstance;
let simulatorBaseUrl: string;

beforeAll(async () => {
  simulator = buildVehicleSimulator();
  simulatorBaseUrl = await simulator.listen({ host: "127.0.0.1", port: 0 });
});

afterAll(async () => {
  await simulator.close();
});

class ActualRuntimeFactory implements Phase10RuntimeFactory {
  readonly pending = new InMemoryPendingActionRepository();
  readonly conversation: RepositoryConversationMemory;
  readonly coordinator = new InMemorySessionCoordinator();

  constructor(conversation: RepositoryConversationMemory) {
    this.conversation = conversation;
  }

  create(input: Phase10RuntimeFactoryInput) {
    const faux = fauxProvider({
      provider: `phase10-integration-${randomUUID()}`,
      api: `phase10-integration-api-${randomUUID()}`,
      tokensPerSecond: 4_000,
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
        fauxAssistantMessage("Please confirm the roadside assistance request."),
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
        fauxAssistantMessage("Please confirm the charging reservation."),
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
      conversationMemory: this.conversation,
      sessionCoordinator: this.coordinator,
      ...(input.actionLifecycleEventSink === undefined
        ? {}
        : { actionLifecycleEventSink: input.actionLifecycleEventSink }),
      ...(input.executionEventSink === undefined
        ? {}
        : { executionEventSink: input.executionEventSink }),
      runtimeOverrides: {
        ...(input.runtimeEventSink === undefined ? {} : { eventSink: input.runtimeEventSink }),
        ...(input.assistantTextDeltaSink === undefined
          ? {}
          : { assistantTextDeltaSink: input.assistantTextDeltaSink }),
      },
    });
  }
}

function createHarness() {
  const sessions = new InMemorySessionRepository();
  const conversation = new RepositoryConversationMemory({
    sessions,
    conversation: new InMemoryConversationRepository(),
  });
  const runtimeFactory = new ActualRuntimeFactory(conversation);
  const service = new DriveGuardApiService({
    sessions,
    conversation,
    executions: new InMemoryExecutionRepository(),
    runtimeFactory,
  });
  const app = buildApi({ service });
  return { app, service, runtimeFactory };
}

beforeEach(async () => {
  const reset = await simulator.inject({
    method: "POST",
    url: "/simulator/reset",
    payload: { scenario: "low_soc", seed: 1010 },
  });
  expect(reset.statusCode).toBe(200);
});

describe("Phase 10 API to Production Runtime integration", () => {
  it("executes Session -> Message -> R0 Tool -> response", async () => {
    const { app, service } = createHarness();
    await service.createSession(identity, "session:r0");
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions/session:r0/messages",
      headers: identityHeaders,
      payload: { prompt: "get vehicle state" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        status: "completed",
        response: "Vehicle state retrieved.",
        policyDecisions: [{ tool: "get_vehicle_state", decision: "ALLOW" }],
      },
    });
    await app.close();
  });

  it("streams R0 Tool and assistant lifecycle events", async () => {
    const { app, service } = createHarness();
    await service.createSession(identity, "session:sse-r0");
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions/session:sse-r0/messages/stream",
      headers: identityHeaders,
      payload: { prompt: "get vehicle state" },
    });
    expect(response.statusCode).toBe(200);
    for (const type of [
      "run.started",
      "tool.requested",
      "policy.decision",
      "tool.completed",
      "assistant.delta",
      "assistant.completed",
    ]) {
      expect(response.body).toContain(`event: ${type}`);
    }
    expect(response.body).not.toMatch(/validatedArguments|originalContext|reasoning/iu);
    await app.close();
  });

  it("executes R2/R3 only after application confirmation and exactly once", async () => {
    const { app, service } = createHarness();
    await service.createSession(identity, "session:r2");
    const pending = await app.inject({
      method: "POST",
      url: "/v1/sessions/session:r2/messages",
      headers: identityHeaders,
      payload: { prompt: "reserve charging" },
    });
    expect(pending.statusCode).toBe(200);
    const action = pending.json<{
      data: { actions: { actionId: string; confirmationCredential: string }[] };
    }>().data.actions[0];
    expect(action).toBeDefined();
    const before = await simulator.inject({ method: "GET", url: "/simulator/state" });
    expect(
      before.json<{ charging: { reservations: unknown[] } }>().charging.reservations,
    ).toHaveLength(0);
    const confirmed = await app.inject({
      method: "POST",
      url: `/v1/actions/${action?.actionId}/confirm`,
      headers: identityHeaders,
      payload: {
        sessionId: "session:r2",
        confirmationCredential: action?.confirmationCredential,
      },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ data: { execution: { status: "SUCCEEDED" } } });
    const after = await simulator.inject({ method: "GET", url: "/simulator/state" });
    expect(
      after.json<{ charging: { reservations: unknown[] } }>().charging.reservations,
    ).toHaveLength(1);

    await service.createSession(identity, "session:r3");
    const pendingR3 = await app.inject({
      method: "POST",
      url: "/v1/sessions/session:r3/messages",
      headers: identityHeaders,
      payload: { prompt: "request roadside assistance" },
    });
    expect(pendingR3.statusCode).toBe(200);
    const actionR3 = pendingR3.json<{
      data: {
        actions: {
          actionId: string;
          confirmationCredential: string;
          riskLevel: string;
        }[];
      };
    }>().data.actions[0];
    expect(actionR3?.riskLevel).toBe("R3");
    const beforeR3 = await simulator.inject({ method: "GET", url: "/simulator/state" });
    expect(
      beforeR3.json<{ assistance: { requests: unknown[] } }>().assistance.requests,
    ).toHaveLength(0);
    const confirmedR3 = await app.inject({
      method: "POST",
      url: `/v1/actions/${actionR3?.actionId}/confirm`,
      headers: identityHeaders,
      payload: {
        sessionId: "session:r3",
        confirmationCredential: actionR3?.confirmationCredential,
      },
    });
    expect(confirmedR3.statusCode).toBe(200);
    expect(confirmedR3.json()).toMatchObject({ data: { execution: { status: "SUCCEEDED" } } });
    const afterR3 = await simulator.inject({ method: "GET", url: "/simulator/state" });
    expect(
      afterR3.json<{ assistance: { requests: unknown[] } }>().assistance.requests,
    ).toHaveLength(1);
    await app.close();
  });

  it("rejects cross-user confirmation with zero side effects", async () => {
    const { app, service } = createHarness();
    await service.createSession(identity, "session:cross-user");
    const pending = await app.inject({
      method: "POST",
      url: "/v1/sessions/session:cross-user/messages",
      headers: identityHeaders,
      payload: { prompt: "reserve charging" },
    });
    const action = pending.json<{
      data: { actions: { actionId: string; confirmationCredential: string }[] };
    }>().data.actions[0];
    const response = await app.inject({
      method: "POST",
      url: `/v1/actions/${action?.actionId}/confirm`,
      headers: { ...identityHeaders, "x-driveguard-user-id": "user:attacker" },
      payload: {
        sessionId: "session:cross-user",
        confirmationCredential: action?.confirmationCredential,
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("ACTION_NOT_FOUND");
    const state = await simulator.inject({ method: "GET", url: "/simulator/state" });
    expect(
      state.json<{ charging: { reservations: unknown[] } }>().charging.reservations,
    ).toHaveLength(0);
    await app.close();
  });
});
