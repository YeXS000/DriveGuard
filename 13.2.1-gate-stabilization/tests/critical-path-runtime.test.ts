import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { buildVehicleSimulator } from "@driveguard/vehicle-simulator";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createProductionDriveGuardRuntime,
  DEFAULT_PHASE_5_CAPABILITIES,
  DEFAULT_PHASE_5_SERVICES,
} from "../../packages/agent-runtime/src/index.js";

let app: FastifyInstance;
let baseUrl: string;
let providerSequence = 0;

beforeAll(async () => {
  app = buildVehicleSimulator();
  baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
});

afterAll(async () => {
  await app.close();
});

async function reset(): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: "/simulator/reset",
    payload: { scenario: "active_navigation", seed: 5 },
  });
  expect(response.statusCode).toBe(200);
}

function runtimeWithResponses(responses: FauxResponseStep[]) {
  providerSequence += 1;
  const faux = fauxProvider({
    provider: `phase13-2-1-faux-${providerSequence}`,
    api: `phase13-2-1-api-${providerSequence}`,
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
  });
}

function runtimeWithModelText(text: string) {
  return runtimeWithResponses([fauxAssistantMessage(text)]);
}

describe("Phase 13.2.1 critical path Runtime integration", () => {
  it("prechecks Policy and repairs one stochastic reservation Tool omission", async () => {
    await reset();
    const runtime = runtimeWithModelText("I need the station identifier before I can continue.");

    const result = await runtime.run({
      sessionId: "critical-missing-tool",
      prompt: "预约浦东001号充电站",
    });

    expect(result.toolExecutions).toMatchObject([
      {
        toolName: "reserve_charging_slot",
        outcome: "failed",
        validatedArguments: { stationId: "station-pudong-001" },
        policyControlResult: "POLICY_CONFIRMATION_REQUIRED",
      },
    ]);
    expect(
      result.policyDecisions.filter(
        (decision) =>
          decision.toolName === "reserve_charging_slot" &&
          decision.decision === "REQUIRE_CONFIRMATION",
      ),
    ).toHaveLength(2);
    expect(result.confirmationRequired).toHaveLength(1);
    const repairedRequests = result.events.filter(
      (event) =>
        event.eventType === "tool.requested" &&
        event.metadata?.toolName === "reserve_charging_slot",
    );
    expect(repairedRequests).toHaveLength(1);
    expect(repairedRequests[0]?.metadata?.planStatus).toBe("PLAN_INCOMPLETE");

    const action = result.confirmationRequired[0]!;
    const challenge = runtime.trustedConfirmationChallengeChannel.take(action.actionId);
    expect(challenge).toBeDefined();
    const completion = await runtime.confirmAndComplete({
      actionId: challenge!.actionId,
      confirmationToken: challenge!.confirmationToken,
      sessionId: challenge!.sessionId,
      userId: challenge!.userId,
    });
    expect(completion.execution.status).toBe("SUCCEEDED");
  });

  it("records unsupported braking Policy DENY before a no-Tool model response", async () => {
    await reset();
    const runtime = runtimeWithModelText("I cannot control safety-critical actuators.");

    const result = await runtime.run({
      sessionId: "critical-unsupported",
      prompt: "立即替我踩下刹车",
    });

    expect(result.toolExecutions).toEqual([]);
    expect(result.policyDecisions).toContainEqual(
      expect.objectContaining({
        toolName: "apply_brake",
        decision: "DENY",
        reasonCode: "FORBIDDEN_RX",
      }),
    );
  });

  it("repairs a critical request whose model Tool proposal fails argument validation", async () => {
    await reset();
    const runtime = runtimeWithResponses([
      fauxAssistantMessage(
        fauxToolCall("reserve_charging_slot", {}, { id: "invalid-critical-proposal" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("I could not complete the reservation."),
    ]);

    const result = await runtime.run({
      sessionId: "critical-invalid-tool-proposal",
      prompt: "预约浦东001号充电站",
    });

    expect(result.toolExecutions).toContainEqual(
      expect.objectContaining({
        toolName: "reserve_charging_slot",
        validatedArguments: { stationId: "station-pudong-001" },
        policyControlResult: "POLICY_CONFIRMATION_REQUIRED",
      }),
    );
    expect(result.confirmationRequired).toHaveLength(1);
  });

  it("does not add prechecks or repairs to a non-critical no-Tool request", async () => {
    await reset();
    const runtime = runtimeWithModelText("Hello from DriveGuard.");

    const result = await runtime.run({ sessionId: "ordinary", prompt: "向我问好" });

    expect(result.status).toBe("succeeded");
    expect(result.toolExecutions).toEqual([]);
    expect(result.policyDecisions).toEqual([]);
    expect(result.events.some((event) => event.eventType === "tool.requested")).toBe(false);
  });
});
