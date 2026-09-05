import { readFileSync } from "node:fs";

import { GoalToolRouter, renderGoalBoundPrompt } from "@driveguard/agent-runtime";
import { FORMAL_TOOL_NAMES, type ToolDefinition } from "@driveguard/tools";
import { describe, expect, it } from "vitest";

import type { NativeEvalCase } from "../../evals/native/types.js";

const dataset = JSON.parse(
  readFileSync("evals/native/datasets/driveguard-eval-v1.json", "utf8"),
) as NativeEvalCase[];
const available = FORMAL_TOOL_NAMES.map((name) => ({ name }) as unknown as ToolDefinition);

describe("Phase 13.2 goal-based Tool routing", () => {
  it("shortlists exactly the required goal Tools across the frozen 600-case corpus", () => {
    const router = new GoalToolRouter();
    const agentCases = dataset.filter((item) => item.urgentEvent === undefined);
    const failures: { caseId: string; expected: readonly string[]; actual: readonly string[] }[] =
      [];
    let required = 0;
    let recalled = 0;
    let predicted = 0;
    let correct = 0;
    for (const item of agentCases) {
      const plan = router.plan(item.userPrompt, available);
      const expected = [...item.expectedTools.required].sort();
      const actual: string[] = [...plan.candidateToolNames].sort();
      required += expected.length;
      recalled += expected.filter((name) => actual.includes(name)).length;
      predicted += actual.length;
      correct += actual.filter((name) => expected.includes(name)).length;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures.push({ caseId: item.caseId, expected, actual });
      }
    }
    const metrics = {
      frozenCases: dataset.length,
      agentRuntimeCases: agentCases.length,
      urgentProcessorCases: dataset.length - agentCases.length,
      exactPlans: agentCases.length - failures.length,
      exactPlanRate: (agentCases.length - failures.length) / agentCases.length,
      toolRecall: required === 0 ? 1 : recalled / required,
      toolPrecision: predicted === 0 ? 1 : correct / predicted,
      failures: failures.slice(0, 10),
    };
    console.log(`PHASE13_2_ROUTING_METRICS ${JSON.stringify(metrics)}`);
    expect(failures).toEqual([]);
  });

  it("fails open to the capability-resolved set for genuinely ambiguous requests", () => {
    const plan = new GoalToolRouter().plan("帮我处理一下", available);
    expect(plan.intentClass).toBe("AMBIGUOUS");
    expect(plan.candidateToolNames).toHaveLength(FORMAL_TOOL_NAMES.length);
  });

  it("never exposes an RX actuator for explicit direct-control requests", () => {
    const plan = new GoalToolRouter().plan("立即替我踩下刹车", available);
    expect(plan).toMatchObject({ intentClass: "NO_TOOL", candidateToolNames: [] });
  });

  it("does not substitute unrelated reads when a write is unavailable in read-only mode", () => {
    const reads = available.filter((definition) => definition.name.startsWith("get_"));
    const plan = new GoalToolRouter().plan("把导航目的地设置为浦东机场", reads);
    expect(plan).toMatchObject({
      intentClass: "WRITE",
      candidateToolNames: [],
      stopCondition: "CAPABILITY_UNAVAILABLE",
    });
  });

  it("binds shortlisted goals to exactly-once calls and terminal policy outcomes", () => {
    const plan = new GoalToolRouter().plan("把导航目的地设置为浦东机场", available);
    const prompt = renderGoalBoundPrompt(plan, "把导航目的地设置为浦东机场");

    expect(prompt).toContain("MUST call every tool in this trusted shortlist exactly once");
    expect(prompt).toContain("Never retry or duplicate a tool call");
    expect(prompt).toContain("confirmation requirement, stop calling tools immediately");
    expect(prompt).toContain("do not ask for confirmation orally");
  });
});
