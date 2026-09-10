import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import process from "node:process";

import { buildApi } from "../../dist/apps/api/src/app.js";
import { RequestAdmissionController } from "../../dist/apps/api/src/admission-control.js";

const levels = (process.env.PHASE14_CONCURRENCY || "1,5,10,20,50,100,200").split(",").map(Number);
const requestCount = Number(process.env.PHASE14_REQUEST_COUNT || "1000");
const delayMs = Number(process.env.PHASE14_HANDLER_DELAY_MS || "2");
const outputPath = process.env.PHASE14_OUTPUT || "benchmarks/reports/load/local-capacity.json";

if (
  levels.some((value) => !Number.isSafeInteger(value) || value < 1) ||
  !Number.isSafeInteger(requestCount) ||
  requestCount < 1 ||
  !Number.isSafeInteger(delayMs) ||
  delayMs < 0
) {
  throw new Error("Invalid local capacity configuration");
}

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1);
  return ordered[Math.max(0, index)] || 0;
}

async function runLevel(origin, concurrency, count = requestCount) {
  const durations = [];
  let next = 0;
  let success = 0;
  let controlledBusy = 0;
  let errors = 0;
  const cpuStart = process.cpuUsage();
  const startedAt = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= count) return;
        const requestStarted = performance.now();
        try {
          const response = await fetch(`${origin}/v1/phase14/backend-probe`);
          durations.push(performance.now() - requestStarted);
          if (response.status === 200) success += 1;
          else if (response.status === 429 || response.status === 503) controlledBusy += 1;
          else errors += 1;
          await response.arrayBuffer();
        } catch {
          durations.push(performance.now() - requestStarted);
          errors += 1;
        }
      }
    }),
  );
  const elapsedMs = performance.now() - startedAt;
  const cpu = process.cpuUsage(cpuStart);
  return {
    concurrency,
    requestCount: count,
    success,
    controlledBusy,
    errors,
    successRate: success / count,
    throughputRps: count / (elapsedMs / 1000),
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99),
    cpuUserMs: cpu.user / 1000,
    cpuSystemMs: cpu.system / 1000,
  };
}

const admission = new RequestAdmissionController({
  maxConcurrent: 32,
  maxQueue: 64,
  queueTimeoutMs: 100,
});
const app = buildApi({ admissionController: admission });
app.get("/v1/phase14/backend-probe", async () => {
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  return { status: "ok", payload: [1, 2, 3, 4] };
});
await app.listen({ host: "127.0.0.1", port: 0 });
const address = app.server.address();
if (address === null || typeof address === "string") throw new Error("API address unavailable");
const origin = `http://127.0.0.1:${address.port}`;
await runLevel(origin, 20, 500);
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
const rssStart = process.memoryUsage().rss;
const results = [];
let rssEnd = rssStart;
let finalAdmission = admission.snapshot();
try {
  for (const concurrency of levels) results.push(await runLevel(origin, concurrency));
} finally {
  rssEnd = process.memoryUsage().rss;
  finalAdmission = admission.snapshot();
  loop.disable();
  await app.close();
}
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    logicalCpu: (await import("node:os")).cpus().length,
    totalMemoryBytes: (await import("node:os")).totalmem(),
  },
  mode: "LOCAL_HTTP_FALLBACK",
  formalGateEligible: false,
  limitation:
    "Synthetic Fastify HTTP and bounded-admission measurement only; PostgreSQL, Redis, NATS, Simulator, and real LLM time are excluded.",
  configuration: { levels, requestCount, delayMs, maxConcurrent: 32, maxQueue: 64 },
  results,
  resources: {
    rssStartBytes: rssStart,
    rssEndBytes: rssEnd,
    rssGrowthFraction: rssStart === 0 ? 0 : (rssEnd - rssStart) / rssStart,
    eventLoopDelayP95Ms: loop.percentile(95) / 1e6,
    eventLoopDelayP99Ms: loop.percentile(99) / 1e6,
  },
  admission: finalAdmission,
};
const resolvedOutput = resolve(outputPath);
await mkdir(dirname(resolvedOutput), { recursive: true });
await writeFile(resolvedOutput, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report)}\n`);
