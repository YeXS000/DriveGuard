import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDeepSeekPhase1Selection,
  createLivePhase1Runtime,
  Phase1ConfigurationError,
  Phase1ToolInstrumentation,
} from "../../packages/agent-runtime/src/index.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Phase 1 runtime configuration", () => {
  it("uses the official DeepSeek provider and current preferred catalog model", () => {
    const selection = createDeepSeekPhase1Selection(undefined);

    expect(selection.providerId).toBe("deepseek");
    expect(selection.modelId).toBe("deepseek-v4-flash");
    expect(selection.api).toBe("openai-completions");
    expect(selection.models.getModels("deepseek").map((model) => model.id)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);
  });

  it("rejects a model ID that is absent from the installed Pi catalog", () => {
    expect(() => createDeepSeekPhase1Selection("historical-or-unknown-model")).toThrow(
      Phase1ConfigurationError,
    );
  });

  it("returns a structured safe configuration error when the API key is absent", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");

    try {
      createLivePhase1Runtime();
      throw new Error("Expected createLivePhase1Runtime to reject missing configuration");
    } catch (error) {
      expect(error).toBeInstanceOf(Phase1ConfigurationError);
      expect(JSON.stringify(error)).toBe(
        '{"code":"PHASE1_CONFIGURATION_ERROR","variable":"DEEPSEEK_API_KEY","message":"DEEPSEEK_API_KEY is required for the Phase 1 live DeepSeek runtime"}',
      );
    }
  });

  it("blocks an out-of-scope name in the temporary allow-list instrumentation", async () => {
    const instrumentation = new Phase1ToolInstrumentation();
    const assistantMessage = fauxAssistantMessage(fauxToolCall("not_allowed", {}), {
      stopReason: "toolUse",
    });
    const toolCall = assistantMessage.content[0];
    if (toolCall?.type !== "toolCall") {
      throw new Error("Faux tool call was not created");
    }

    const result = await instrumentation.beforeToolCall({
      assistantMessage,
      toolCall,
      args: {},
      context: { systemPrompt: "", messages: [], tools: [] },
    });

    expect(result).toEqual({
      block: true,
      reason: "Tool is outside the Phase 1 read-only allow-list",
      terminate: true,
    });
    expect(instrumentation.slice()).toEqual([
      { stage: "beforeToolCall", toolName: "not_allowed", allowed: false },
    ]);
  });
});
