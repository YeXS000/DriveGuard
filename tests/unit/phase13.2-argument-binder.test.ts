import { readFileSync } from "node:fs";

import { ToolArgumentBinder } from "@driveguard/agent-runtime";
import type { FormalToolName } from "@driveguard/tools";
import { describe, expect, it } from "vitest";

import type { NativeEvalCase } from "../../evals/native/types.js";

const dataset = JSON.parse(
  readFileSync("evals/native/datasets/driveguard-eval-v1.json", "utf8"),
) as NativeEvalCase[];

describe("Phase 13.2 explicit argument binding", () => {
  it("binds every explicit Agent Runtime argument in the frozen corpus", () => {
    const binder = new ToolArgumentBinder();
    let checked = 0;
    const failures: { caseId: string; toolName: string; expected: unknown; actual: unknown }[] = [];
    for (const item of dataset.filter((candidate) => candidate.urgentEvent === undefined)) {
      for (const toolName of item.expectedTools.required) {
        checked += 1;
        const expected = item.expectedArguments[toolName] ?? {};
        const actual = binder.bind(toolName as FormalToolName, item.userPrompt, {
          hallucinated: true,
        });
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          failures.push({ caseId: item.caseId, toolName, expected, actual });
        }
      }
    }
    const metrics = {
      checked,
      valid: checked - failures.length,
      argumentValidity: checked === 0 ? 1 : (checked - failures.length) / checked,
      failures: failures.slice(0, 10),
    };
    console.log(`PHASE13_2_ARGUMENT_METRICS ${JSON.stringify(metrics)}`);
    expect(failures).toEqual([]);
  });

  it("does not invent a protected argument when the user did not supply one", () => {
    const proposed = { stationId: "station-user-selected-009" };
    expect(new ToolArgumentBinder().bind("reserve_charging_slot", "帮我预约", proposed)).toEqual(
      proposed,
    );
  });
});
