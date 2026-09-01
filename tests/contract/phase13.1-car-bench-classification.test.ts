import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const modulePath = resolve(process.cwd(), "evals/external/car-bench/classification.py");

function classify(reward: number, info: unknown): string {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("runner", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(module.classify_trial_payload(float(sys.argv[2]), json.loads(sys.argv[3])))
`;
  return execFileSync("python3", ["-c", script, modulePath, String(reward), JSON.stringify(info)], {
    encoding: "utf8",
  }).trim();
}

describe("Phase 13.1 CAR-bench validity taxonomy", () => {
  it("keeps official successes VALID", () => {
    expect(classify(1, {})).toBe("VALID");
  });

  it("classifies ordinary official reward failures as AGENT_FAILURE", () => {
    expect(classify(0, { reward_info: { info: { policy_llm_errors: ["missed rule"] } } })).toBe(
      "AGENT_FAILURE",
    );
  });

  it("classifies bridge timeout and official simulator crashes as INFRA_FAILURE", () => {
    expect(classify(0, { error: "DriveGuard Pi bridge timed out after 120 seconds" })).toBe(
      "INFRA_FAILURE",
    );
    expect(classify(0, { error: "official user simulator crash" })).toBe("INFRA_FAILURE");
  });

  it("classifies explicit evaluator failures separately", () => {
    expect(classify(0, { error: "official evaluator crashed" })).toBe("EVALUATOR_FAILURE");
  });
});
