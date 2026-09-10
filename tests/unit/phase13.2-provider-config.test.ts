import { createDeepSeekPhase5Selection } from "@driveguard/agent-runtime";
import { describe, expect, it } from "vitest";

import { classifyLiveModelFailure } from "../../evals/runner/live-provider.js";

describe("Phase 13.2 DeepSeek endpoint configuration", () => {
  it("overrides the installed model base URL without changing its provider contract", () => {
    const selection = createDeepSeekPhase5Selection(
      "deepseek-v4-flash",
      "https://gateway.example.test/v1/",
    );
    expect(selection.model).toMatchObject({
      id: "deepseek-v4-flash",
      provider: "deepseek",
      api: "openai-completions",
      baseUrl: "https://gateway.example.test/v1",
    });
  });

  it.each([
    "not-a-url",
    "http://gateway.example.test/v1",
    "https://user:password@gateway.example.test/v1",
    "https://gateway.example.test/v1?token=secret",
  ])("rejects unsafe custom base URL %s", (baseUrl) => {
    expect(() => createDeepSeekPhase5Selection("deepseek-v4-flash", baseUrl)).toThrowError(
      expect.objectContaining({ code: "CONFIGURATION_ERROR" }),
    );
  });

  it.each([
    "400: credit insufficient balance: balance=0; code=insufficient_user_quota",
    "429 status code (no body)",
    "503 upstream unavailable",
    "network connection aborted",
  ])("classifies provider availability failure as infrastructure: %s", (message) => {
    expect(
      classifyLiveModelFailure({ code: "MODEL_ERROR", message, retryable: true }),
    ).toMatchObject({ validity: "INFRA_FAILURE", infrastructureError: message });
  });

  it("classifies a non-availability model transport contract error as evaluator failure", () => {
    expect(
      classifyLiveModelFailure({
        code: "MODEL_ERROR",
        message: "400 invalid tool schema",
        retryable: false,
      }),
    ).toMatchObject({ validity: "EVALUATOR_FAILURE" });
  });

  it("does not reclassify an Agent Tool failure as provider infrastructure", () => {
    expect(
      classifyLiveModelFailure({ code: "TOOL_ERROR", message: "tool failed", retryable: false }),
    ).toEqual({ validity: "VALID" });
  });
});
