import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  EXECUTION_ERROR_CODES,
  EXECUTION_EVENT_TYPES,
  EXECUTION_STATES,
} from "@driveguard/executor";
import { FORBIDDEN_TOOL_NAMES } from "@driveguard/tools";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const source = (relative: string): string => readFileSync(`${root}/${relative}`, "utf8");

describe("Phase 8 architecture and security boundaries", () => {
  it("keeps the formal Runtime ALLOW and confirmed paths on ReliableToolExecutor", () => {
    const runtime = source("packages/agent-runtime/src/production-runtime.ts");
    expect(runtime).toContain("this.#reliableExecutor.execute");
    expect(runtime).toContain("allowedExecution:");
    expect(runtime).toContain("confirmAndExecute");
    expect(runtime).not.toContain("definition.execute(");
  });

  it("keeps Phase 1 fixture Runtime unchanged and outside Executor integration", () => {
    const phase1 = source("packages/agent-runtime/src/runtime.ts");
    expect(phase1).not.toMatch(/ReliableToolExecutor|@driveguard\/executor/u);
  });

  it("has no PostgreSQL, Redis, or NATS dependency in Executor", () => {
    const manifest = source("packages/executor/package.json");
    const executor = source("packages/executor/src/executor.ts");
    expect(`${manifest}\n${executor}`).not.toMatch(/postgres|\bpg\b|redis|nats/iu);
  });

  it("does not add persistence, messaging, HMI, or telemetry implementation to Executor", () => {
    const files = [
      "packages/executor/src/executor.ts",
      "packages/executor/src/idempotency.ts",
      "packages/executor/src/circuit-breaker.ts",
    ].map(source);
    expect(files.join("\n")).not.toMatch(
      /drizzle|database|jetstream|opentelemetry|prometheus|hmi/iu,
    );
  });

  it("retains all five RX names as defense-in-depth exclusions", () => {
    expect(FORBIDDEN_TOOL_NAMES).toEqual([
      "apply_brake",
      "control_steering",
      "set_throttle",
      "disable_aeb",
      "disable_esc",
    ]);
    expect(source("packages/executor/src/executor.ts")).toContain("forbiddenNames.has");
  });

  it("uses one formal Executor entry point", () => {
    const executor = source("packages/executor/src/executor.ts");
    expect(executor.match(/async execute\(/gu)).toHaveLength(1);
  });

  it("defines the closed independent execution lifecycle", () => {
    expect(EXECUTION_STATES).toEqual([
      "CREATED",
      "RUNNING",
      "SUCCEEDED",
      "FAILED",
      "RETRY_EXHAUSTED",
      "OUTCOME_UNKNOWN",
      "REJECTED",
    ]);
  });

  it("defines every required safe error code", () => {
    expect(EXECUTION_ERROR_CODES).toEqual(
      expect.arrayContaining([
        "EXECUTION_VALIDATION_ERROR",
        "EXECUTION_NOT_AUTHORIZED",
        "AUTHORIZATION_EXPIRED",
        "AUTHORIZATION_ALREADY_USED",
        "AUTHORIZATION_MISMATCH",
        "IDEMPOTENCY_CONFLICT",
        "DEPENDENCY_TIMEOUT",
        "DEPENDENCY_UNAVAILABLE",
        "CIRCUIT_OPEN",
        "RETRY_EXHAUSTED",
        "OUTCOME_UNKNOWN",
        "TOOL_EXECUTION_FAILED",
        "INTERNAL_EXECUTION_ERROR",
      ]),
    );
  });

  it("defines every required safe execution event", () => {
    expect(EXECUTION_EVENT_TYPES).toEqual(
      expect.arrayContaining([
        "execution.started",
        "execution.attempt.started",
        "execution.attempt.failed",
        "execution.retry.scheduled",
        "execution.deduplicated",
        "circuit.opened",
        "circuit.half_open",
        "circuit.closed",
        "authorization.consumed",
        "execution.succeeded",
        "execution.failed",
        "execution.outcome_unknown",
      ]),
    );
  });

  it("keeps secrets, arguments, tokens, and reasoning out of ExecutionEvent", () => {
    const events = source("packages/executor/src/events.ts");
    expect(events).not.toMatch(
      /validatedArguments|confirmationToken|authorizationToken|apiKey|reasoning/iu,
    );
  });

  it("implements process-local stores with key-scoped maps", () => {
    expect(source("packages/executor/src/idempotency.ts")).toContain("new Map<string");
    expect(source("packages/action-lifecycle/src/repository.ts")).toContain("#queues = new Map");
    expect(source("packages/executor/src/circuit-breaker.ts")).toContain("#circuits = new Map");
  });
});
