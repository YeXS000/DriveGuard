import { readFileSync } from "node:fs";

import {
  GoalToolRouter,
  ToolArgumentBinder,
  renderGoalBoundPrompt,
} from "@driveguard/agent-runtime";
import { FORMAL_TOOL_NAMES, type ToolDefinition } from "@driveguard/tools";
import { describe, expect, it } from "vitest";

import type { NativeEvalCase } from "../../evals/native/types.js";

const dataset = JSON.parse(
  readFileSync("evals/native/datasets/driveguard-eval-v1.json", "utf8"),
) as NativeEvalCase[];
const available = FORMAL_TOOL_NAMES.map((name) => ({ name }) as unknown as ToolDefinition);

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

describe("Phase 13.2 local planning latency", () => {
  it("measures 10,000 serial routing, prompt, and binding operations", () => {
    const router = new GoalToolRouter();
    const binder = new ToolArgumentBinder();
    const agentCases = dataset.filter((item) => item.urgentEvent === undefined);
    const durations: number[] = [];
    for (let index = 0; index < 10_000; index += 1) {
      const item = agentCases[index % agentCases.length]!;
      const started = performance.now();
      const plan = router.plan(item.userPrompt, available);
      renderGoalBoundPrompt(plan, item.userPrompt);
      for (const toolName of plan.candidateToolNames) {
        binder.bind(toolName, item.userPrompt, {});
      }
      durations.push(performance.now() - started);
    }
    const metrics = {
      operationCount: durations.length,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      p99Ms: percentile(durations, 0.99),
    };
    console.log(`PHASE13_2_LOCAL_LATENCY ${JSON.stringify(metrics)}`);
    expect(metrics.p95Ms).toBeLessThan(1);
    expect(metrics.p99Ms).toBeLessThan(2);
  });
});
