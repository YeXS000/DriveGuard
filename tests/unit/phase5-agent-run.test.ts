import { FixedClock } from "@driveguard/shared";
import { describe, expect, it } from "vitest";

import {
  AGENT_RUN_STATUSES,
  AgentRun,
  legalAgentRunTransitions,
  type AgentRunStatus,
} from "../../packages/agent-runtime/src/index.js";

const clock = new FixedClock(Date.parse("2026-08-27T08:00:00.000Z"));

const paths: Readonly<Record<AgentRunStatus, readonly AgentRunStatus[]>> = {
  RUN_CREATED: [],
  CONTEXT_LOADING: ["CONTEXT_LOADING"],
  CAPABILITY_RESOLUTION: ["CONTEXT_LOADING", "CAPABILITY_RESOLUTION"],
  MODEL_RUNNING: ["CONTEXT_LOADING", "CAPABILITY_RESOLUTION", "MODEL_RUNNING"],
  TOOL_REQUESTED: ["CONTEXT_LOADING", "CAPABILITY_RESOLUTION", "MODEL_RUNNING", "TOOL_REQUESTED"],
  TOOL_PROCESSING: [
    "CONTEXT_LOADING",
    "CAPABILITY_RESOLUTION",
    "MODEL_RUNNING",
    "TOOL_REQUESTED",
    "TOOL_PROCESSING",
  ],
  MODEL_RESUMED: [
    "CONTEXT_LOADING",
    "CAPABILITY_RESOLUTION",
    "MODEL_RUNNING",
    "TOOL_REQUESTED",
    "TOOL_PROCESSING",
    "MODEL_RESUMED",
  ],
  RUN_SUCCEEDED: ["CONTEXT_LOADING", "CAPABILITY_RESOLUTION", "MODEL_RUNNING", "RUN_SUCCEEDED"],
  RUN_FAILED: ["RUN_FAILED"],
  RUN_CANCELLED: ["RUN_CANCELLED"],
};

function makeRun(suffix: string): AgentRun {
  return new AgentRun(
    {
      runId: `run:${suffix}`,
      sessionId: "session:phase5",
      traceId: `trace:${suffix}`,
      createdAt: "2026-08-27T08:00:00.000Z" as never,
    },
    clock,
  );
}

function atStatus(status: AgentRunStatus, suffix: string): AgentRun {
  const run = makeRun(suffix);
  for (const transition of paths[status]) run.transition(transition);
  return run;
}

const transitionMatrix = AGENT_RUN_STATUSES.flatMap((from) =>
  AGENT_RUN_STATUSES.map((to) => ({
    from,
    to,
    legal: legalAgentRunTransitions()[from].includes(to),
  })),
);

describe("Phase 5 AgentRun state machine", () => {
  it.each(transitionMatrix)("enforces $from -> $to as legal=$legal", ({ from, to, legal }) => {
    const run = atStatus(from, `${from}:${to}`);

    expect(run.canTransition(to)).toBe(legal);
    if (legal) {
      run.transition(to);
      expect(run.status).toBe(to);
    } else {
      expect(() => run.transition(to)).toThrow(`Illegal AgentRun transition: ${from} -> ${to}`);
      expect(run.status).toBe(from);
    }
  });

  it("creates immutable identity and a complete initial snapshot", () => {
    const run = makeRun("identity");

    expect(run.snapshot()).toEqual({
      runId: "run:identity",
      sessionId: "session:phase5",
      traceId: "trace:identity",
      createdAt: "2026-08-27T08:00:00.000Z",
      status: "RUN_CREATED",
      statusHistory: ["RUN_CREATED"],
    });
    expect(Object.isFrozen(run.snapshot())).toBe(true);
    expect(Object.isFrozen(run.snapshot().statusHistory)).toBe(true);
  });

  it("attaches one context snapshot and rejects replacement", () => {
    const run = makeRun("context");
    run.attachContext("phase5-context:1" as never);
    run.attachContext("phase5-context:1" as never);

    expect(run.contextSnapshotId).toBe("phase5-context:1");
    expect(() => run.attachContext("phase5-context:2" as never)).toThrow(
      "AgentRun context snapshot is immutable",
    );
  });

  it.each(["RUN_SUCCEEDED", "RUN_FAILED", "RUN_CANCELLED"] as const)(
    "marks %s terminal",
    (status) => {
      expect(atStatus(status, `terminal:${status}`).isTerminal).toBe(true);
    },
  );

  it.each(AGENT_RUN_STATUSES.filter((status) => !status.startsWith("RUN_")))(
    "does not mark %s terminal",
    (status) => {
      expect(atStatus(status, `nonterminal:${status}`).isTerminal).toBe(false);
    },
  );

  it("records repeated model cycles without losing the lifecycle history", () => {
    const run = atStatus("MODEL_RESUMED", "cycle");
    run.transition("MODEL_RUNNING");
    run.transition("RUN_SUCCEEDED");

    expect(run.snapshot().statusHistory).toEqual([
      "RUN_CREATED",
      "CONTEXT_LOADING",
      "CAPABILITY_RESOLUTION",
      "MODEL_RUNNING",
      "TOOL_REQUESTED",
      "TOOL_PROCESSING",
      "MODEL_RESUMED",
      "MODEL_RUNNING",
      "RUN_SUCCEEDED",
    ]);
  });
});
