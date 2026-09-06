import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

const profile = process.env.PHASE14_PROFILE || "load";
const baseUrl = process.env.BASE_URL || "http://127.0.0.1:3000";
const outputRoot = resolve(
  process.env.PHASE14_REPORT_ROOT || `14-load-resilience/reports/${profile}`,
);
const providerMode = process.env.PROVIDER_MODE || "faux";

const profiles = {
  baseline: [
    ["READ_ONLY", 1, "5m"],
    ["NO_TOOL", 1, "1m"],
    ["SIMPLE_TOOL", 1, "1m"],
    ["MULTI_TOOL", 1, "1m"],
    ["PROTECTED_ACTION", 1, "1m"],
  ],
  load: [1, 5, 10, 20, 50].map((vus) => ["MIXED_WORKLOAD", vus, "5m"]),
  stress: [75, 100, 150, 200].map((vus) => ["MIXED_WORKLOAD", vus, "2m"]),
  soak: [["MIXED_WORKLOAD", 20, "30m"]],
  backpressure: [["MIXED_WORKLOAD", 200, "2m"]],
};

const selected = profiles[profile];
if (!selected)
  throw new Error("PHASE14_PROFILE must be baseline, load, stress, soak, or backpressure");
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

function runK6(environment) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("k6", ["run", "14-load-resilience/scripts/k6-load.js"], {
      cwd: process.cwd(),
      env: { ...process.env, ...environment },
      stdio: "inherit",
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => resolveRun({ code: code ?? 1, signal }));
  });
}

await mkdir(outputRoot, { recursive: true });
const matrix = [];
for (const [scenario, vus, duration] of selected) {
  const name = `${scenario.toLowerCase()}-vu${vus}`;
  const summaryPath = resolve(outputRoot, `${name}.json`);
  const resourcePath = resolve(outputRoot, `${name}-resources.json`);
  const samples = [];
  await sampleMetrics(samples, "start");
  const startedAt = new Date().toISOString();
  const run = runK6({
    BASE_URL: baseUrl,
    SCENARIO: scenario,
    VUS: String(vus),
    DURATION: duration,
    PROVIDER_MODE: providerMode,
    RUN_ID: `${Date.now()}:${name}`,
    K6_SUMMARY_PATH: summaryPath,
  });
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
