import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

const profile = process.env.PHASE14_PROFILE || "load";
const baseUrl = process.env.BASE_URL || "http://127.0.0.1:3000";
const workspaceRoot = resolve(process.env.PHASE14_WORKSPACE_ROOT || process.cwd());
const outputRoot = resolve(
  process.env.PHASE14_REPORT_ROOT || `14-load-resilience/reports/${profile}`,
);
const providerMode = process.env.PROVIDER_MODE || "faux";
const k6Binary = process.env.K6_BIN || "k6";
const isolationDuration = process.env.PHASE14_ISOLATION_DURATION || "10m";
const loadDuration = process.env.PHASE14_LOAD_DURATION || "5m";
const stressDuration = process.env.PHASE14_STRESS_DURATION || "2m";
const restartContainer = process.env.PHASE14_RESTART_CONTAINER_BETWEEN_CASES;
const quiet = process.env.PHASE14_QUIET === "1";
const isolationCases = new Set(
  (process.env.PHASE14_ISOLATION_CASES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

function virtualUsers(name, fallback) {
  const configured = (process.env[name] || "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  return configured.length === 0 ? fallback : configured;
}

const profiles = {
  baseline: [
    ["READ_ONLY", 1, "5m"],
    ["NO_TOOL", 1, "1m"],
    ["SIMPLE_TOOL", 1, "1m"],
    ["MULTI_TOOL", 1, "1m"],
    ["PROTECTED_ACTION", 1, "1m"],
  ],
  load: virtualUsers("PHASE14_LOAD_VUS", [1, 5, 10, 20, 50, 100, 200]).map((vus) => [
    "MIXED_WORKLOAD",
    vus,
    loadDuration,
  ]),
  stress: virtualUsers("PHASE14_STRESS_VUS", [250, 300, 400]).map((vus) => [
    "MIXED_WORKLOAD",
    vus,
    stressDuration,
  ]),
  soak: [["MIXED_WORKLOAD", 1, "30m"]],
  backpressure: [["MIXED_WORKLOAD", 200, "2m"]],
  isolation: [
    ["READ_ONLY", 1, isolationDuration, "per_vu", "backend-only"],
    ["NO_TOOL", 1, isolationDuration, "per_iteration", "no-tool-fresh-session"],
    ["NO_TOOL", 1, isolationDuration, "per_vu", "no-tool-same-session"],
    ["SIMPLE_TOOL", 1, isolationDuration, "per_iteration", "simple-tool-fresh-session"],
    ["SIMPLE_TOOL", 1, isolationDuration, "per_vu", "simple-tool-same-session"],
  ],
};

const selectedProfile = profiles[profile];
const selected =
  profile === "isolation" && isolationCases.size > 0
    ? selectedProfile?.filter((entry) => isolationCases.has(entry[4]))
    : selectedProfile;
if (!selected) {
  throw new Error(
    "PHASE14_PROFILE must be baseline, load, stress, soak, backpressure, or isolation",
  );
}
if (selected.length === 0) {
  throw new Error("PHASE14_ISOLATION_CASES did not match a known isolation case");
}
if (providerMode !== "faux" && selected.some((entry) => entry[1] > 5)) {
  throw new Error("Live providers are capped at 5 VUs; backend capacity tests require faux mode");
}

async function sampleMetrics(samples, label) {
  try {
    const response = await fetch(`${baseUrl}/metrics`, { signal: AbortSignal.timeout(2_000) });
    samples.push({
      label,
      sampledAt: new Date().toISOString(),
      status: response.status,
      text: await response.text(),
    });
  } catch (error) {
    samples.push({
      label,
      sampledAt: new Date().toISOString(),
      status: 0,
      error: error instanceof Error ? error.message : "metrics unavailable",
    });
  }
}

async function k6ScriptPath() {
  const source = resolve(workspaceRoot, "14-load-resilience/scripts/k6-load.js");
  if (process.platform !== "win32") return source;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "driveguard-phase14-k6-"));
  const destination = join(temporaryDirectory, "k6-load.js");
  await copyFile(source, destination);
  return destination;
}

function runK6(environment, scriptPath) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(k6Binary, ["run", scriptPath], {
      cwd: process.cwd(),
      env: { ...process.env, ...environment },
      stdio: quiet ? ["ignore", "ignore", "inherit"] : "inherit",
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => resolveRun({ code: code ?? 1, signal }));
  });
}

function runCommand(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: process.cwd(), stdio: "inherit" });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => resolveRun({ code: code ?? 1, signal }));
  });
}

async function prepareIsolatedCase() {
  if (restartContainer === undefined || restartContainer.length === 0) return;
  const restarted = await runCommand("docker", ["restart", restartContainer]);
  if (restarted.code !== 0) throw new Error(`Failed to restart ${restartContainer}`);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health/ready`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // The container is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`${restartContainer} did not become ready within 60 seconds`);
}

await mkdir(outputRoot, { recursive: true });
const scriptPath = await k6ScriptPath();
const matrix = [];
for (const [scenario, vus, duration, sessionMode = "per_vu", explicitName] of selected) {
  const name = explicitName ?? `${scenario.toLowerCase()}-vu${vus}`;
  const summaryPath = resolve(outputRoot, `${name}.json`);
  const resourcePath = resolve(outputRoot, `${name}-resources.json`);
  const samples = [];
  await prepareIsolatedCase();
  await sampleMetrics(samples, "start");
  const startedAt = new Date().toISOString();
  const run = runK6(
    {
      BASE_URL: baseUrl,
      SCENARIO: scenario,
      VUS: String(vus),
      DURATION: duration,
      SESSION_MODE: sessionMode,
      PROVIDER_MODE: providerMode,
      RUN_ID: `${Date.now()}:${name}`,
      K6_SUMMARY_PATH: summaryPath,
    },
    scriptPath,
  );
  const interval = setInterval(() => void sampleMetrics(samples, "middle"), 30_000);
  interval.unref?.();
  const outcome = await run;
  clearInterval(interval);
  await sampleMetrics(samples, "end");
  await writeFile(resourcePath, `${JSON.stringify(samples, null, 2)}\n`, "utf8");
  matrix.push({ scenario, vus, duration, startedAt, ...outcome, summaryPath, resourcePath });
  if (outcome.code !== 0) break;
}
const indexPath = resolve(outputRoot, "matrix-index.json");
await mkdir(dirname(indexPath), { recursive: true });
await writeFile(
  indexPath,
  `${JSON.stringify({ profile, providerMode, baseUrl, generatedAt: new Date().toISOString(), matrix }, null, 2)}\n`,
  "utf8",
);
if (matrix.some((entry) => entry.code !== 0)) process.exitCode = 1;
