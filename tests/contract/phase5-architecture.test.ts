import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { FORMAL_TOOL_NAMES, FORBIDDEN_TOOL_NAMES } from "@driveguard/tools";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const runtimeSourceRoot = fileURLToPath(
  new URL("../../packages/agent-runtime/src/", import.meta.url),
);

function source(name: string): string {
  return readFileSync(`${runtimeSourceRoot}/${name}`, "utf8");
}

const productionModules = [
  "agent-run.ts",
  "context-loader.ts",
  "pi-event-adapter.ts",
  "pi-tool-adapter.ts",
  "production-factory.ts",
  "production-runtime.ts",
  "runtime-errors.ts",
  "runtime-events.ts",
  "session.ts",
] as const;

describe("Phase 5 architecture and security boundaries", () => {
  it("uses the Phase 4 formal ToolRegistry as the production Tool source", () => {
    const runtime = source("production-runtime.ts");
    const factory = source("production-factory.ts");

    expect(runtime).toContain("type ToolRegistry");
    expect(runtime).toContain("this.#toolRegistry.resolve");
    expect(factory).toContain("createDriveGuardToolRegistry");
  });

  it("uses Phase 2 ContextSnapshotBuilder and ContextFreshnessEvaluator", () => {
    const loader = source("context-loader.ts");
    const factory = source("production-factory.ts");

    expect(loader).toContain("ContextSnapshotBuilder");
    expect(loader).toContain("ContextFreshnessEvaluator");
    expect(loader).toContain("ContextSnapshot");
    expect(factory).toContain("ContextVersionAllocator");
  });

  it("keeps the formal Tool source count at exactly 14", () => {
    expect(FORMAL_TOOL_NAMES).toHaveLength(14);
    expect(new Set(FORMAL_TOOL_NAMES).size).toBe(14);
  });

  it("keeps RX exposure at zero formal definitions", () => {
    expect(FORMAL_TOOL_NAMES).not.toEqual(expect.arrayContaining([...FORBIDDEN_TOOL_NAMES]));
    expect(FORBIDDEN_TOOL_NAMES).toHaveLength(5);
  });

  it("keeps the Phase 1 fixture runtime isolated from Phase 4 packages", () => {
    const phase1Runtime = source("runtime.ts");
    const phase1Tools = source("phase1-tools.ts");

    expect(phase1Tools).toContain("PHASE_1_FIXTURE_ONLY");
    expect(phase1Runtime).not.toMatch(/@driveguard\/(?:tools|capabilities|context)/u);
    expect(phase1Runtime).not.toContain("DriveGuardAgentRuntime");
  });

  it("does not import Policy, Executor, Persistence, Confirmation, or Action State Machine", () => {
    const combined = productionModules.map(source).join("\n");

    expect(combined).not.toMatch(
      /@driveguard\/(?:policy|executor|persistence)|from\s+["'][^"']*(?:confirmation|action-state)/u,
    );
  });

  it("does not add Phase 6 policy decision or confirmation error codes", () => {
    const errors = source("runtime-errors.ts");

    expect(errors).not.toMatch(
      /POLICY_DENIED|CONFIRMATION_REQUIRED|REQUIRE_CONFIRMATION|\bALLOW\b|\bDENY\b|\bREPLAN\b/u,
    );
  });

  it("centralizes production HTTP transport outside the Agent Runtime core", () => {
    for (const name of productionModules) {
      expect(source(name), name).not.toMatch(/\bfetch\s*\(/u);
    }
    expect(source("phase5-live-smoke.ts")).toContain("fetch(");
  });

  it("does not reference the forbidden credential file from runtime source", () => {
    const combined = readdirSync(runtimeSourceRoot)
      .filter((name) => name.endsWith(".ts"))
      .map(source)
      .join("\n");

    expect(combined).not.toContain("api_key.md");
  });

  it("does not introduce policy/executor/persistence implementation files", () => {
    for (const packageName of ["policy", "executor", "persistence"] as const) {
      const packageRoot = `${repositoryRoot}/packages/${packageName}`;
      const files = readdirSync(packageRoot, { recursive: true }).map(String);
      expect(files.filter((name) => name.endsWith(".ts"))).toEqual([]);
    }
  });

  it("keeps event metadata free of prompt, message, arguments, result, and reasoning fields", () => {
    const events = source("runtime-events.ts");
    const metadataBlock = events.slice(
      events.indexOf("export interface RuntimeEventMetadata"),
      events.indexOf("export interface RuntimeEvent {"),
    );

    expect(metadataBlock).not.toMatch(
      /prompt|message|arguments|result|reasoning|authorization|secret/iu,
    );
  });

  it("labels every Phase 5 Tool result NON_PRODUCTION and PRE_POLICY", () => {
    const adapter = source("pi-tool-adapter.ts");

    expect(adapter).toContain('productionSafety: "NON_PRODUCTION"');
    expect(adapter).toContain('safetyBoundary: "PRE_POLICY"');
    expect(adapter).toContain("not production-safe for side-effect tools");
  });

  it("does not publicly export mutable Pi sessions or the generic runtime constructor", () => {
    const index = source("index.ts");

    expect(index).not.toContain('export * from "./session.js"');
    expect(index).not.toContain('export * from "./production-runtime.js"');
    expect(index).not.toContain("DriveGuardAgentRuntime");
  });
});
