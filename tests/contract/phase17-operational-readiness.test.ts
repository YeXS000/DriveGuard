import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { DriveGuardMetrics } from "@driveguard/observability";
import { describe, expect, it } from "vitest";

const root = process.cwd();

interface ReleaseReadinessChecklist {
  readonly release: { readonly images: readonly string[] };
  readonly checks: { readonly rollback: string };
}

async function source(path: string): Promise<string> {
  return readFile(resolve(root, path), "utf8");
}

describe("Phase 17 operational readiness contracts", () => {
  it("uses SHA-tagged release images and loads alert rules into Prometheus", async () => {
    const [compose, prometheus, manifest] = await Promise.all([
      source("docker-compose.yml"),
      source("infra/observability/prometheus.yml"),
      source("scripts/release-manifest.mjs"),
    ]);
    for (const image of ["driveguard-api", "driveguard-simulator", "driveguard-hmi"]) {
      expect(compose).toContain(`image: ${image}:\${DRIVEGUARD_IMAGE_TAG:-dev}`);
      expect(manifest).toContain(`"${image}"`);
    }
    expect(manifest).toContain("full 40-character Git SHA");
    expect(manifest).toContain("DRIVEGUARD_CAPTURE_IMAGE_DIGESTS");
    expect(await source("scripts/staging-operations.mjs")).toContain(
      "set the Windows-host DRIVEGUARD_IMAGE_TAG",
    );
    expect(await source("scripts/staging-operations.mjs")).toContain(
      '"ps", "--all", "--format", "json"',
    );
    expect(await source("tests/smoke/phase10-docker-smoke.mjs")).toContain(
      "DRIVEGUARD_DOCKER_COMMAND",
    );
    expect(prometheus).toContain("/etc/prometheus/alerts/driveguard.yml");
  });

  it("defines required low-cardinality operational and safety alerts", async () => {
    const alerts = await source("infra/observability/alerts/driveguard.yml");
    for (const alert of [
      "DriveGuardApiUnavailable",
      "DriveGuardUnexpectedHttp5xx",
      "DriveGuardApiP95LatencyHigh",
      "DriveGuardApiRestarted",
      "DriveGuardDependencyUnavailable",
      "DriveGuardQueueSaturation",
      "DriveGuardDatabasePoolSaturation",
      "DriveGuardNatsBacklog",
      "DriveGuardConfirmationBypass",
      "DriveGuardForbiddenActionExecuted",
      "DriveGuardDuplicateSideEffect",
    ]) {
      expect(alerts).toContain(`alert: ${alert}`);
    }
    expect(alerts).toContain('route!~"^/health/.*"');
    expect(alerts).toContain('status_code!="503"');
    expect(alerts).toContain("driveguard_admission_queued >= 26");
    expect(alerts).toContain("for: 30s");
    expect(alerts).not.toMatch(/sessionId|requestId|traceId/u);
  });

  it("exports synthetic-safe hard-failure signals without identity labels", async () => {
    const metrics = new DriveGuardMetrics({ collectProcessMetrics: false });
    metrics.observeSafetyHardFailure("confirmation_bypass");
    const text = await metrics.metrics();
    expect(text).toContain("# HELP driveguard_safety_hard_failures_total");
    expect(text).toContain('driveguard_safety_hard_failures_total{event="confirmation_bypass"} 1');
    expect(text).toContain(
      'driveguard_safety_hard_failures_total{event="forbidden_action_executed"} 0',
    );
    expect(text).not.toMatch(/sessionId=|requestId=|traceId=/u);
  });

  it("provides guarded executable lifecycle commands and a structured checklist", async () => {
    const output = execFileSync("node", ["scripts/staging-operations.mjs", "--help"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(output).toContain("fresh-deploy requires DRIVEGUARD_ALLOW_CLEAN_RESET=1");
    const checklist = JSON.parse(
      await source("infra/operations/release-readiness-checklist.json"),
    ) as ReleaseReadinessChecklist;
    expect(checklist.release.images).toEqual([
      "driveguard-api:REQUIRED_FULL_GIT_SHA",
      "driveguard-simulator:REQUIRED_FULL_GIT_SHA",
      "driveguard-hmi:REQUIRED_FULL_GIT_SHA",
    ]);
    expect(checklist.checks.rollback).toBe("NOT_RUN");
  });
});
