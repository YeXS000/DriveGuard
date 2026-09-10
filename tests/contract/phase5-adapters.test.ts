import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { FixedClock } from "@driveguard/shared";
import { ToolExecutionError, type ToolDefinition } from "@driveguard/tools";
import { Type } from "typebox";
import Schema from "typebox/schema";
import { describe, expect, it, vi } from "vitest";

import {
  AgentRun,
  InMemoryRuntimeEventSink,
  PHASE_5_PRE_POLICY_NOTICE,
  PiEventAdapter,
  PiToolAdapter,
  RuntimeEventFactory,
} from "../../packages/agent-runtime/src/index.js";

const clock = new FixedClock(Date.parse("2026-08-27T08:00:00.000Z"));

function guardedAdapter(
  mode: "read_only" | "development",
  observer?: ConstructorParameters<typeof PiToolAdapter>[1],
): PiToolAdapter {
  const testOnlyPassThroughGuard = {
    execute: (_definition: ToolDefinition, _arguments: unknown, handler: () => Promise<unknown>) =>
      handler(),
  };
  return new PiToolAdapter(mode, observer, testOnlyPassThroughGuard as never);
}

function definition(name = "formal_test_tool"): ToolDefinition {
  const inputSchema = Type.Object(
    { value: Type.Integer({ minimum: 0, maximum: 10 }) },
    { additionalProperties: false },
  );
  const outputSchema = Type.Object(
    { doubled: Type.Integer({ minimum: 0, maximum: 20 }) },
    { additionalProperties: false },
  );
  const input = Schema.Compile(inputSchema);
  const output = Schema.Compile(outputSchema);
  return {
    name,
    label: "Formal test tool",
    description: "A formal ToolDefinition used to verify the unique Pi adapter boundary.",
    inputSchema,
    outputSchema,
    riskLevel: "R0",
    requiredCapabilities: [],
    requiredServices: [],
    sideEffect: false,
    timeoutHintMs: 1_000,
    idempotencyHint: "READ_ONLY",
    auditLevel: "BASIC",
    execute: (value) => {
      if (!input.Check(value)) {
        return Promise.reject(
          new ToolExecutionError("TOOL_VALIDATION_ERROR", name, "invalid input"),
        );
      }
      const result = { doubled: value.value * 2 };
      if (!output.Check(result)) return Promise.reject(new Error("test output invalid"));
      return Promise.resolve(result);
    },
  };
}

function runningRun(): AgentRun {
  const run = new AgentRun(
    {
      runId: "run:adapter",
      sessionId: "session:adapter",
      traceId: "trace:adapter",
      createdAt: "2026-08-27T08:00:00.000Z" as never,
    },
    clock,
  );
  run.transition("CONTEXT_LOADING");
  run.transition("CAPABILITY_RESOLUTION");
  run.transition("MODEL_RUNNING");
  return run;
}

describe("Phase 5 PiToolAdapter contract", () => {
  it.each(["read_only", "development"] as const)(
    "maps name, label, description and schema in %s mode",
    (mode) => {
      const source = definition();
      const tool = guardedAdapter(mode).adapt(source);

      expect(tool.name).toBe(source.name);
      expect(tool.label).toBe(source.label);
      expect(tool.description).toBe(source.description);
      expect(tool.parameters).toBe(source.inputSchema);
      expect(Object.isFrozen(tool)).toBe(true);
    },
  );

  it.each(["read_only", "development"] as const)(
    "executes the formal contract and returns validated details in %s mode",
    async (mode) => {
      const result = await guardedAdapter(mode)
        .adapt(definition())
        .execute("pi-call-raw-id", { value: 4 });

      expect(result.details).toEqual({
        source: "FORMAL_TOOL_CONTRACT",
        toolName: "formal_test_tool",
        result: { doubled: 8 },
        runtimeMode: mode,
        safetyBoundary: "POLICY_GUARDED",
        productionSafety: "PHASE_6_POLICY_ENFORCED",
      });
      expect(result.content).toEqual([
        {
          type: "text",
          text: '{"toolName":"formal_test_tool","result":{"doubled":8}}',
        },
      ]);
      expect(JSON.stringify(result)).not.toContain("pi-call-raw-id");
    },
  );

  it("propagates formal input validation rejection without invoking a second handler", async () => {
    const tool = guardedAdapter("read_only").adapt(definition());

    await expect(tool.execute("call-invalid", { value: 11 })).rejects.toMatchObject({
      code: "TOOL_VALIDATION_ERROR",
      toolName: "formal_test_tool",
    });
  });

  it("propagates a formal Tool error as a rejected Pi Tool execution", async () => {
    const source = definition();
    const failing = { ...source, execute: vi.fn(() => Promise.reject(new Error("failure"))) };
    const evidence: unknown[] = [];
    const tool = guardedAdapter("read_only", (execution) => evidence.push(execution)).adapt(
      failing,
    );

    await expect(tool.execute("call-failure", { value: 1 })).rejects.toThrow("failure");
    expect(failing.execute).toHaveBeenCalledOnce();
    expect(evidence).toMatchObject([
      {
        toolName: "formal_test_tool",
        outcome: "failed",
        validatedArguments: { value: 1 },
      },
    ]);
  });

  it("rejects a schema-invalid handler result at the Pi boundary", async () => {
    const source = definition();
    const invalid = {
      ...source,
      execute: vi.fn(() => Promise.resolve({ doubled: 99 })),
    } as ToolDefinition;
    const tool = guardedAdapter("read_only").adapt(invalid);

    await expect(tool.execute("call-invalid-output", { value: 1 })).rejects.toMatchObject({
      code: "DEPENDENCY_RESPONSE_INVALID",
      toolName: "formal_test_tool",
    });
  });

  it("rejects Tool input that cannot be safely cloned", async () => {
    const parameters = new Proxy({ value: 1 }, {});
    const tool = guardedAdapter("read_only").adapt(definition());

    await expect(tool.execute("call-uncloneable-input", parameters)).rejects.toMatchObject({
      code: "TOOL_VALIDATION_ERROR",
      toolName: "formal_test_tool",
    });
  });

  it("rejects formal output that cannot be safely cloned", async () => {
    const source = definition();
    const uncloneable = {
      ...source,
      execute: vi.fn(() => Promise.resolve(new Proxy({ doubled: 2 }, {}))),
    } as ToolDefinition;

    await expect(
      guardedAdapter("read_only").adapt(uncloneable).execute("call-uncloneable-output", {
        value: 1,
      }),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_RESPONSE_INVALID",
      toolName: "formal_test_tool",
    });
  });

  it("rejects an already-aborted Tool call before invoking its handler", async () => {
    const source = definition();
    const execute = vi.spyOn(source, "execute");
    const controller = new AbortController();
    controller.abort();

    await expect(
      guardedAdapter("development")
        .adapt(source)
        .execute("call-pre-aborted", { value: 1 }, controller.signal),
    ).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not become idle or report success while a cancelled dependency is unsettled", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const source = definition();
    const delayed = {
      ...source,
      execute: vi.fn(async () => {
        await held;
        return { doubled: 2 };
      }),
    } as ToolDefinition;
    const evidence: unknown[] = [];
    const adapter = guardedAdapter("development", (execution) => evidence.push(execution));
    const controller = new AbortController();
    const execution = adapter
      .adapt(delayed)
      .execute("call-cancelled", { value: 1 }, controller.signal);
    controller.abort();
    let idle = false;
    const idlePromise = adapter.waitForIdle().then(() => {
      idle = true;
    });

    await Promise.resolve();
    expect(idle).toBe(false);
    release?.();
    await expect(execution).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    await idlePromise;
    expect(idle).toBe(true);
    expect(evidence).toMatchObject([
      {
        toolName: "formal_test_tool",
        outcome: "succeeded",
        completedAfterCancel: true,
        validatedArguments: { value: 1 },
        result: { doubled: 2 },
      },
    ]);
  });

  it("maps a deterministic list without changing source order", () => {
    const definitions = [definition("tool_c"), definition("tool_a"), definition("tool_b")];
    const tools = guardedAdapter("read_only").adaptAll(definitions);

    expect(tools.map((tool) => tool.name)).toEqual(["tool_c", "tool_a", "tool_b"]);
    expect(Object.isFrozen(tools)).toBe(true);
  });

  it("exposes the required pre-Policy warning verbatim", () => {
    expect(PHASE_5_PRE_POLICY_NOTICE).toBe(
      "Phase 5 execution path is pre-Policy and not production-safe for side-effect tools.",
    );
  });

  it("fails closed without a Policy guard and executes zero handlers", async () => {
    const source = definition();
    const execute = vi.spyOn(source, "execute");
    await expect(
      new PiToolAdapter("development").adapt(source).execute("missing-policy", { value: 2 }),
    ).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("Phase 5 PiEventAdapter contract", () => {
  it("maps one formal Tool lifecycle and model resume with stable run identity", async () => {
    const run = runningRun();
    const sink = new InMemoryRuntimeEventSink();
    let sequence = 0;
    const factory = new RuntimeEventFactory({
      clock,
      eventIdFactory: () => `event:${++sequence}`,
    });
    const adapter = new PiEventAdapter({
      run,
      exposedToolNames: ["formal_test_tool"],
      eventFactory: factory,
      emit: (event) => sink.emit(event),
    });

    await adapter.observe({
      type: "tool_execution_start",
      toolCallId: "provider-controlled-secret-id",
      toolName: "formal_test_tool",
      args: { secret: "not-retained" },
    });
    await adapter.observe({
      type: "tool_execution_end",
      toolCallId: "provider-controlled-secret-id",
      toolName: "formal_test_tool",
      result: { secret: "not-retained" },
      isError: false,
    });
    await adapter.observe({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [],
        api: "faux",
        provider: "faux",
        model: "faux",
        usage: {},
      } as never,
      toolResults: [{} as never],
    });

    expect(run.status).toBe("MODEL_RESUMED");
    expect(sink.slice().map((event) => event.eventType)).toEqual([
      "tool.requested",
      "tool.completed",
      "model.resumed",
    ]);
    expect(sink.slice().every((event) => event.runId === "run:adapter")).toBe(true);
    expect(sink.slice().every((event) => event.sessionId === "session:adapter")).toBe(true);
    expect(sink.slice().every((event) => event.traceId === "trace:adapter")).toBe(true);
    expect(sink.slice()[0]?.metadata?.toolCallId).toBe("tool-call:1");
    expect(sink.slice()[1]?.metadata?.toolCallId).toBe("tool-call:1");
    expect(JSON.stringify(sink.slice())).not.toContain("provider-controlled-secret-id");
    expect(JSON.stringify(sink.slice())).not.toContain("not-retained");
  });

  it("maps unexposed names to unregistered_tool", async () => {
    const run = runningRun();
    const events: unknown[] = [];
    const adapter = new PiEventAdapter({
      run,
      exposedToolNames: ["formal_test_tool"],
      eventFactory: new RuntimeEventFactory({ clock, eventIdFactory: () => "event:unknown" }),
      emit: (event) => {
        events.push(event);
      },
    });

    await adapter.observe({
      type: "tool_execution_start",
      toolCallId: "raw",
      toolName: "apply_brake",
      args: {},
    });

    expect(events).toMatchObject([
      { eventType: "tool.requested", metadata: { toolName: "unregistered_tool" } },
    ]);
  });

  it.each([false, true])("maps tool completion isError=%s", async (isError) => {
    const run = runningRun();
    const events: unknown[] = [];
    const adapter = new PiEventAdapter({
      run,
      exposedToolNames: ["formal_test_tool"],
      eventFactory: new RuntimeEventFactory({ clock, eventIdFactory: () => "event:complete" }),
      emit: (event) => {
        events.push(event);
      },
    });

    await adapter.observe({
      type: "tool_execution_start",
      toolCallId: "raw",
      toolName: "formal_test_tool",
      args: {},
    });
    events.length = 0;
    await adapter.observe({
      type: "tool_execution_end",
      toolCallId: "raw",
      toolName: "formal_test_tool",
      result: {},
      isError,
    });

    expect(events).toMatchObject([
      { eventType: "tool.completed", metadata: { toolName: "formal_test_tool", isError } },
    ]);
    expect(adapter.toolErrorCount).toBe(isError ? 1 : 0);
  });

  it("supports parallel Tool starts without illegal duplicate state transitions", async () => {
    const run = runningRun();
    const events: unknown[] = [];
    const adapter = new PiEventAdapter({
      run,
      exposedToolNames: ["formal_test_tool", "second_tool"],
      eventFactory: new RuntimeEventFactory({ clock, eventIdFactory: () => "event:parallel" }),
      emit: (event) => {
        events.push(event);
      },
    });

    for (const [toolCallId, toolName] of [
      ["one", "formal_test_tool"],
      ["two", "second_tool"],
    ] as const) {
      await adapter.observe({ type: "tool_execution_start", toolCallId, toolName, args: {} });
    }

    expect(run.status).toBe("TOOL_PROCESSING");
    expect(events).toHaveLength(2);
    expect(events).toMatchObject([
      { metadata: { toolCallId: "tool-call:1" } },
      { metadata: { toolCallId: "tool-call:2" } },
    ]);
  });

  it("starts the next provider model turn only after MODEL_RESUMED", async () => {
    const run = runningRun();
    const events: unknown[] = [];
    const adapter = new PiEventAdapter({
      run,
      exposedToolNames: ["formal_test_tool"],
      eventFactory: new RuntimeEventFactory({ clock, eventIdFactory: () => "event:model" }),
      emit: (event) => {
        events.push(event);
      },
    });
    await adapter.observe({
      type: "tool_execution_start",
      toolCallId: "one",
      toolName: "formal_test_tool",
      args: {},
    });
    await adapter.observe({
      type: "tool_execution_end",
      toolCallId: "one",
      toolName: "formal_test_tool",
      result: {},
      isError: false,
    });
    await adapter.observe({
      type: "turn_end",
      message: {} as never,
      toolResults: [{} as never],
    });
    await adapter.observe({ type: "turn_start" });

    expect(run.status).toBe("MODEL_RUNNING");
    expect(events).toMatchObject([
      { eventType: "tool.requested" },
      { eventType: "tool.completed" },
      { eventType: "model.resumed" },
      { eventType: "model.started" },
    ]);
  });

  it("rejects orphan and duplicate Tool lifecycle events", async () => {
    const run = runningRun();
    const adapter = new PiEventAdapter({
      run,
      exposedToolNames: ["formal_test_tool"],
      eventFactory: new RuntimeEventFactory({ clock, eventIdFactory: () => "event:strict" }),
      emit: () => undefined,
    });

    await expect(
      adapter.observe({
        type: "tool_execution_end",
        toolCallId: "orphan",
        toolName: "formal_test_tool",
        result: {},
        isError: false,
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await adapter.observe({
      type: "tool_execution_start",
      toolCallId: "one",
      toolName: "formal_test_tool",
      args: {},
    });
    await expect(
      adapter.observe({
        type: "tool_execution_start",
        toolCallId: "one",
        toolName: "formal_test_tool",
        args: {},
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(() => adapter.assertComplete()).toThrowError(
      expect.objectContaining({ code: "INTERNAL_ERROR" }),
    );
  });

  it("rejects Tool results reported outside Tool processing", async () => {
    const adapter = new PiEventAdapter({
      run: runningRun(),
      exposedToolNames: [],
      eventFactory: new RuntimeEventFactory({ clock, eventIdFactory: () => "event:bad-turn" }),
      emit: () => undefined,
    });

    await expect(
      adapter.observe({ type: "turn_end", message: {} as never, toolResults: [{} as never] }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it.each([
    ["RUN_CREATED", []],
    ["CONTEXT_LOADING", ["CONTEXT_LOADING"]],
    ["CAPABILITY_RESOLUTION", ["CONTEXT_LOADING", "CAPABILITY_RESOLUTION"]],
    [
      "TOOL_REQUESTED",
      ["CONTEXT_LOADING", "CAPABILITY_RESOLUTION", "MODEL_RUNNING", "TOOL_REQUESTED"],
    ],
    [
      "RUN_SUCCEEDED",
      ["CONTEXT_LOADING", "CAPABILITY_RESOLUTION", "MODEL_RUNNING", "RUN_SUCCEEDED"],
    ],
    ["RUN_FAILED", ["RUN_FAILED"]],
    ["RUN_CANCELLED", ["RUN_CANCELLED"]],
  ] as const)("rejects Tool start while AgentRun is %s", async (_status, transitions) => {
    const run = new AgentRun(
      {
        runId: `run:invalid-start:${_status}`,
        sessionId: "session:invalid-start",
        traceId: "trace:invalid-start",
        createdAt: "2026-08-27T08:00:00.000Z" as never,
      },
      clock,
    );
    for (const transition of transitions) run.transition(transition);
    const adapter = new PiEventAdapter({
      run,
      exposedToolNames: ["formal_test_tool"],
      eventFactory: new RuntimeEventFactory({ clock, eventIdFactory: () => "event:invalid-start" }),
      emit: () => undefined,
    });

    await expect(
      adapter.observe({
        type: "tool_execution_start",
        toolCallId: "invalid-state-call",
        toolName: "formal_test_tool",
        args: {},
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("rejects Tool name changes and duplicate completion", async () => {
    const run = runningRun();
    const adapter = new PiEventAdapter({
      run,
      exposedToolNames: ["formal_test_tool", "other_tool"],
      eventFactory: new RuntimeEventFactory({ clock, eventIdFactory: () => "event:strict-name" }),
      emit: () => undefined,
    });
    await adapter.observe({
      type: "tool_execution_start",
      toolCallId: "one",
      toolName: "formal_test_tool",
      args: {},
    });
    await expect(
      adapter.observe({
        type: "tool_execution_end",
        toolCallId: "one",
        toolName: "other_tool",
        result: {},
        isError: false,
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await adapter.observe({
      type: "tool_execution_end",
      toolCallId: "one",
      toolName: "formal_test_tool",
      result: {},
      isError: false,
    });
    await expect(
      adapter.observe({
        type: "tool_execution_end",
        toolCallId: "one",
        toolName: "formal_test_tool",
        result: {},
        isError: false,
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it.each(["agent_start", "agent_end", "message_start", "message_update", "message_end"] as const)(
    "does not leak raw Pi %s payloads into DriveGuard events",
    async (type) => {
      const run = runningRun();
      const events: unknown[] = [];
      const adapter = new PiEventAdapter({
        run,
        exposedToolNames: [],
        eventFactory: new RuntimeEventFactory({ clock, eventIdFactory: () => "event:ignored" }),
        emit: (event) => {
          events.push(event);
        },
      });

      await adapter.observe({ type, secret: "raw-secret" } as unknown as AgentEvent);

      expect(events).toEqual([]);
    },
  );
});

describe("Phase 5 RuntimeEvent model", () => {
  it("creates all required identity and timestamp fields", () => {
    const factory = new RuntimeEventFactory({ clock, eventIdFactory: () => "event:1" });
    const event = factory.create("agent.run.started", {
      runId: "run:1",
      sessionId: "session:1",
      traceId: "trace:1",
    });

    expect(event).toEqual({
      eventId: "event:1",
      eventType: "agent.run.started",
      runId: "run:1",
      sessionId: "session:1",
      traceId: "trace:1",
      timestamp: "2026-08-27T08:00:00.000Z",
    });
    expect(Object.isFrozen(event)).toBe(true);
  });

  it("freezes safe metadata and excludes unrequested fields", () => {
    const factory = new RuntimeEventFactory({ clock, eventIdFactory: () => "event:2" });
    const event = factory.create(
      "capabilities.resolved",
      { runId: "run:2", sessionId: "session:2", traceId: "trace:2" },
      { availableToolCount: 5, boundary: "PRE_POLICY" },
    );

    expect(event.metadata).toEqual({ availableToolCount: 5, boundary: "PRE_POLICY" });
    expect(Object.isFrozen(event.metadata)).toBe(true);
    expect(JSON.stringify(event)).not.toMatch(/authorization|api[_-]?key|reasoning/iu);
  });

  it("stores cloned event evidence in insertion order", () => {
    const sink = new InMemoryRuntimeEventSink();
    const factory = new RuntimeEventFactory({
      clock,
      eventIdFactory: (() => {
        let id = 0;
        return () => `event:${++id}`;
      })(),
    });
    const identity = { runId: "run:sink", sessionId: "session:sink", traceId: "trace:sink" };
    sink.emit(factory.create("agent.run.started", identity));
    sink.emit(factory.create("agent.run.completed", identity));

    expect(sink.slice().map((event) => event.eventId)).toEqual(["event:1", "event:2"]);
    expect(Object.isFrozen(sink.slice())).toBe(true);
    sink.clear();
    expect(sink.size).toBe(0);
  });

  it("deep-freezes stored event metadata against caller mutation", () => {
    const sink = new InMemoryRuntimeEventSink();
    const event = new RuntimeEventFactory({ clock, eventIdFactory: () => "event:frozen" }).create(
      "tool.requested",
      { runId: "run:frozen", sessionId: "session:frozen", traceId: "trace:frozen" },
      { toolName: "formal_test_tool" },
    );
    sink.emit(event);
    const stored = sink.slice()[0];

    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored?.metadata)).toBe(true);
    expect(Reflect.set(stored?.metadata ?? {}, "toolName", "tampered")).toBe(false);
    expect(sink.slice()[0]?.metadata?.toolName).toBe("formal_test_tool");
  });
});
