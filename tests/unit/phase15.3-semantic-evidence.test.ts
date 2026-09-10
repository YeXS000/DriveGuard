import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeSemanticMismatchArtifact } from "../../evals/runner/semantic-mismatch-evidence.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Phase 15.3 semantic mismatch evidence", () => {
  it("persists one complete, independently recoverable synthetic mismatch artifact", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "driveguard-phase15.3-"));
    temporaryDirectories.push(outputDir);
    const written = await writeSemanticMismatchArtifact({
      outputDir,
      artifactId: "synthetic-negative-001",
      caseId: "NO_TOOL-synthetic",
      requestId: "request:synthetic",
      userId: "user:synthetic",
      sessionId: "session:synthetic",
      vehicleId: "vehicle:synthetic",
      input: { prompt: "No Tool request" },
      expectedContract: { tools: [] },
      actualToolCalls: [{ name: "get_vehicle_state", arguments: {} }],
      policyEvents: [{ toolName: "get_vehicle_state", decision: "ALLOW" }],
      confirmationEvents: [],
      contextRuntimeVersions: { contextVersion: 11, simulatorGeneration: 17 },
      executionReceipt: null,
      finalSimulatorBusinessState: { simulationVersion: 17, vehicle: { soc: 72 } },
      finalResponse: "The vehicle state is available.",
      scorerResult: { passed: false, reason: "UNNECESSARY_TOOL" },
      failureCategory: "UNNECESSARY_TOOL",
      timestamps: {
        observedAt: "2026-09-10T00:00:00.000Z",
        startedAt: "2026-09-10T00:00:00.000Z",
        completedAt: "2026-09-10T00:00:00.010Z",
      },
    });

    expect(written.path).toContain("mismatches/NO_TOOL-synthetic-synthetic-negative-001.json");
    await expect(readFile(written.path, "utf8")).resolves.toContain(
      '"failureCategory": "UNNECESSARY_TOOL"',
    );
    expect(written.artifact).toMatchObject({
      artifactVersion: 1,
      caseId: "NO_TOOL-synthetic",
      requestId: "request:synthetic",
      contextRuntimeVersions: { contextVersion: 11, simulatorGeneration: 17 },
      scorerResult: { passed: false, reason: "UNNECESSARY_TOOL" },
    });
  });

  it("refuses to overwrite a prior mismatch record", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "driveguard-phase15.3-"));
    temporaryDirectories.push(outputDir);
    const shared = {
      outputDir,
      artifactId: "immutable-artifact",
      caseId: "SIMPLE_TOOL-synthetic",
      userId: "user:synthetic",
      sessionId: "session:synthetic",
      vehicleId: "vehicle:synthetic",
      input: {},
      expectedContract: {},
      actualToolCalls: [],
      policyEvents: [],
      confirmationEvents: [],
      contextRuntimeVersions: {},
      executionReceipt: null,
      finalSimulatorBusinessState: {},
      finalResponse: "",
      scorerResult: {},
      failureCategory: "SYNTHETIC",
    } as const;

    await writeSemanticMismatchArtifact(shared);
    await expect(writeSemanticMismatchArtifact(shared)).rejects.toMatchObject({ code: "EEXIST" });
  });
});
