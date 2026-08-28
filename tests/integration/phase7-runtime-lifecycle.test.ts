import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { buildVehicleSimulator } from "@driveguard/vehicle-simulator";
import type { ActionLifecycleEventSink } from "@driveguard/action-lifecycle";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createProductionDriveGuardRuntime,
  DEFAULT_PHASE_5_CAPABILITIES,
  DEFAULT_PHASE_5_SERVICES,
  type TrustedConfirmationChallengeChannel,
} from "../../packages/agent-runtime/src/index.js";

let application: FastifyInstance;
let baseUrl: string;
let providerSequence = 0;

beforeAll(async () => {
  application = buildVehicleSimulator();
  baseUrl = await application.listen({ host: "127.0.0.1", port: 0 });
});

afterAll(async () => {
  await application.close();
});

function request(toolName: string, args: Record<string, unknown>, id: string) {
  return fauxAssistantMessage(fauxToolCall(toolName, args, { id }), { stopReason: "toolUse" });
}

function runtime(
  responses: FauxResponseStep[],
  trustedConfirmationChallengeChannel?: TrustedConfirmationChallengeChannel,
  actionLifecycleEventSink?: ActionLifecycleEventSink,
) {
  providerSequence += 1;
  const faux = fauxProvider({
    provider: `phase7-faux-${providerSequence}`,
    api: `phase7-faux-api-${providerSequence}`,
  });
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
    ...(trustedConfirmationChallengeChannel === undefined
      ? {}
      : { trustedConfirmationChallengeChannel }),
    ...(actionLifecycleEventSink === undefined ? {} : { actionLifecycleEventSink }),
  });
}

async function reset(): Promise<void> {
  const response = await application.inject({
    method: "POST",
    url: "/simulator/reset",
    payload: { scenario: "low_soc", seed: 707 },
  });
  expect(response.statusCode).toBe(200);
}

async function state() {
  const response = await application.inject({ method: "GET", url: "/simulator/state" });
  expect(response.statusCode).toBe(200);
  return response.json<{
    readonly vehicle: { readonly soc: number };
    readonly charging: { readonly reservations: readonly unknown[] };
  }>();
}

async function pendingRuntime(sessionId: string) {
  const instance = runtime([
    request("reserve_charging_slot", { stationId: "station-pudong-001" }, `call-${sessionId}`),
    fauxAssistantMessage("I need your confirmation before proceeding."),
  ]);
  const result = await instance.run({ sessionId, prompt: "Reserve the charging slot" });
  const actionId = result.confirmationRequired[0]?.actionId ?? "missing";
  const trustedChallenge = instance.trustedConfirmationChallengeChannel?.take(actionId);
  return { instance, result, trustedChallenge };
}

describe("Phase 7 Runtime confirmation lifecycle integration", () => {
  it("installs confirmation and trusted-channel boundaries in default read-only mode", () => {
    const faux = fauxProvider({ provider: "phase7-default", api: "phase7-default-api" });
    const models = createModels();
    models.setProvider(faux.provider);
    const instance = createProductionDriveGuardRuntime({
      model: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
      simulatorBaseUrl: baseUrl,
      capabilities: DEFAULT_PHASE_5_CAPABILITIES,
      serviceAvailability: DEFAULT_PHASE_5_SERVICES,
    });
    expect(instance.mode).toBe("read_only");
    expect(instance.confirmationService).toBeDefined();
    expect(instance.trustedConfirmationChallengeChannel).toBeDefined();
  });

  it("Case A: R2 creates PendingAction, confirms to READY, and executes zero side effects", async () => {
    await reset();
    const before = await state();
    const { instance, result, trustedChallenge } = await pendingRuntime("phase7-case-a");
    const afterRequest = await state();

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("POLICY_CONFIRMATION_REQUIRED");
    expect(result.response).toContain("confirmation is required");
    expect(result.confirmationRequired).toHaveLength(1);
    expect(result.confirmationRequired[0]).not.toHaveProperty("confirmationToken");
    const challenge = trustedChallenge;
    expect(challenge).toBeDefined();
    expect(
      JSON.stringify({
        response: result.response,
        events: result.events,
        safe: result.confirmationRequired,
        executions: result.toolExecutions,
      }),
    ).not.toContain(challenge?.confirmationToken);
    expect(afterRequest.charging.reservations).toEqual(before.charging.reservations);

    const outcome = await instance.confirmationService?.confirm({
      actionId: challenge?.actionId ?? "missing",
      confirmationToken: challenge?.confirmationToken ?? "missing",
      sessionId: challenge?.sessionId ?? "missing",
      userId: challenge?.userId ?? "missing",
    });
    const afterConfirmation = await state();
    expect(outcome?.action.state).toBe("READY_FOR_EXECUTION");
    expect(outcome?.authorization).not.toBeNull();
    expect(afterConfirmation.charging.reservations).toEqual(before.charging.reservations);
    expect(result.toolExecutions).toMatchObject([
      { outcome: "failed", policyControlResult: "POLICY_CONFIRMATION_REQUIRED" },
    ]);
  });

  it("Case B: relevant Simulator Context change produces REPLAN_REQUIRED and no authorization", async () => {
    await reset();
    const { instance, trustedChallenge: challenge } = await pendingRuntime("phase7-case-b");
    const changed = await application.inject({
      method: "POST",
      url: "/simulator/vehicle/soc",
      payload: { soc: 12 },
    });
    expect(changed.statusCode).toBe(200);
    const outcome = await instance.confirmationService?.confirm({
      actionId: challenge?.actionId ?? "missing",
      confirmationToken: challenge?.confirmationToken ?? "missing",
      sessionId: challenge?.sessionId ?? "missing",
      userId: challenge?.userId ?? "missing",
    });
    expect(outcome?.action.state).toBe("REPLAN_REQUIRED");
    expect(outcome?.revalidation.reason).toBe("RELEVANT_STATE_CHANGED");
    expect(outcome?.authorization).toBeNull();
    expect((await state()).charging.reservations).toHaveLength(0);
  });

  it("Case C: replay is rejected and a second authorization is never created", async () => {
    await reset();
    const { instance, trustedChallenge: challenge } = await pendingRuntime("phase7-case-c");
    const command = {
      actionId: challenge?.actionId ?? "missing",
      confirmationToken: challenge?.confirmationToken ?? "missing",
      sessionId: challenge?.sessionId ?? "missing",
      userId: challenge?.userId ?? "missing",
    };
    const first = await instance.confirmationService?.confirm(command);
    await expect(instance.confirmationService?.confirm(command)).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    expect(first?.authorization).not.toBeNull();
    expect((await state()).charging.reservations).toHaveLength(0);
  });

  it("Case D: trusted rejection is terminal and later confirmation is impossible", async () => {
    await reset();
    const { instance, trustedChallenge: challenge } = await pendingRuntime("phase7-case-d");
    const identity = {
      actionId: challenge?.actionId ?? "missing",
      sessionId: challenge?.sessionId ?? "missing",
      userId: challenge?.userId ?? "missing",
    };
    await expect(instance.confirmationService?.reject(identity)).resolves.toMatchObject({
      state: "REJECTED",
    });
    await expect(
      instance.confirmationService?.confirm({
        ...identity,
        confirmationToken: challenge?.confirmationToken ?? "missing",
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await state()).charging.reservations).toHaveLength(0);
  });

  it("R0 ALLOW preserves the existing handler path and creates no PendingAction", async () => {
    await reset();
    const instance = runtime([
      request("get_vehicle_state", {}, "phase7-r0"),
      fauxAssistantMessage("Vehicle state read."),
    ]);
    const result = await instance.run({ sessionId: "phase7-r0", prompt: "Read vehicle state" });
    expect(result.status).toBe("succeeded");
    expect(result.toolExecutions).toHaveLength(1);
    expect(result.confirmationRequired).toHaveLength(0);
  });

  it("cancels a PendingAction when the trusted challenge channel rejects delivery", async () => {
    await reset();
    let publishedActionId: string | undefined;
    let discardedActionId: string | undefined;
    const instance = runtime(
      [
        request(
          "reserve_charging_slot",
          { stationId: "station-pudong-001" },
          "phase7-channel-failure",
        ),
      ],
      {
        publish(challenge) {
          publishedActionId = challenge.actionId;
          throw new Error("trusted channel unavailable");
        },
        take: () => undefined,
        discard(actionId) {
          discardedActionId = actionId;
        },
      },
      {
        emit(event) {
          if (event.eventType === "action.cancelled") {
            return Promise.reject(new Error("lifecycle audit unavailable"));
          }
          return undefined;
        },
      },
    );
    const result = await instance.run({
      sessionId: "phase7-channel-failure",
      prompt: "Reserve the charging slot",
    });
    expect(result.status).toBe("failed");
    expect(result.confirmationRequired).toHaveLength(0);
    expect(publishedActionId).toBeDefined();
    expect(discardedActionId).toBe(publishedActionId);
    expect(instance.confirmationService?.get(publishedActionId ?? "missing")?.state).toBe(
      "CANCELLED",
    );
  });
});
