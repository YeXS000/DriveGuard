import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import type { ServiceAvailability } from "@driveguard/capabilities";
import { FixedClock, type Clock } from "@driveguard/shared";
import { buildVehicleSimulator } from "@driveguard/vehicle-simulator";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createProductionDriveGuardRuntime,
  DEFAULT_PHASE_5_CAPABILITIES,
  DEFAULT_PHASE_5_SERVICES,
  type RuntimeEventSink,
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
  options: {
    mode?: "read_only" | "development";
    serviceAvailabilityProvider?: () => Promise<ServiceAvailability>;
    latestContextVersionProvider?: (snapshotVersion: number) => unknown;
    eventSink?: RuntimeEventSink;
    clock?: Clock;
  } = {},
) {
  providerSequence += 1;
  const faux = fauxProvider({
    provider: `phase6-faux-${providerSequence}`,
    api: `phase6-faux-api-${providerSequence}`,
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
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    mode: options.mode ?? "read_only",
    ...(options.mode === "development" ? { developmentExecutionOptIn: true } : {}),
    ...(options.serviceAvailabilityProvider === undefined
      ? {}
      : { serviceAvailabilityProvider: options.serviceAvailabilityProvider }),
    ...(options.latestContextVersionProvider === undefined
      ? {}
      : { latestContextVersionProvider: options.latestContextVersionProvider }),
    runtimeOverrides: {
      ...(options.eventSink === undefined ? {} : { eventSink: options.eventSink }),
    },
  });
}

async function reset(scenario = "active_navigation", seed = 606): Promise<void> {
  const response = await application.inject({
    method: "POST",
    url: "/simulator/reset",
    payload: { scenario, seed },
  });
  expect(response.statusCode).toBe(200);
}

async function state() {
  const response = await application.inject({ method: "GET", url: "/simulator/state" });
  expect(response.statusCode).toBe(200);
  return response.json<{
    readonly cabin: { readonly mediaVolume: number };
    readonly vehicle: { readonly cabinTemperature: number };
    readonly trip: { readonly destination: string | null };
    readonly charging: { readonly reservations: readonly unknown[] };
    readonly assistance: { readonly requests: readonly unknown[] };
  }>();
}

describe("Phase 6 formal Runtime Policy enforcement", () => {
  it("R0 ALLOW executes exactly once with one decision and full Policy events", async () => {
    await reset();
    const result = await runtime([
      request("get_vehicle_state", {}, "r0"),
      fauxAssistantMessage("SOC read complete"),
    ]).run({ sessionId: "phase6-r0", prompt: "Read current SOC" });

    expect(result.status).toBe("succeeded");
    expect(result.toolExecutions).toMatchObject([
      { toolName: "get_vehicle_state", outcome: "succeeded", result: { soc: 72 } },
    ]);
    expect(result.policyDecisions).toMatchObject([
      { decision: "ALLOW", ruleId: "DG-POL-010", toolName: "get_vehicle_state" },
    ]);
    expect(
      result.events.filter((event) => event.eventType === "policy.evaluation.started"),
    ).toHaveLength(1);
    expect(
      result.events.filter((event) => event.eventType === "policy.decision.made"),
    ).toHaveLength(1);
    expect(
      result.events.filter((event) => event.eventType === "policy.execution.blocked"),
    ).toHaveLength(0);
    expect(result.events.every((event) => event.metadata?.boundary === "POLICY_GUARDED")).toBe(
      true,
    );
  });

  it("R1 ALLOW reaches the underlying Simulator exactly once", async () => {
    await reset();
    const before = await state();
    const result = await runtime(
      [request("set_media_volume", { volume: 61 }, "r1"), fauxAssistantMessage("done")],
      { mode: "development" },
    ).run({ sessionId: "phase6-r1", prompt: "Set volume" });
    const after = await state();

    expect(before.cabin.mediaVolume).toBe(35);
    expect(after.cabin.mediaVolume).toBe(61);
    expect(result.status).toBe("succeeded");
    expect(result.policyDecisions).toMatchObject([{ decision: "ALLOW", ruleId: "DG-POL-009" }]);
    expect(result.toolExecutions).toHaveLength(1);
  });

  it("R2 REQUIRE_CONFIRMATION returns its control result and executes zero side effects", async () => {
    await reset();
    const before = await state();
    const result = await runtime(
      [
        request("set_navigation_destination", { destination: "The Bund" }, "r2"),
        fauxAssistantMessage("The action requires confirmation."),
      ],
      { mode: "development" },
    ).run({ sessionId: "phase6-r2", prompt: "Navigate to The Bund" });
    const after = await state();

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("POLICY_CONFIRMATION_REQUIRED");
    expect(result.response).toContain("confirmation is required");
    expect(result.policyDecisions).toMatchObject([
      { decision: "REQUIRE_CONFIRMATION", ruleId: "DG-POL-008" },
    ]);
    expect(result.toolExecutions).toMatchObject([
      { outcome: "failed", policyControlResult: "POLICY_CONFIRMATION_REQUIRED" },
    ]);
    expect(after.trip.destination).toBe(before.trip.destination);
    expect(
      result.events.filter((event) => event.eventType === "policy.execution.blocked"),
    ).toHaveLength(1);
  });

  it("R3 REQUIRE_CONFIRMATION blocks the development provider", async () => {
    await reset();
    const result = await runtime(
      [
        request("request_emergency_support", { reason: "medical support" }, "r3"),
        fauxAssistantMessage("The action requires confirmation."),
      ],
      { mode: "development" },
    ).run({ sessionId: "phase6-r3", prompt: "Request emergency support" });

    expect(result.error?.code).toBe("POLICY_CONFIRMATION_REQUIRED");
    expect(result.policyDecisions).toMatchObject([
      { decision: "REQUIRE_CONFIRMATION", ruleId: "DG-POL-007" },
    ]);
    expect(result.toolExecutions).toMatchObject([
      { outcome: "failed", policyControlResult: "POLICY_CONFIRMATION_REQUIRED" },
    ]);
  });

  it("DENY after service availability changes executes zero side effects", async () => {
    await reset();
    let calls = 0;
    const serviceAvailabilityProvider = (): Promise<ServiceAvailability> => {
      calls += 1;
      return Promise.resolve({
        ...DEFAULT_PHASE_5_SERVICES,
        vehicleSimulator: calls === 1,
      });
    };
    const before = await state();
    const result = await runtime(
      [request("set_media_volume", { volume: 99 }, "deny"), fauxAssistantMessage("denied")],
      { mode: "development", serviceAvailabilityProvider },
    ).run({ sessionId: "phase6-deny", prompt: "Set volume" });
    const after = await state();

    expect(result.error?.code).toBe("POLICY_DENIED");
    expect(result.policyDecisions).toMatchObject([{ decision: "DENY", ruleId: "DG-POL-003" }]);
    expect(after.cabin.mediaVolume).toBe(before.cabin.mediaVolume);
  });

  it("REPLAN on NOT_LATEST executes zero side effects", async () => {
    await reset();
    let calls = 0;
    const latestContextVersionProvider = (version: number): number => {
      calls += 1;
      return calls === 1 ? version : version + 1;
    };
    const before = await state();
    const result = await runtime(
      [request("set_media_volume", { volume: 77 }, "replan"), fauxAssistantMessage("replan")],
      { mode: "development", latestContextVersionProvider },
    ).run({ sessionId: "phase6-replan", prompt: "Set volume" });
    const after = await state();

    expect(result.error?.code).toBe("POLICY_REPLAN_REQUIRED");
    expect(result.policyDecisions).toMatchObject([
      { decision: "REPLAN", ruleId: "DG-POL-005", reasonCode: "CONTEXT_NOT_LATEST" },
    ]);
    expect(after.cabin.mediaVolume).toBe(before.cabin.mediaVolume);
  });

  it("R1 stale Vehicle source is REPLAN even when the wrapper snapshot is new", async () => {
    await reset();
    const before = await state();
    const result = await runtime(
      [
        request("set_cabin_temperature", { temperatureC: 25 }, "stale-vehicle"),
        fauxAssistantMessage("replan"),
      ],
      { mode: "development", clock: new FixedClock(Date.now() + 3_000) },
    ).run({ sessionId: "phase6-stale-vehicle", prompt: "Set cabin temperature" });
    const after = await state();

    expect(result.error?.code).toBe("POLICY_REPLAN_REQUIRED");
    expect(result.policyDecisions).toMatchObject([
      { decision: "REPLAN", ruleId: "DG-POL-005", reasonCode: "CONTEXT_STALE" },
    ]);
    expect(after.vehicle.cabinTemperature).toBe(before.vehicle.cabinTemperature);
  });

  it("R2 stale Trip source precedes confirmation and executes zero side effects", async () => {
    await reset();
    const before = await state();
    const result = await runtime(
      [
        request("set_navigation_destination", { destination: "The Bund" }, "stale-trip"),
        fauxAssistantMessage("replan"),
      ],
      { mode: "development", clock: new FixedClock(Date.now() + 6_000) },
    ).run({ sessionId: "phase6-stale-trip", prompt: "Navigate to The Bund" });
    const after = await state();

    expect(result.error?.code).toBe("POLICY_REPLAN_REQUIRED");
    expect(result.policyDecisions).toMatchObject([
      { decision: "REPLAN", ruleId: "DG-POL-005", reasonCode: "CONTEXT_STALE" },
    ]);
    expect(after.trip.destination).toBe(before.trip.destination);
  });

  it("parallel formal reads each receive exactly one final PolicyDecision", async () => {
    await reset();
    const result = await runtime([
      fauxAssistantMessage(
        [
          fauxToolCall("get_vehicle_state", {}, { id: "parallel-vehicle" }),
          fauxToolCall("get_trip_state", {}, { id: "parallel-trip" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("both read"),
    ]).run({ sessionId: "phase6-parallel", prompt: "Read both" });

    expect(result.status).toBe("succeeded");
    expect(result.policyDecisions).toHaveLength(2);
    expect(
      result.events.filter((event) => event.eventType === "policy.decision.made"),
    ).toHaveLength(2);
    expect(result.toolExecutions).toHaveLength(2);
  });

  it("Policy event sink failure is fail-closed before R1 dispatch", async () => {
    await reset();
    const before = await state();
    const eventSink: RuntimeEventSink = {
      emit: (event) => {
        if (event.eventType === "policy.evaluation.started") {
          throw new Error("sink failure");
        }
      },
    };
    const result = await runtime(
      [request("set_media_volume", { volume: 88 }, "sink"), fauxAssistantMessage("not done")],
      { mode: "development", eventSink },
    ).run({ sessionId: "phase6-sink", prompt: "Set volume" });
    const after = await state();

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("INTERNAL_ERROR");
    expect(result.policyDecisions).toHaveLength(0);
    expect(after.cabin.mediaVolume).toBe(before.cabin.mediaVolume);
  });

  it("decision-event sink failure is INTERNAL_ERROR and not a false Policy denial", async () => {
    await reset();
    const before = await state();
    const eventSink: RuntimeEventSink = {
      emit: (event) => {
        if (event.eventType === "policy.decision.made") {
          throw new Error("decision sink failure");
        }
      },
    };
    const result = await runtime(
      [request("set_media_volume", { volume: 89 }, "decision-sink"), fauxAssistantMessage("no")],
      { mode: "development", eventSink },
    ).run({ sessionId: "phase6-decision-sink", prompt: "Set volume" });
    const after = await state();

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("INTERNAL_ERROR");
    expect(result.policyDecisions).toMatchObject([{ decision: "ALLOW", ruleId: "DG-POL-009" }]);
    expect(result.toolExecutions).toMatchObject([{ outcome: "failed" }]);
    expect(result.toolExecutions[0]).not.toHaveProperty("policyControlResult");
    expect(after.cabin.mediaVolume).toBe(before.cabin.mediaVolume);
  });
});
