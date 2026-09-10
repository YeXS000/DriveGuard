import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

import {
  Phase1Runtime,
  Phase1ToolInstrumentation,
} from "../../packages/agent-runtime/src/index.js";

function createFauxRuntime(responses: FauxResponseStep[], sensitiveValues: readonly string[] = []) {
  const faux = fauxProvider({ provider: "driveguard-phase1-faux", api: "phase1-faux-api" });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  const runtime = new Phase1Runtime({
    model: faux.getModel(),
    streamFn: models.streamSimple.bind(models),
    sessionId: "phase1-test-session",
    sensitiveValues,
  });
  return { faux, runtime };
}

function toolRequest(name: string, arguments_: Record<string, unknown>, id: string) {
  return fauxAssistantMessage(fauxToolCall(name, arguments_, { id }), { stopReason: "toolUse" });
}

const requiredEventTypes = [
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_end",
  "tool_execution_start",
  "tool_execution_end",
] as const;

function expectToolPairing(events: readonly { type: string; toolCallId?: string }[]): void {
  const starts = events
    .filter((event) => event.type === "tool_execution_start")
    .map((event) => event.toolCallId);
  const ends = events
    .filter((event) => event.type === "tool_execution_end")
    .map((event) => event.toolCallId);

  expect(starts).not.toContain(undefined);
  expect(ends).not.toContain(undefined);
  expect(new Set(starts).size).toBe(starts.length);
  expect(new Set(ends).size).toBe(ends.length);
  expect([...ends].sort()).toEqual([...starts].sort());
}

function createRawInstrumentedAgent(
  responses: FauxResponseStep[],
  tools: AgentTool[],
  instrumentation: Phase1ToolInstrumentation,
): { agent: Agent; events: AgentEvent[] } {
  const faux = fauxProvider({ provider: "phase1-hook-faux", api: "phase1-hook-api" });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  const agent = new Agent({
    initialState: { model: faux.getModel(), tools },
    streamFn: models.streamSimple.bind(models),
    beforeToolCall: instrumentation.beforeToolCall,
    afterToolCall: instrumentation.afterToolCall,
  });
  const events: AgentEvent[] = [];
  agent.subscribe((event) => {
    events.push(event);
  });
  return { agent, events };
}

describe("Phase 1 Pi Agent loop", () => {
  it("executes a valid tool through both hooks with complete paired lifecycle events", async () => {
    const { runtime } = createFauxRuntime([
      toolRequest("get_vehicle_state", {}, "vehicle-1"),
      fauxAssistantMessage("The battery level is 67%"),
    ]);

    const result = await runtime.run("What is the current vehicle battery level?");
    const eventTypes = result.events.map((event) => event.type);

    expect(result.status).toBe("succeeded");
    expect(result.response).toContain("67");
    expect(result.terminalState).toBe("idle");
    for (const requiredEventType of requiredEventTypes) {
      expect(eventTypes).toContain(requiredEventType);
    }
    expect(eventTypes.filter((eventType) => eventType !== "message_update")).toEqual([
      "agent_start",
      "turn_start",
      "message_start",
      "message_end",
      "message_start",
      "message_end",
      "tool_execution_start",
      "tool_execution_end",
      "message_start",
      "message_end",
      "turn_end",
      "turn_start",
      "message_start",
      "message_end",
      "turn_end",
      "agent_end",
    ]);
    expect(result.events.filter((event) => event.type === "tool_execution_start")).toHaveLength(1);
    expect(result.events.filter((event) => event.type === "tool_execution_end")).toHaveLength(1);
    expectToolPairing(result.events);
    expect(result.instrumentation).toEqual([
      { stage: "beforeToolCall", toolName: "get_vehicle_state", allowed: true },
      {
        stage: "afterToolCall",
        toolName: "get_vehicle_state",
        allowed: true,
        isError: false,
      },
    ]);
  });

  it("rejects malformed arguments before beforeToolCall or execute", async () => {
    const { runtime } = createFauxRuntime([
      toolRequest("get_vehicle_state", { unexpected: true }, "invalid-1"),
      fauxAssistantMessage("The tool arguments were rejected"),
    ]);

    const result = await runtime.run("Call the vehicle tool with malformed arguments");
    const toolResult = runtime.getStateSnapshot().toolResults.at(-1);

    expect(result.status).toBe("succeeded");
    expect(result.instrumentation).toEqual([]);
    expect(toolResult).toEqual({
      toolName: "get_vehicle_state",
      isError: true,
      fixtureResult: false,
    });
    expectToolPairing(result.events);
  });

  it("does not execute an unknown tool", async () => {
    const { runtime } = createFauxRuntime([
      toolRequest("unknown_vehicle_command", {}, "unknown-1"),
      fauxAssistantMessage("That tool is unavailable"),
    ]);

    const result = await runtime.run("Use an unknown tool");
    const toolResult = runtime.getStateSnapshot().toolResults.at(-1);

    expect(result.status).toBe("succeeded");
    expect(result.instrumentation).toEqual([]);
    expect(toolResult).toEqual({
      toolName: "unregistered_tool",
      isError: true,
      fixtureResult: false,
    });
    expectToolPairing(result.events);
  });

  it("completes a no-tool lifecycle without forcing a tool call", async () => {
    const { runtime } = createFauxRuntime([fauxAssistantMessage("Hello!")]);

    const result = await runtime.run("Say hello.");

    expect(result).toMatchObject({ status: "succeeded", response: "Hello!" });
    expect(result.events.some((event) => event.type === "agent_start")).toBe(true);
    expect(result.events.some((event) => event.type === "agent_end")).toBe(true);
    expect(result.events.some((event) => event.type === "tool_execution_start")).toBe(false);
    expect(result.instrumentation).toEqual([]);
  });

  it("keeps basic multi-turn transcript state in one Agent session", async () => {
    const { runtime } = createFauxRuntime([
      toolRequest("get_vehicle_state", {}, "multi-vehicle"),
      fauxAssistantMessage("Your battery is at 67%."),
      toolRequest("get_trip_state", {}, "multi-trip"),
      fauxAssistantMessage("Navigation is active with 42.5 km remaining."),
    ]);

    const first = await runtime.run("What is my current battery level?");
    const second = await runtime.run("And what about the trip?");
    const state = runtime.getStateSnapshot();

    expect(first.response).toContain("67");
    expect(second.response).toContain("42.5");
    expect(state.userMessageCount).toBe(2);
    expect(second.instrumentation.map((record) => record.toolName)).toEqual([
      "get_trip_state",
      "get_trip_state",
    ]);
  });

  it("supports a parallel two-tool batch and pairs every start/end", async () => {
    const { runtime } = createFauxRuntime([
      fauxAssistantMessage(
        [
          fauxToolCall("get_vehicle_state", {}, { id: "both-vehicle" }),
          fauxToolCall("get_trip_state", {}, { id: "both-trip" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Battery is 67%; 42.5 km remain."),
    ]);

    const result = await runtime.run("Tell me the battery level and how far is left on my trip.");
    const toolEvents = result.events.filter(
      (event) => event.type === "tool_execution_start" || event.type === "tool_execution_end",
    );

    expect(result.response).toContain("67");
    expect(result.response).toContain("42.5");
    expect(toolEvents.map((event) => event.type)).toEqual([
      "tool_execution_start",
      "tool_execution_start",
      "tool_execution_end",
      "tool_execution_end",
    ]);
    expect(toolEvents.filter((event) => event.type === "tool_execution_start")).toHaveLength(2);
    expect(toolEvents.filter((event) => event.type === "tool_execution_end")).toHaveLength(2);
    expectToolPairing(result.events);
  });

  it("blocks a registered but out-of-scope test probe before execute", async () => {
    const instrumentation = new Phase1ToolInstrumentation();
    const execute = vi.fn(() =>
      Promise.resolve({ content: [{ type: "text" as const, text: "must not run" }], details: {} }),
    );
    const probe: AgentTool = {
      name: "out_of_scope_probe",
      label: "Out of scope test probe",
      description: "Test-only probe for the installed Phase 1 hook",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute,
    };
    const { agent, events } = createRawInstrumentedAgent(
      [
        toolRequest("out_of_scope_probe", {}, "blocked-probe"),
        fauxAssistantMessage("The probe was blocked."),
      ],
      [probe],
      instrumentation,
    );

    await agent.prompt("Try the out-of-scope test probe");
    const end = events.find(
      (event) => event.type === "tool_execution_end" && event.toolName === "out_of_scope_probe",
    );

    expect(execute).not.toHaveBeenCalled();
    expect(end).toMatchObject({ type: "tool_execution_end", isError: true });
    expect(instrumentation.slice()).toEqual([
      { stage: "beforeToolCall", toolName: "out_of_scope_probe", allowed: false },
    ]);
  });

  it("observes afterToolCall with isError when an allowed test execution throws", async () => {
    const instrumentation = new Phase1ToolInstrumentation();
    const failingTool: AgentTool = {
      name: "get_vehicle_state",
      label: "Failing allowed test tool",
      description: "Test-only failure path for afterToolCall",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: () => Promise.reject(new Error("controlled test tool failure")),
    };
    const { agent, events } = createRawInstrumentedAgent(
      [
        toolRequest("get_vehicle_state", {}, "failing-allowed"),
        fauxAssistantMessage("The allowed test tool failed safely."),
      ],
      [failingTool],
      instrumentation,
    );

    await agent.prompt("Exercise the allowed test failure path");

    expect(
      events.find(
        (event) => event.type === "tool_execution_end" && event.toolCallId === "failing-allowed",
      ),
    ).toMatchObject({ type: "tool_execution_end", isError: true });
    expect(instrumentation.slice()).toEqual([
      { stage: "beforeToolCall", toolName: "get_vehicle_state", allowed: true },
      {
        stage: "afterToolCall",
        toolName: "get_vehicle_state",
        allowed: true,
        isError: true,
      },
    ]);
  });

  it("reports a concurrent call as busy without mixing run events", async () => {
    let release: (() => void) | undefined;
    const heldResponse = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { runtime } = createFauxRuntime([
      async () => {
        await heldResponse;
        return fauxAssistantMessage("First run complete.");
      },
    ]);

    const firstPromise = runtime.run("Hold the first run");
    const second = await runtime.run("Attempt a concurrent run");
    release?.();
    const first = await firstPromise;

    expect(second).toMatchObject({
      status: "failed",
      terminalState: "busy",
      events: [],
      instrumentation: [],
      error: { code: "AGENT_ERROR", message: "Agent is already processing a prompt" },
    });
    expect(first.status).toBe("succeeded");
    expect(first.terminalState).toBe("idle");
  });

  it("normalizes provider-controlled tool metadata before returning events or state", async () => {
    const secret = "phase1-secret-metadata";
    const { runtime } = createFauxRuntime(
      [toolRequest(secret, {}, secret), fauxAssistantMessage("Unknown tool was rejected")],
      [secret],
    );

    const result = await runtime.run("Exercise metadata redaction");
    const serialized = JSON.stringify({ result, state: runtime.getStateSnapshot() });

    expect(serialized).not.toContain(secret);
    expect(result.events.find((event) => event.type === "tool_execution_start")).toMatchObject({
      toolCallId: "phase1-tool-call-1",
      toolName: "unregistered_tool",
    });
  });

  it("turns a provider failure into a controlled terminal result and redacts secrets", async () => {
    const secret = "phase1-test-secret-value";
    const { runtime } = createFauxRuntime(
      [
        fauxAssistantMessage([], {
          stopReason: "error",
          errorMessage: `provider unavailable: ${secret}`,
        }),
      ],
      [secret],
    );

    const result = await runtime.run("Trigger a controlled provider error");
    const serialized = JSON.stringify(result);

    expect(result.status).toBe("failed");
    expect(result.terminalState).toBe("idle");
    expect(result.error).toEqual({
      code: "AGENT_ERROR",
      message: "provider unavailable: [REDACTED]",
    });
    expect(serialized).not.toContain(secret);
    expect(result.events.at(-1)?.type).toBe("agent_end");
  });
});
