import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import type { VehicleCapabilities } from "@driveguard/domain";
import type { ServiceAvailability } from "@driveguard/capabilities";
import { buildVehicleSimulator } from "@driveguard/vehicle-simulator";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  AgentRuntimeError,
  createProductionDriveGuardRuntime,
  DEFAULT_PHASE_5_CAPABILITIES,
  DEFAULT_PHASE_5_SERVICES,
  type ProductionDriveGuardRuntime,
  type Phase5RuntimeMode,
  type RuntimeEvent,
  type RuntimeEventSink,
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

function toolRequest(name: string, arguments_: Record<string, unknown>, id: string) {
  return fauxAssistantMessage(fauxToolCall(name, arguments_, { id }), { stopReason: "toolUse" });
}

function createRuntime(
  responses: FauxResponseStep[],
  options: {
    capabilities?: VehicleCapabilities;
    services?: ServiceAvailability;
    mode?: Phase5RuntimeMode;
    developmentExecutionOptIn?: boolean;
    sensitiveValues?: readonly string[];
    capabilitiesProvider?: () => Promise<VehicleCapabilities>;
    serviceAvailabilityProvider?: () => Promise<ServiceAvailability>;
    latestContextVersionProvider?: (snapshotVersion: number) => unknown;
    eventSink?: RuntimeEventSink;
    runIdFactory?: () => string;
    traceIdFactory?: () => string;
    eventIdFactory?: () => string;
  } = {},
): { runtime: ProductionDriveGuardRuntime; faux: ReturnType<typeof fauxProvider> } {
  providerSequence += 1;
  const faux = fauxProvider({
    provider: `phase5-faux-${providerSequence}`,
    api: `phase5-faux-api-${providerSequence}`,
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  const runtime = createProductionDriveGuardRuntime({
    model: faux.getModel(),
    streamFn: models.streamSimple.bind(models),
    simulatorBaseUrl: baseUrl,
    capabilities: options.capabilities ?? DEFAULT_PHASE_5_CAPABILITIES,
    serviceAvailability: options.services ?? DEFAULT_PHASE_5_SERVICES,
    mode: options.mode ?? "read_only",
    ...(options.developmentExecutionOptIn === undefined
      ? {}
      : { developmentExecutionOptIn: options.developmentExecutionOptIn }),
    ...(options.sensitiveValues === undefined ? {} : { sensitiveValues: options.sensitiveValues }),
    ...(options.capabilitiesProvider === undefined
      ? {}
      : { capabilitiesProvider: options.capabilitiesProvider }),
    ...(options.serviceAvailabilityProvider === undefined
      ? {}
      : { serviceAvailabilityProvider: options.serviceAvailabilityProvider }),
    ...(options.latestContextVersionProvider === undefined
      ? {}
      : { latestContextVersionProvider: options.latestContextVersionProvider }),
    runtimeOverrides: {
      ...(options.eventSink === undefined ? {} : { eventSink: options.eventSink }),
      ...(options.runIdFactory === undefined ? {} : { runIdFactory: options.runIdFactory }),
      ...(options.traceIdFactory === undefined ? {} : { traceIdFactory: options.traceIdFactory }),
      ...(options.eventIdFactory === undefined ? {} : { eventIdFactory: options.eventIdFactory }),
    },
  });
  return { runtime, faux };
}

function finalFromLastTool(prefix: string): FauxResponseStep {
  return (context) => {
    const details: unknown = context.messages.findLast(
      (message) => message.role === "toolResult",
    )?.details;
    return fauxAssistantMessage(`${prefix}:${JSON.stringify(details)}`);
  };
}

async function reset(scenario = "active_navigation", seed = 5): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: "/simulator/reset",
    payload: { scenario, seed },
  });
  expect(response.statusCode).toBe(200);
}

async function simulatorMediaVolume(): Promise<number> {
  const response = await app.inject({ method: "GET", url: "/simulator/state" });
  expect(response.statusCode).toBe(200);
  const state = response.json<{ readonly cabin: { readonly mediaVolume: number } }>();
  return state.cabin.mediaVolume;
}

describe("Phase 5 production Agent Runtime integration", () => {
  it("Case A: loads context, exposes formal get_vehicle_state, executes it, and completes", async () => {
    await reset();
    const { runtime } = createRuntime([
      toolRequest("get_vehicle_state", {}, "case-a-vehicle"),
      finalFromLastTool("vehicle"),
    ]);

    const result = await runtime.run({
      sessionId: "case-a",
      prompt: "What is my current battery level?",
    });

    expect(result.status).toBe("succeeded");
    expect(result.response).toContain('"source":"FORMAL_TOOL_CONTRACT"');
    expect(result.response).toContain('"soc":72');
    expect(result.availableToolNames).toContain("get_vehicle_state");
    expect(result.toolExecutions).toMatchObject([
      { toolName: "get_vehicle_state", result: { soc: 72 } },
    ]);
    expect(Object.isFrozen(result.toolExecutions)).toBe(true);
    expect(result.response).not.toContain("PHASE_1_FIXTURE_ONLY");
    expect(result.run.status).toBe("RUN_SUCCEEDED");
  });

  it("Case B: resolves and executes search_charging_stations through the formal Registry", async () => {
    await reset();
    const { runtime } = createRuntime([
      toolRequest("search_charging_stations", {}, "case-b-charging"),
      finalFromLastTool("charging"),
    ]);

    const result = await runtime.run({
      sessionId: "case-b",
      prompt: "Find nearby charging stations.",
    });

    expect(result.status).toBe("succeeded");
    expect(result.response).toContain("station-pudong-001");
    expect(result.availableToolNames).toContain("search_charging_stations");
  });

  it("Case C: removing charging capability makes every charging Tool invisible", async () => {
    const restricted = { ...DEFAULT_PHASE_5_CAPABILITIES, charging: false } as VehicleCapabilities;
    const { runtime } = createRuntime([fauxAssistantMessage("Charging is unavailable.")], {
      capabilities: restricted,
    });

    const result = await runtime.run({
      sessionId: "case-c",
      prompt: "Find nearby charging stations.",
    });

    expect(result.status).toBe("succeeded");
    expect(result.availableToolNames).not.toContain("search_charging_stations");
    expect(result.availableToolNames).not.toContain("get_charging_status");
    expect(result.availableToolNames).not.toContain("reroute_to_charger");
    expect(result.availableToolNames).not.toContain("reserve_charging_slot");
    expect(result.availableToolNames).not.toContain("cancel_charging_reservation");
  });

  it("Case D: reloads world state between turns and observes SOC 72 -> 20", async () => {
    await reset();
    const { runtime } = createRuntime([
      toolRequest("get_vehicle_state", {}, "case-d-first"),
      finalFromLastTool("turn-1"),
      toolRequest("get_vehicle_state", {}, "case-d-second"),
      finalFromLastTool("turn-2"),
    ]);
    const first = await runtime.run({ sessionId: "case-d", prompt: "Check my battery." });
    const mutation = await app.inject({
      method: "POST",
      url: "/simulator/vehicle/soc",
      payload: { soc: 20 },
    });
    expect(mutation.statusCode).toBe(200);
    const second = await runtime.run({ sessionId: "case-d", prompt: "Check it again." });

    expect(first.response).toContain('"soc":72');
    expect(second.response).toContain('"soc":20');
    expect(second.context?.contextVersion).toBeGreaterThan(first.context?.contextVersion ?? 0);
    expect(second.context?.vehicleVersion).toBeGreaterThan(first.context?.vehicleVersion ?? 0);
    expect(runtime.sessionSnapshot("case-d")?.userMessageCount).toBe(2);
  });

  it("completes a no-Tool request without forcing current-state access", async () => {
    const { runtime } = createRuntime([fauxAssistantMessage("Hello from DriveGuard.")]);

    const result = await runtime.run({ sessionId: "no-tool", prompt: "Say hello." });

    expect(result.status).toBe("succeeded");
    expect(result.response).toBe("Hello from DriveGuard.");
    expect(result.events.some((event) => event.eventType === "tool.requested")).toBe(false);
  });

  it("executes one formal Tool with complete required event propagation", async () => {
    const { runtime } = createRuntime([
      toolRequest("get_trip_state", {}, "one-trip"),
      fauxAssistantMessage("Trip state loaded."),
    ]);
    const result = await runtime.run({
      sessionId: "one-tool",
      traceId: "trace-one-tool",
      prompt: "Where am I navigating?",
    });
    const types = result.events.map((event) => event.eventType);

    expect(result.status).toBe("succeeded");
    expect(types).toEqual([
      "agent.run.started",
      "context.loaded",
      "capabilities.resolved",
      "model.started",
      "tool.requested",
      "policy.evaluation.started",
      "policy.decision.made",
      "tool.completed",
      "model.resumed",
      "model.started",
      "agent.run.completed",
    ]);
    expect(result.events.every((event) => event.runId === result.run.runId)).toBe(true);
    expect(result.events.every((event) => event.sessionId === "one-tool")).toBe(true);
    expect(result.events.every((event) => event.traceId === "trace-one-tool")).toBe(true);
  });

  it("executes a parallel two-Tool request and pairs requested/completed events", async () => {
    const { runtime } = createRuntime([
      fauxAssistantMessage(
        [
          fauxToolCall("get_vehicle_state", {}, { id: "parallel-vehicle" }),
          fauxToolCall("get_trip_state", {}, { id: "parallel-trip" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Both current states loaded."),
    ]);

    const result = await runtime.run({
      sessionId: "parallel-tools",
      prompt: "Tell me the battery and remaining trip distance.",
    });

    expect(result.status).toBe("succeeded");
    expect(result.events.filter((event) => event.eventType === "tool.requested")).toHaveLength(2);
    expect(result.events.filter((event) => event.eventType === "tool.completed")).toHaveLength(2);
    const requestedIds = result.events
      .filter((event) => event.eventType === "tool.requested")
      .map((event) => event.metadata?.toolCallId)
      .sort();
    const completedIds = result.events
      .filter((event) => event.eventType === "tool.completed")
      .map((event) => event.metadata?.toolCallId)
      .sort();
    expect(requestedIds).toEqual(completedIds);
    expect(requestedIds).toEqual(["tool-call:1", "tool-call:2"]);
    expect(result.run.statusHistory).toContain("TOOL_PROCESSING");
    expect(result.run.statusHistory).toContain("MODEL_RESUMED");
  });

  it("rejects invalid Pi Tool arguments before formal execution", async () => {
    const { runtime } = createRuntime([
      toolRequest("get_vehicle_state", { extra: true }, "invalid-args"),
      fauxAssistantMessage("Arguments rejected."),
    ]);

    const result = await runtime.run({
      sessionId: "invalid-args",
      prompt: "Use invalid vehicle arguments.",
    });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("TOOL_ERROR");
    expect(
      result.events.find((event) => event.eventType === "tool.completed")?.metadata?.isError,
    ).toBe(true);
  });

  it("returns TOOL_ERROR when a formal dependency fails after context loading", async () => {
    await reset();
    const configured = await app.inject({
      method: "POST",
      url: "/simulator/faults",
      payload: {
        target: "charging.list_stations",
        mode: "http_503",
        probability: 1,
        delayMs: 0,
      },
    });
    expect(configured.statusCode).toBe(201);
    const { runtime } = createRuntime([
      toolRequest("search_charging_stations", {}, "tool-error"),
      fauxAssistantMessage("Charging dependency failed."),
    ]);

    const result = await runtime.run({
      sessionId: "tool-error",
      prompt: "Search charging stations.",
    });
    await app.inject({ method: "DELETE", url: "/simulator/faults" });

    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "TOOL_ERROR", retryable: false });
    expect(result.run.status).toBe("RUN_FAILED");
  });

  it("returns MODEL_ERROR for a provider failure and removes a configured secret", async () => {
    const secret = "phase5-provider-secret";
    const { runtime } = createRuntime(
      [
        fauxAssistantMessage([], {
          stopReason: "error",
          errorMessage: `provider unavailable api_key=${secret}`,
        }),
      ],
      { sensitiveValues: [secret] },
    );

    const result = await runtime.run({ sessionId: "provider-error", prompt: "Fail safely." });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("MODEL_ERROR");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("api_key");
  });

  it("rolls back a failed provider turn before the next model request", async () => {
    const secret = "phase5-transcript-secret";
    let secondRequest = "";
    const { runtime } = createRuntime(
      [
        fauxAssistantMessage([], {
          stopReason: "error",
          errorMessage: `provider unavailable token=${secret}`,
        }),
        (context) => {
          secondRequest = JSON.stringify(context.messages);
          return fauxAssistantMessage("Recovered safely.");
        },
      ],
      { sensitiveValues: [secret] },
    );

    const failed = await runtime.run({ sessionId: "rollback", prompt: "First turn." });
    const recovered = await runtime.run({ sessionId: "rollback", prompt: "Second turn." });

    expect(failed.status).toBe("failed");
    expect(recovered.status).toBe("succeeded");
    expect(secondRequest).not.toContain(secret);
    expect(secondRequest).not.toContain("First turn.");
    expect(runtime.sessionSnapshot("rollback")?.userMessageCount).toBe(1);
  });

  it("maps a rejecting event sink to a structured secret-safe failure", async () => {
    const secret = "event-sink-secret";
    const sink: RuntimeEventSink = {
      emit: vi.fn(() => Promise.reject(new Error(`secret=${secret}`))),
    };
    const { runtime } = createRuntime([fauxAssistantMessage("unused")], {
      eventSink: sink,
      sensitiveValues: [secret],
    });

    const result = await runtime.run({ sessionId: "sink-failure", prompt: "Hello." });

    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Runtime event delivery failed safely",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.run.status).toBe("RUN_FAILED");
  });

  it("does not report RUN_SUCCEEDED when terminal event delivery fails", async () => {
    const sink: RuntimeEventSink = {
      emit: vi.fn((event: RuntimeEvent) =>
        event.eventType === "agent.run.completed"
          ? Promise.reject(new Error("terminal sink failure"))
          : Promise.resolve(),
      ),
    };
    const { runtime } = createRuntime([fauxAssistantMessage("Ready.")], { eventSink: sink });

    const result = await runtime.run({ sessionId: "terminal-sink-failure", prompt: "Hello." });

    expect(result.status).toBe("failed");
    expect(result.run.status).toBe("RUN_FAILED");
    expect(result.error?.code).toBe("INTERNAL_ERROR");
    expect(result.events.map((event) => event.eventType)).not.toContain("agent.run.completed");
    expect(result.events.at(-1)?.eventType).toBe("agent.run.failed");
  });

  it("stops a development side-effect before dispatch when tool.requested delivery fails", async () => {
    await reset();
    const sink: RuntimeEventSink = {
      emit: vi.fn((event: RuntimeEvent) =>
        event.eventType === "tool.requested"
          ? Promise.reject(new Error("requested event unavailable"))
          : Promise.resolve(),
      ),
    };
    const { runtime } = createRuntime(
      [toolRequest("set_media_volume", { volume: 61 }, "sink-blocked-side-effect")],
      { mode: "development", developmentExecutionOptIn: true, eventSink: sink },
    );

    const result = await runtime.run({
      sessionId: "sink-blocked-side-effect",
      prompt: "Volume 61.",
    });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("INTERNAL_ERROR");
    expect(await simulatorMediaVolume()).toBe(35);
    expect(result.toolExecutions).toEqual([]);
  });

  it.each(["runIdFactory", "traceIdFactory", "eventIdFactory"] as const)(
    "maps a throwing %s to a structured Runtime failure",
    async (factoryName) => {
      const secret = `secret-${factoryName}`;
      const { runtime } = createRuntime([fauxAssistantMessage("unused")], {
        [factoryName]: () => {
          throw new Error(secret);
        },
        sensitiveValues: [secret],
      });

      const result = await runtime.run({ sessionId: `factory-${factoryName}`, prompt: "Hello." });

      expect(result.status).toBe("failed");
      expect(result.run.status).toBe("RUN_FAILED");
      expect(result.error).toMatchObject({
        code: "INTERNAL_ERROR",
        message: "Runtime identity or Event factory failed safely",
      });
      expect(JSON.stringify(result)).not.toContain(secret);
    },
  );

  it("rejects invalid and duplicate generated identities without raw rejection", async () => {
    const invalid = createRuntime([fauxAssistantMessage("unused")], {
      runIdFactory: () => "invalid id with spaces",
    }).runtime;
    const invalidResult = await invalid.run({
      sessionId: "invalid-generated-id",
      prompt: "Hello.",
    });

    const duplicate = createRuntime([fauxAssistantMessage("First.")], {
      runIdFactory: () => "run:duplicate",
    }).runtime;
    const first = await duplicate.run({ sessionId: "duplicate-id", prompt: "First." });
    const second = await duplicate.run({ sessionId: "duplicate-id", prompt: "Second." });

    expect(invalidResult).toMatchObject({ status: "failed", error: { code: "INTERNAL_ERROR" } });
    expect(first.status).toBe("succeeded");
    expect(second).toMatchObject({ status: "failed", error: { code: "INTERNAL_ERROR" } });
    expect(second.run.runId).not.toBe(first.run.runId);
  });

  it("rejects duplicate generated Event IDs and preserves unique fallback evidence", async () => {
    const { runtime } = createRuntime([fauxAssistantMessage("unused")], {
      eventIdFactory: () => "event:duplicate",
    });

    const result = await runtime.run({ sessionId: "duplicate-event-id", prompt: "Hello." });

    expect(result).toMatchObject({
      status: "failed",
      run: { status: "RUN_FAILED" },
      error: { code: "INTERNAL_ERROR" },
    });
    expect(new Set(result.events.map((event) => event.eventId)).size).toBe(result.events.length);
  });

  it("returns SESSION_BUSY for a concurrent run in the same session without event mixing", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { runtime } = createRuntime([
      async () => {
        await held;
        return fauxAssistantMessage("First complete.");
      },
    ]);
    const firstPromise = runtime.run({ sessionId: "busy-session", prompt: "First." });
    await vi.waitFor(() =>
      expect(runtime.sessionSnapshot("busy-session")?.activeRunId).toBeDefined(),
    );
    const second = await runtime.run({ sessionId: "busy-session", prompt: "Second." });
    release?.();
    const first = await firstPromise;

    expect(second.status).toBe("failed");
    expect(second.error?.code).toBe("SESSION_BUSY");
    expect(second.run.runId).not.toBe(first.run.runId);
    expect(second.events.every((event) => event.runId === second.run.runId)).toBe(true);
    expect(first.status).toBe("succeeded");
  });

  it("allows different sessions to run concurrently without message or run contamination", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { runtime } = createRuntime([
      async () => {
        await held;
        return fauxAssistantMessage("Session one complete.");
      },
      async () => {
        await held;
        return fauxAssistantMessage("Session two complete.");
      },
    ]);
    const firstPromise = runtime.run({ sessionId: "parallel-session-1", prompt: "One." });
    const secondPromise = runtime.run({ sessionId: "parallel-session-2", prompt: "Two." });
    await vi.waitFor(() => expect(runtime.sessionCount).toBe(2));
    release?.();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("succeeded");
    expect(first.run.runId).not.toBe(second.run.runId);
    expect(first.events.every((event) => event.sessionId === "parallel-session-1")).toBe(true);
    expect(second.events.every((event) => event.sessionId === "parallel-session-2")).toBe(true);
    expect(runtime.sessionSnapshot("parallel-session-1")?.userMessageCount).toBe(1);
    expect(runtime.sessionSnapshot("parallel-session-2")?.userMessageCount).toBe(1);
  });

  it("cancels an active model run with RUN_CANCELLED terminal state", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { runtime } = createRuntime([
      async () => {
        await held;
        return fauxAssistantMessage("Should be cancelled.");
      },
    ]);
    const promise = runtime.run({ sessionId: "cancel-session", prompt: "Wait." });
    await vi.waitFor(() =>
      expect(runtime.sessionSnapshot("cancel-session")?.activeRunId).toBeDefined(),
    );

    expect(runtime.cancel("cancel-session")).toBe(true);
    release?.();
    const result = await promise;

    expect(result.status).toBe("cancelled");
    expect(result.error?.code).toBe("RUN_CANCELLED");
    expect(result.run.status).toBe("RUN_CANCELLED");
    expect(runtime.cancel("cancel-session")).toBe(false);
  });

  it("records a side effect that settles successfully after cancellation", async () => {
    await reset();
    const fault = await app.inject({
      method: "POST",
      url: "/simulator/faults",
      payload: {
        target: "media.set_volume",
        mode: "delay",
        probability: 1,
        delayMs: 120,
      },
    });
    expect(fault.statusCode).toBe(201);
    let requested: (() => void) | undefined;
    const toolRequested = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const sink: RuntimeEventSink = {
      emit: (event) => {
        if (event.eventType === "tool.requested") requested?.();
      },
    };
    const { runtime } = createRuntime(
      [toolRequest("set_media_volume", { volume: 61 }, "cancelled-side-effect")],
      { mode: "development", developmentExecutionOptIn: true, eventSink: sink },
    );
    const resultPromise = runtime.run({
      sessionId: "cancelled-side-effect",
      prompt: "Set volume to 61.",
    });
    await toolRequested;
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(runtime.cancel("cancelled-side-effect")).toBe(true);
    const result = await resultPromise;
    await app.inject({ method: "DELETE", url: "/simulator/faults" });

    expect(result.status).toBe("cancelled");
    expect(result.run.status).toBe("RUN_CANCELLED");
    expect(await simulatorMediaVolume()).toBe(61);
    expect(result.toolExecutions).toMatchObject([
      {
        toolName: "set_media_volume",
        outcome: "succeeded",
        completedAfterCancel: true,
        result: { applied: true, volume: 61 },
      },
    ]);
  });

  it("read_only mode exposes only R0 definitions even with full capability", async () => {
    const { runtime } = createRuntime([fauxAssistantMessage("Read only.")]);
    const result = await runtime.run({ sessionId: "read-only", prompt: "Hello." });

    expect(result.availableToolNames).toEqual([
      "get_charging_status",
      "get_trip_state",
      "get_vehicle_state",
      "get_weather",
      "search_charging_stations",
    ]);
    expect(result.availableToolNames).toHaveLength(5);
  });

  it("development mode exposes all 14 formal definitions only after explicit opt-in", async () => {
    const { runtime } = createRuntime([fauxAssistantMessage("Development.")], {
      mode: "development",
      developmentExecutionOptIn: true,
    });
    const result = await runtime.run({ sessionId: "development", prompt: "Hello." });

    expect(result.availableToolNames).toHaveLength(14);
    expect(result.runtimeMode).toBe("development");
    expect(result.safetyNotice).toContain("deterministic Policy is enforced");
    expect(result.events.every((event) => event.metadata?.boundary === "POLICY_GUARDED")).toBe(
      true,
    );
  });

  it("rejects development mode without explicit NON_PRODUCTION opt-in", () => {
    expect(() =>
      createRuntime([], { mode: "development", developmentExecutionOptIn: false }),
    ).toThrow(AgentRuntimeError);
  });

  it("removes seat-heating Tool when seatHeating capability is false", async () => {
    const capabilities = {
      ...DEFAULT_PHASE_5_CAPABILITIES,
      seatHeating: false,
    } as VehicleCapabilities;
    const { runtime } = createRuntime([fauxAssistantMessage("Unavailable.")], {
      capabilities,
      mode: "development",
      developmentExecutionOptIn: true,
    });
    const result = await runtime.run({ sessionId: "no-seat", prompt: "Hello." });

    expect(result.availableToolNames).not.toContain("set_seat_heating");
    expect(result.availableToolNames).toHaveLength(13);
  });

  it.each([
    ["vehicleSimulator", "get_vehicle_state"],
    ["weather", "get_weather"],
    ["emergencySupport", "request_emergency_support"],
  ] as const)(
    "removes %s-dependent Tool %s when the service is unavailable",
    async (service, tool) => {
      const services = { ...DEFAULT_PHASE_5_SERVICES, [service]: false };
      const { runtime } = createRuntime([fauxAssistantMessage("Service unavailable.")], {
        services,
        mode: "development",
        developmentExecutionOptIn: true,
      });
      const result = await runtime.run({ sessionId: `service-${service}`, prompt: "Hello." });

      expect(result.availableToolNames).not.toContain(tool);
    },
  );

  it("refreshes capabilities and service availability on every turn of one session", async () => {
    let currentCapabilities = structuredClone(DEFAULT_PHASE_5_CAPABILITIES);
    let currentServices = structuredClone(DEFAULT_PHASE_5_SERVICES);
    const capabilitiesProvider = vi.fn(() => Promise.resolve(structuredClone(currentCapabilities)));
    const serviceAvailabilityProvider = vi.fn(() =>
      Promise.resolve(structuredClone(currentServices)),
    );
    const { runtime } = createRuntime(
      [fauxAssistantMessage("First."), fauxAssistantMessage("Second.")],
      {
        mode: "development",
        developmentExecutionOptIn: true,
        capabilitiesProvider,
        serviceAvailabilityProvider,
      },
    );

    const first = await runtime.run({ sessionId: "dynamic-availability", prompt: "First." });
    currentCapabilities = { ...currentCapabilities, seatHeating: false };
    currentServices = { ...currentServices, emergencySupport: false };
    const second = await runtime.run({ sessionId: "dynamic-availability", prompt: "Second." });

    expect(first.availableToolNames).toContain("set_seat_heating");
    expect(first.availableToolNames).toContain("request_emergency_support");
    expect(second.availableToolNames).not.toContain("set_seat_heating");
    expect(second.availableToolNames).not.toContain("request_emergency_support");
    expect(capabilitiesProvider).toHaveBeenCalledTimes(2);
    expect(serviceAvailabilityProvider).toHaveBeenCalledTimes(2);
  });

  it("retains NOT_LATEST evidence until a Tool request reaches Policy", async () => {
    const { runtime } = createRuntime([fauxAssistantMessage("unused")], {
      latestContextVersionProvider: (snapshotVersion) => snapshotVersion + 1,
    });

    const result = await runtime.run({ sessionId: "not-latest", prompt: "Hello." });

    expect(result.status).toBe("succeeded");
    expect(result.context?.freshness.status).toBe("NOT_LATEST");
    expect(result.policyDecisions).toEqual([]);
  });

  it("never exposes any RX name", async () => {
    const { runtime } = createRuntime([fauxAssistantMessage("Safe Tool space.")], {
      mode: "development",
      developmentExecutionOptIn: true,
    });
    const result = await runtime.run({ sessionId: "rx-zero", prompt: "Hello." });

    expect(result.availableToolNames).not.toEqual(
      expect.arrayContaining([
        "apply_brake",
        "control_steering",
        "set_throttle",
        "disable_aeb",
        "disable_esc",
      ]),
    );
  });

  it("creates unique run, trace, event and context identities across turns", async () => {
    const { runtime } = createRuntime([
      fauxAssistantMessage("First."),
      fauxAssistantMessage("Second."),
    ]);
    const first = await runtime.run({ sessionId: "unique", prompt: "First." });
    const second = await runtime.run({ sessionId: "unique", prompt: "Second." });

    expect(second.run.runId).not.toBe(first.run.runId);
    expect(second.run.traceId).not.toBe(first.run.traceId);
    expect(second.context?.snapshotId).not.toBe(first.context?.snapshotId);
    expect(new Set([...first.events, ...second.events].map((event) => event.eventId)).size).toBe(
      first.events.length + second.events.length,
    );
  });

  it("keeps Phase 1 fixture marker out of production Tool results and events", async () => {
    const { runtime } = createRuntime([
      toolRequest("get_vehicle_state", {}, "phase1-isolation"),
      finalFromLastTool("formal"),
    ]);
    const result = await runtime.run({ sessionId: "phase1-isolation", prompt: "Battery?" });

    expect(JSON.stringify(result)).not.toContain("PHASE_1_FIXTURE_ONLY");
    expect(runtime.sessionSnapshot("phase1-isolation")?.toolNames).toContain("get_vehicle_state");
    expect(Reflect.has(runtime, "sessions")).toBe(false);
  });
});
