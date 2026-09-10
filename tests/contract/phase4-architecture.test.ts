import { FORBIDDEN_TOOL_NAMES, FORMAL_TOOL_NAMES } from "@driveguard/tools";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createPhase1Tools,
  PHASE_1_FIXTURE_ONLY,
} from "../../packages/agent-runtime/src/phase1-tools.js";

import { FULL_CAPABILITY_CONTEXT, createOfflineRegistry } from "../fixtures/phase4-tools.js";

const agentRuntimeFiles = [
  "packages/agent-runtime/src/event-collector.ts",
  "packages/agent-runtime/src/index.ts",
  "packages/agent-runtime/src/instrumentation.ts",
  "packages/agent-runtime/src/live-smoke.ts",
  "packages/agent-runtime/src/phase1-tools.ts",
  "packages/agent-runtime/src/runtime.ts",
];

const phase4Files = [
  "packages/capabilities/src/model.ts",
  "packages/capabilities/src/resolver.ts",
  "packages/tools/src/contracts.ts",
  "packages/tools/src/definitions.ts",
  "packages/tools/src/factory.ts",
  "packages/tools/src/providers.ts",
  "packages/tools/src/registry.ts",
  "packages/tools/src/schemas.ts",
  "packages/tools/src/simulator-client.ts",
];

function contents(files: readonly string[]): string {
  return files.map((file) => readFileSync(file, "utf8")).join("\n");
}

describe("Phase 4 architecture and security boundaries", () => {
  it("retains exactly two isolated Phase 1 fixture tools", () => {
    const tools = createPhase1Tools();
    expect(tools).toHaveLength(2);
    expect(tools.map((tool) => tool.name)).toEqual(["get_vehicle_state", "get_trip_state"]);
    expect(PHASE_1_FIXTURE_ONLY).toBe("PHASE_1_FIXTURE_ONLY");
  });

  it("keeps Phase 1 runtime disconnected from Phase 4 packages", () => {
    expect(contents(agentRuntimeFiles)).not.toMatch(/@driveguard\/(?:capabilities|tools)/u);
  });

  it("has exactly 14 formal definitions and zero RX exposure", () => {
    const resolved = createOfflineRegistry().resolve(FULL_CAPABILITY_CONTEXT);
    expect(resolved).toHaveLength(14);
    expect(new Set(resolved.map((tool) => tool.name))).toEqual(new Set(FORMAL_TOOL_NAMES));
    expect(resolved.filter((tool) => FORBIDDEN_TOOL_NAMES.includes(tool.name as never))).toEqual(
      [],
    );
  });

  it("does not import Policy, Executor, Confirmation, or Agent Runtime from Phase 4", () => {
    expect(contents(phase4Files)).not.toMatch(
      /@driveguard\/(?:policy|executor|agent-runtime)|from ["'][^"']*(?:confirmation|state-machine)/u,
    );
  });

  it("contains no Phase 6/7 authorization decisions", () => {
    expect(contents(phase4Files)).not.toMatch(
      /REQUIRE_CONFIRMATION|POLICY_DENIED|\bALLOW\b|\bREPLAN\b/u,
    );
  });

  it("keeps capabilities dependent only on domain and TypeBox", () => {
    const manifest = JSON.parse(readFileSync("packages/capabilities/package.json", "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["@driveguard/domain", "typebox"]);
  });

  it("keeps tools free of policy and executor dependencies", () => {
    const manifest = JSON.parse(readFileSync("packages/tools/package.json", "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      "@driveguard/capabilities",
      "@driveguard/domain",
      "typebox",
    ]);
  });

  it("tracks no secret or build artifact", () => {
    const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
    expect(
      tracked.filter(
        (path) =>
          /(?:^|\/)api[_-]?key\.md$/iu.test(path) ||
          (/(?:^|\/)\.env(?:\.|$)/u.test(path) && !path.endsWith(".env.example")),
      ),
    ).toEqual([]);
    expect(
      tracked.filter((path) => /(?:^|\/)(?:dist|coverage|node_modules)\//u.test(path)),
    ).toEqual([]);
  });
});
