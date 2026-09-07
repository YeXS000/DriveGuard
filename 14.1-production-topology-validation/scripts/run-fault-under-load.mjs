import { spawn } from "node:child_process";
import { mkdir, open, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:3400";
const simulatorUrl = process.env.SIMULATOR_URL || "http://127.0.0.1:3401";
const toxiproxyUrl = process.env.TOXIPROXY_API_URL || "http://127.0.0.1:18474";
const outputRoot = resolve(
  process.env.PHASE14_FAULT_REPORT_ROOT || "14.1-production-topology-validation/reports/fault",
);
const controller = resolve("14-load-resilience/scripts/toxiproxy-fault.mjs");

const allCases = [
  { name: "postgres-latency", proxy: "postgres", operation: "latency", value: "2000" },
  { name: "postgres-disconnect", proxy: "postgres", operation: "down" },
  { name: "redis-latency", proxy: "redis", operation: "latency", value: "1500" },
  { name: "redis-disconnect", proxy: "redis", operation: "down" },
  { name: "nats-interruption", proxy: "nats", operation: "down" },
  { name: "nats-slow-consumer", proxy: "nats", operation: "latency", value: "1500" },
  { name: "simulator-timeout", simulatorMode: "timeout", delayMs: 2500 },
  { name: "simulator-http-503", simulatorMode: "http_503", delayMs: 0 },
  { name: "simulator-connection-abort", simulatorMode: "connection_abort", delayMs: 0 },
];
const requestedCase = process.env.PHASE14_FAULT_CASE;
const cases =
  requestedCase === undefined
    ? allCases
    : allCases.filter((testCase) => testCase.name === requestedCase);
if (cases.length === 0) throw new Error("PHASE14_FAULT_CASE is not a known fault case");

async function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, options);
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => resolveRun({ code: code ?? 1, signal }));
  });
}

async function metrics(label) {
  try {
    const response = await fetch(`${baseUrl}/metrics`, { signal: AbortSignal.timeout(2_000) });
    return {
      label,
      sampledAt: new Date().toISOString(),
      status: response.status,
      text: await response.text(),
    };
  } catch (error) {
    return {
      label,
      sampledAt: new Date().toISOString(),
      status: 0,
      error: error instanceof Error ? error.message : "metrics unavailable",
    };
  }
}

async function tox(operation, proxy, value) {
  return run(
    process.execPath,
    [controller, operation, proxy, ...(value === undefined ? [] : [value])],
    {
      cwd: process.cwd(),
      env: { ...process.env, TOXIPROXY_API_URL: toxiproxyUrl },
      stdio: "ignore",
    },
  );
}

async function clearSimulatorFaults() {
  await fetch(`${simulatorUrl}/simulator/faults`, { method: "DELETE" });
}

async function inject(testCase) {
  if (testCase.proxy !== undefined) {
    const result = await tox(testCase.operation, testCase.proxy, testCase.value);
    if (result.code !== 0) throw new Error(`${testCase.name} injection failed`);
    return;
  }
  const response = await fetch(`${simulatorUrl}/simulator/faults`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      target: "vehicle.get_state",
      mode: testCase.simulatorMode,
      probability: 1,
      delayMs: testCase.delayMs,
    }),
  });
  if (response.status !== 201)
    throw new Error(`${testCase.name} injection returned HTTP ${response.status}`);
}

async function clear(testCase) {
  if (testCase.proxy !== undefined) {
    const result = await tox("clear", testCase.proxy);
    if (result.code !== 0) throw new Error(`${testCase.name} clear failed`);
  } else {
    await clearSimulatorFaults();
  }
}

async function recoveryProbe(name) {
  const token = randomUUID();
  const sessionId = `phase14-fault-session:${name}:${token}`;
  const headers = {
    "content-type": "application/json",
    "x-driveguard-user-id": `phase14-fault-user:${name}:${token}`,
    "x-driveguard-vehicle-id": "simulator-vehicle-001",
  };
  let last = { sessionStatus: 0, messageStatus: 0, errorCode: "NOT_RUN" };
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      const created = await fetch(`${baseUrl}/v1/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ sessionId }),
        signal: AbortSignal.timeout(5_000),
      });
      const message = await fetch(`${baseUrl}/v1/sessions/${sessionId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "Get current vehicle state. phase14:fault_recovery" }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await message.json().catch(() => ({}));
      last = {
        sessionStatus: created.status,
        messageStatus: message.status,
        errorCode: body?.error?.code ?? null,
      };
      if (created.status === 200 && message.status === 200) {
        return { recovered: true, attempts: attempt, ...last };
      }
    } catch (error) {
      last = {
        sessionStatus: 0,
        messageStatus: 0,
        errorCode: error instanceof Error ? error.name : "PROBE_FAILED",
      };
    }
    await delay(2_000);
  }
  return { recovered: false, attempts: 10, ...last };
}

await mkdir(outputRoot, { recursive: true });
const matrix = [];
for (const testCase of cases) {
  for (const proxy of ["postgres", "redis", "nats", "simulator"]) await tox("clear", proxy);
  await clearSimulatorFaults();
  const summaryPath = resolve(outputRoot, `${testCase.name}.json`);
  const consoleHandle = await open(resolve(outputRoot, `${testCase.name}.log`), "w");
  const samples = [await metrics("before")];
  const startedAt = new Date().toISOString();
  const k6 = run("k6", ["run", "--quiet", "14-load-resilience/scripts/k6-load.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BASE_URL: baseUrl,
      SCENARIO: "FAULT_RECOVERY",
      VUS: "5",
      DURATION: "25s",
      RUN_ID: `${Date.now()}:${testCase.name}`,
      K6_SUMMARY_PATH: summaryPath,
      PROVIDER_MODE: "faux",
    },
    stdio: ["ignore", consoleHandle.fd, consoleHandle.fd],
  });
  await delay(5_000);
  await inject(testCase);
  await delay(1_000);
  samples.push(await metrics("fault"));
  await delay(9_000);
  await clear(testCase);
  await delay(3_000);
  samples.push(await metrics("cleared"));
  const recovery = await recoveryProbe(testCase.name);
  const outcome = await k6;
  samples.push(await metrics("after"));
  await consoleHandle.close();
  await writeFile(
    resolve(outputRoot, `${testCase.name}-resources.json`),
    `${JSON.stringify(samples, null, 2)}\n`,
    "utf8",
  );
  matrix.push({ ...testCase, startedAt, outcome, recovery, summaryPath });
}

for (const proxy of ["postgres", "redis", "nats", "simulator"]) await tox("clear", proxy);
await clearSimulatorFaults();
await writeFile(
  resolve(outputRoot, "fault-matrix.json"),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), baseUrl, cases: matrix }, null, 2)}\n`,
  "utf8",
);

if (matrix.some((entry) => entry.outcome.code !== 0 || !entry.recovery.recovered))
  process.exitCode = 1;
