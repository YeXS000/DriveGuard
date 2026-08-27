import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { FixedClock } from "@driveguard/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentRuntimeError,
  createDeepSeekPhase5Selection,
  createLiveProductionDriveGuardRuntime,
  createProductionDriveGuardRuntime,
  DEFAULT_PHASE_5_CAPABILITIES,
  DEFAULT_PHASE_5_SERVICES,
  parsePhase5RuntimeMode,
  safeRuntimeError,
  sanitizeRuntimeText,
} from "../../packages/agent-runtime/src/index.js";
import { AgentSession, AgentSessionStore } from "../../packages/agent-runtime/src/session.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Phase 5 production factory configuration", () => {
  it.each([
    [undefined, "read_only"],
    ["read_only", "read_only"],
    ["development", "development"],
  ] as const)("parses PHASE_5_RUNTIME_MODE=%s as %s", (value, expected) => {
    expect(parsePhase5RuntimeMode(value)).toBe(expected);
  });

  it("rejects an unsupported runtime mode with CONFIGURATION_ERROR", () => {
    expect(() => parsePhase5RuntimeMode("production")).toThrowError(
      expect.objectContaining({ code: "CONFIGURATION_ERROR" }),
    );
  });

  it.each([
    [undefined, "deepseek-v4-flash"],
    ["deepseek-v4-flash", "deepseek-v4-flash"],
    ["deepseek-v4-pro", "deepseek-v4-pro"],
  ] as const)("selects installed DeepSeek model %s as %s", (requested, expected) => {
    const selection = createDeepSeekPhase5Selection(requested);

    expect(selection.providerId).toBe("deepseek");
    expect(selection.modelId).toBe(expected);
    expect(selection.api).toBe("openai-completions");
    expect(selection.models.getModels("deepseek").map((model) => model.id)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);
  });

  it("rejects a model absent from the installed Pi catalog", () => {
    try {
      createDeepSeekPhase5Selection("historical-model");
      throw new Error("Expected model selection to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentRuntimeError);
      expect(error).toMatchObject({ code: "CONFIGURATION_ERROR" });
      expect((error as Error).message).toContain("deepseek-v4-flash, deepseek-v4-pro");
    }
  });

  it.each([undefined, "", "   "])(
    "returns a structured configuration failure when DEEPSEEK_API_KEY=%s",
    (value) => {
      if (value === undefined) vi.stubEnv("DEEPSEEK_API_KEY", undefined);
      else vi.stubEnv("DEEPSEEK_API_KEY", value);

      expect(() => createLiveProductionDriveGuardRuntime()).toThrowError(
        expect.objectContaining({
          code: "CONFIGURATION_ERROR",
          message: "DEEPSEEK_API_KEY is required for the Phase 5 live DeepSeek runtime",
        }),
      );
    },
  );

  it("constructs the official read-only live runtime without sending a provider request", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "fake-test-only-key");
    vi.stubEnv("PHASE_5_RUNTIME_MODE", "read_only");

    const created = createLiveProductionDriveGuardRuntime("http://127.0.0.1:3001");

    expect(created.selection.modelId).toBe("deepseek-v4-flash");
    expect(created.runtime.mode).toBe("read_only");
    expect(created.runtime.sessionCount).toBe(0);
  });

  it("requires the literal NON_PRODUCTION development opt-in", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "fake-test-only-key");
    vi.stubEnv("PHASE_5_RUNTIME_MODE", "development");
    vi.stubEnv("PHASE_5_DEVELOPMENT_OPT_IN", "yes");

    try {
      createLiveProductionDriveGuardRuntime();
      throw new Error("Expected development factory to reject missing opt-in");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentRuntimeError);
      expect(error).toMatchObject({ code: "CONFIGURATION_ERROR" });
      expect((error as Error).message).toContain("NON_PRODUCTION opt-in");
    }
  });

  it("accepts the literal NON_PRODUCTION development opt-in without executing a Tool", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "fake-test-only-key");
    vi.stubEnv("PHASE_5_RUNTIME_MODE", "development");
    vi.stubEnv("PHASE_5_DEVELOPMENT_OPT_IN", "NON_PRODUCTION");

    expect(createLiveProductionDriveGuardRuntime().runtime.mode).toBe("development");
  });

  it("rejects a non-loopback Simulator origin for development side effects", () => {
    const faux = fauxProvider({ provider: "factory-loopback", api: "factory-loopback-api" });
    const models = createModels();
    models.setProvider(faux.provider);

    expect(() =>
      createProductionDriveGuardRuntime({
        model: faux.getModel(),
        streamFn: models.streamSimple.bind(models),
        simulatorBaseUrl: "https://simulator.example.test",
        capabilities: DEFAULT_PHASE_5_CAPABILITIES,
        serviceAvailability: DEFAULT_PHASE_5_SERVICES,
        mode: "development",
        developmentExecutionOptIn: true,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "CONFIGURATION_ERROR",
        message: "Development side-effect execution requires a loopback Simulator origin",
      }),
    );
  });
});

describe("Phase 5 structured runtime errors", () => {
  it("serializes only safe code, message and retryability", () => {
    const error = new AgentRuntimeError("MODEL_ERROR", "Provider failed", true);

    expect(error.toFailure()).toEqual({
      code: "MODEL_ERROR",
      message: "Provider failed",
      retryable: true,
    });
    expect(error.toJSON()).toEqual({ error: error.toFailure() });
    expect(JSON.stringify(error)).not.toContain("stack");
  });

  it.each([
    ["Authorization: Bearer top-secret", "[REDACTED]"],
    ["api_key=top-secret", "credential=[REDACTED]"],
    ["token: top-secret", "credential=[REDACTED]"],
    ["secret=top-secret", "credential=[REDACTED]"],
  ])("redacts credential pattern %s", (input, expected) => {
    expect(sanitizeRuntimeText(input, [])).toContain(expected);
    expect(sanitizeRuntimeText(input, [])).not.toContain("top-secret");
  });

  it("redacts every explicitly sensitive value including repeated occurrences", () => {
    expect(sanitizeRuntimeText("x raw-value y raw-value", ["raw-value", ""])).toBe(
      "x [REDACTED] y [REDACTED]",
    );
  });

  it("preserves structured error code and retryability while sanitizing", () => {
    const safe = safeRuntimeError(
      new AgentRuntimeError("TOOL_ERROR", "secret=raw-value", true),
      new AgentRuntimeError("INTERNAL_ERROR", "fallback"),
      ["raw-value"],
    );

    expect(safe).toMatchObject({ code: "TOOL_ERROR", retryable: true });
    expect(safe.message).not.toContain("raw-value");
  });

  it("replaces an unknown raw exception with the safe fallback", () => {
    const safe = safeRuntimeError(
      new Error("raw stack detail"),
      new AgentRuntimeError("INTERNAL_ERROR", "Safe fallback"),
      [],
    );

    expect(safe.toFailure()).toEqual({
      code: "INTERNAL_ERROR",
      message: "Safe fallback",
      retryable: false,
    });
    expect(safe.message).not.toContain("raw stack detail");
  });
});

describe("Phase 5 process-local AgentSession", () => {
  function session(id: string): AgentSession {
    const faux = fauxProvider({ provider: `session-${id}`, api: `session-api-${id}` });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("hello")]);
    return new AgentSession({
      sessionId: id,
      model: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
      clock: new FixedClock(Date.parse("2026-08-27T08:00:00.000Z")),
    });
  }

  it("getOrCreate is stable and snapshots are sorted by sessionId", () => {
    const store = new AgentSessionStore(session);
    const beta = store.getOrCreate("beta");
    const alpha = store.getOrCreate("alpha");

    expect(store.getOrCreate("beta")).toBe(beta);
    expect(store.get("alpha")).toBe(alpha);
    expect(store.snapshots().map((snapshot) => snapshot.sessionId)).toEqual(["alpha", "beta"]);
    expect(Object.isFrozen(store.snapshots())).toBe(true);
  });
});
