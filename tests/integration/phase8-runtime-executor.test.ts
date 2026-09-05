import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import type { ExecutionEvent } from "@driveguard/executor";
import { buildVehicleSimulator } from "@driveguard/vehicle-simulator";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createProductionDriveGuardRuntime,
  DEFAULT_PHASE_5_CAPABILITIES,
  DEFAULT_PHASE_5_SERVICES,
} from "../../packages/agent-runtime/src/index.js";

let application: FastifyInstance;
let baseUrl: string;
let sequence = 0;

beforeAll(async () => {
  application = buildVehicleSimulator();
  baseUrl = await application.listen({ host: "127.0.0.1", port: 0 });
});

afterAll(async () => {
  await application.close();
});

function call(toolName: string, args: Record<string, unknown>, id: string) {
  return fauxAssistantMessage(fauxToolCall(toolName, args, { id }), { stopReason: "toolUse" });
}

function runtime(responses: FauxResponseStep[], executionEvents: ExecutionEvent[]) {
  sequence += 1;
  const faux = fauxProvider({ provider: `phase8-${sequence}`, api: `phase8-api-${sequence}` });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  return createProductionDriveGuardRuntime({
    model: faux.getModel(),
    streamFn: models.streamSimple.bind(models),
    simulatorBaseUrl: baseUrl,
    capabilities: DEFAULT_PHASE_5_CAPABILITIES,
    serviceAvailability: DEFAULT_PHASE_5_SERVICES,
    mode: "development",
    developmentExecutionOptIn: true,
    executionEventSink: {
      emit(event) {
        executionEvents.push(event);
      },
    },
  });
}

async function reset(): Promise<void> {
  const response = await application.inject({
    method: "POST",
    url: "/simulator/reset",
    payload: { scenario: "city_idle", seed: 808 },
  });
  expect(response.statusCode).toBe(200);
}

async function state() {
  const response = await application.inject({ method: "GET", url: "/simulator/state" });
  return response.json<{
    vehicle: { cabinTemperature: number };
    charging: { reservations: unknown[] };
    assistance: { requests: unknown[] };
  }>();
}

describe("Phase 8 formal Runtime coverage", () => {
  it("routes R0 ALLOW through ReliableToolExecutor", async () => {
    await reset();
    const events: ExecutionEvent[] = [];
    const instance = runtime(
      [call("get_vehicle_state", {}, "phase8-r0"), fauxAssistantMessage("Read complete")],
      events,
    );
    const result = await instance.run({ sessionId: "phase8-r0", prompt: "Read vehicle" });
    expect(result.status).toBe("succeeded");
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["execution.started", "execution.succeeded"]),
    );
  });

  it("routes R1 ALLOW through ReliableToolExecutor", async () => {
    await reset();
    const events: ExecutionEvent[] = [];
    const instance = runtime(
      [
        call("set_cabin_temperature", { temperatureC: 24 }, "phase8-r1"),
        fauxAssistantMessage("Temperature updated"),
      ],
      events,
    );
    const result = await instance.run({ sessionId: "phase8-r1", prompt: "Set temperature" });
    expect(result.status).toBe("succeeded");
    expect((await state()).vehicle.cabinTemperature).toBe(24);
    expect(events.some((event) => event.toolName === "set_cabin_temperature")).toBe(true);
  });

  it.each([
    ["R2", "reserve_charging_slot", { stationId: "station-pudong-001" }],
    ["R3", "request_roadside_assistance", { reason: "flat tire" }],
  ] as const)("routes confirmed %s through ReliableToolExecutor", async (_risk, toolName, args) => {
    await reset();
    const events: ExecutionEvent[] = [];
    const instance = runtime(
      [call(toolName, args, `phase8-${toolName}`), fauxAssistantMessage("Confirmation required")],
      events,
    );
    const run = await instance.run({
      sessionId: `phase8-${toolName}`,
      prompt: `Run ${toolName}`,
    });
    const actionId = run.confirmationRequired[0]?.actionId ?? "missing";
    const challenge = instance.trustedConfirmationChallengeChannel.take(actionId);
    expect(run.error?.code).toBe("POLICY_CONFIRMATION_REQUIRED");
    expect((await state()).charging.reservations).toHaveLength(0);
    expect((await state()).assistance.requests).toHaveLength(0);
    const execution = await instance.confirmAndExecute({
      actionId: challenge?.actionId ?? "missing",
      confirmationToken: challenge?.confirmationToken ?? "missing",
      sessionId: challenge?.sessionId ?? "missing",
      userId: challenge?.userId ?? "missing",
    });
    expect(execution.status).toBe("SUCCEEDED");
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["authorization.consumed", "execution.succeeded"]),
    );
    if (toolName === "reserve_charging_slot") {
      expect((await state()).charging.reservations).toHaveLength(1);
    } else {
      expect((await state()).assistance.requests).toHaveLength(1);
    }
  });

  it("keeps unconfirmed R2/R3 handler execution at zero", async () => {
    await reset();
    const events: ExecutionEvent[] = [];
    const instance = runtime(
      [
        call("reserve_charging_slot", { stationId: "station-pudong-001" }, "phase8-blocked"),
        fauxAssistantMessage("Confirmation required"),
      ],
      events,
    );
    await instance.run({ sessionId: "phase8-blocked", prompt: "Reserve" });
    expect(events).toHaveLength(0);
    expect((await state()).charging.reservations).toHaveLength(0);
  });

  it("completes confirmation from the frozen action and returns refreshed final state", async () => {
    await reset();
    const events: ExecutionEvent[] = [];
    const instance = runtime(
      [
        call("reserve_charging_slot", { stationId: "station-pudong-001" }, "phase13-2-complete"),
        fauxAssistantMessage("Confirmation required"),
      ],
      events,
    );
    const run = await instance.run({
      sessionId: "phase13-2-confirm-complete",
      prompt: "Reserve station-pudong-001",
    });
    const actionId = run.confirmationRequired[0]?.actionId ?? "missing";
    const before = await instance.confirmationService.get(actionId);
    const challenge = instance.trustedConfirmationChallengeChannel.take(actionId);
    const command = {
      actionId: challenge?.actionId ?? "missing",
      confirmationToken: challenge?.confirmationToken ?? "missing",
      sessionId: challenge?.sessionId ?? "missing",
      userId: challenge?.userId ?? "missing",
    };

    const completion = await instance.confirmAndComplete(command);
    const after = await instance.confirmationService.get(actionId);

    expect(before?.validatedArguments).toEqual({ stationId: "station-pudong-001" });
    expect(after?.validatedArguments).toEqual(before?.validatedArguments);
    expect(after?.actionFingerprint).toBe(before?.actionFingerprint);
    expect(completion.actionId).toBe(actionId);
    expect(completion.idempotencyKey).toBe(`confirmed:${actionId}`);
    expect(completion.execution.status).toBe("SUCCEEDED");
    expect(completion.lifecycle).toEqual([
      "ACTION_PROPOSED",
      "POLICY_CHECKED",
      "CONFIRMATION_CREATED",
      "USER_CONFIRMED",
      "EXECUTING",
      "EXECUTED",
      "STATE_REFRESHED",
      "FINAL_RESPONSE",
    ]);
    expect(completion.response).toContain("completed successfully");
    expect((await state()).charging.reservations).toHaveLength(1);

    const replay = await instance.confirmAndComplete(command);
    expect(replay.execution).toMatchObject({ status: "SUCCEEDED", deduplicated: true });
    expect((await state()).charging.reservations).toHaveLength(1);
  });
});
