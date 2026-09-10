import {
  ACTION_LIFECYCLE_EVENT_TYPES,
  ACTION_STATES,
  DEFAULT_CONFIRMATION_TTL_MS,
  DEFAULT_EXECUTION_AUTHORIZATION_TTL_MS,
} from "@driveguard/action-lifecycle";
import { FORMAL_TOOL_NAMES } from "@driveguard/tools";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const lifecycleRoot = join(process.cwd(), "packages/action-lifecycle/src");
const runtimeRoot = join(process.cwd(), "packages/agent-runtime/src");

function source(root: string): string {
  return readdirSync(root)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => readFileSync(join(root, name), "utf8"))
    .join("\n");
}

describe("Phase 7 architecture and security boundary", () => {
  it("defines only the authorized Phase 7 states", () => {
    expect(ACTION_STATES).toEqual([
      "AWAITING_CONFIRMATION",
      "CONFIRMED",
      "READY_FOR_EXECUTION",
      "CANCELLED",
      "EXPIRED",
      "REPLAN_REQUIRED",
      "REJECTED",
    ]);
  });

  it("uses the authoritative 60-second confirmation TTL and short authorization TTL", () => {
    expect(DEFAULT_CONFIRMATION_TTL_MS).toBe(60_000);
    expect(DEFAULT_EXECUTION_AUTHORIZATION_TTL_MS).toBe(10_000);
  });

  it("does not expose confirmation as an LLM Tool", () => {
    expect(FORMAL_TOOL_NAMES).not.toContain("confirm");
    expect(FORMAL_TOOL_NAMES).not.toContain("confirm_action");
    expect(FORMAL_TOOL_NAMES).not.toContain("confirmation_service");
  });

  it("defines every required lifecycle event", () => {
    expect(ACTION_LIFECYCLE_EVENT_TYPES).toEqual([
      "action.pending.created",
      "confirmation.accepted",
      "confirmation.rejected",
      "confirmation.expired",
      "action.revalidation.started",
      "action.revalidation.failed",
      "action.ready_for_execution",
      "action.cancelled",
    ]);
  });

  it("contains no Phase 8 reliable execution, retry, circuit breaker, or persistence implementation", () => {
    const lifecycle = source(lifecycleRoot);
    expect(lifecycle).not.toMatch(
      /ReliableExecutor|CircuitBreaker|retryQueue|PostgreSQL|Redis|NATS/u,
    );
    expect(lifecycle).not.toMatch(/@driveguard\/(?:executor|persistence)/u);
  });

  it("uses no Date.now in action lifecycle core", () => {
    expect(source(lifecycleRoot)).not.toContain("Date.now(");
  });

  it("uses secure randomness for production token generation", () => {
    const service = readFileSync(join(lifecycleRoot, "service.ts"), "utf8");
    expect(service).toContain("randomBytes(32)");
    expect(service).toContain("tokenHash");
    expect(service).toContain("timingSafeEqual");
  });

  it("keeps confirmation out of Pi Tool definitions", () => {
    const runtime = source(runtimeRoot);
    expect(runtime).not.toMatch(/name:\s*["']confirm(?:_action)?["']/u);
  });

  it("keeps repository mutation capabilities package-internal", () => {
    const packageIndex = readFileSync(join(lifecycleRoot, "index.ts"), "utf8");
    expect(packageIndex).not.toContain('export * from "./repository.js"');
  });
});
