import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:3400";
const simulatorUrl = process.env.SIMULATOR_URL || "http://127.0.0.1:3401";
const toxiproxyUrl = process.env.TOXIPROXY_API_URL || "http://127.0.0.1:18474";
const outputPath = resolve(
  process.env.PHASE141_SMOKE_OUTPUT ||
    "14.1-production-topology-validation/reports/topology/smoke.json",
);
const runSuffix = `${Date.now()}`;
const identity = {
  userId: `phase141-smoke-user:${runSuffix}`,
  vehicleId: process.env.SIMULATOR_VEHICLE_ID || "simulator-vehicle-001",
  sessionId: `phase141-smoke-session:${runSuffix}`,
};

async function requestJson(url, init) {
  const startedAt = performance.now();
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, durationMs: performance.now() - startedAt, body };
}

function headers() {
  return {
    "content-type": "application/json",
    "x-driveguard-user-id": identity.userId,
    "x-driveguard-vehicle-id": identity.vehicleId,
  };
}

function metricValue(text, lineStart) {
  const line = text.split("\n").find((candidate) => candidate.startsWith(lineStart));
  if (!line) return null;
  const value = Number(line.slice(line.lastIndexOf(" ") + 1));
  return Number.isFinite(value) ? value : null;
}

const live = await requestJson(`${baseUrl}/health/live`);
const ready = await requestJson(`${baseUrl}/health/ready`);
const simulator = await requestJson(`${simulatorUrl}/health/ready`);
const proxies = await requestJson(`${toxiproxyUrl}/proxies`);
const session = await requestJson(`${baseUrl}/v1/sessions`, {
  method: "POST",
  headers: headers(),
  body: JSON.stringify({ sessionId: identity.sessionId }),
});
const message = await requestJson(`${baseUrl}/v1/sessions/${identity.sessionId}/messages`, {
  method: "POST",
  headers: headers(),
  body: JSON.stringify({
    prompt: "Get the current vehicle battery state. phase14:simple_tool",
  }),
});
const metricsResponse = await fetch(`${baseUrl}/metrics`, {
  signal: AbortSignal.timeout(5_000),
});
const metricsText = await metricsResponse.text();
const proxyBody = proxies.body && typeof proxies.body === "object" ? proxies.body : {};
const dependencies =
  ready.body && typeof ready.body === "object" && Array.isArray(ready.body.dependencies)
    ? ready.body.dependencies
    : [];
const checks = {
  apiLive: live.status === 200 && live.body?.status === "ok",
  apiReady: ready.status === 200 && ready.body?.status === "ready",
  postgresReady: dependencies.some(
    (dependency) => dependency.name === "postgres" && dependency.status === "up",
  ),
  redisReady: dependencies.some(
    (dependency) => dependency.name === "redis" && dependency.status === "up",
  ),
  natsReady: dependencies.some(
    (dependency) => dependency.name === "nats_jetstream" && dependency.status === "up",
  ),
  simulatorReady: simulator.status === 200 && simulator.body?.status === "ready",
  toxiproxyRoutes: ["postgres", "redis", "nats", "simulator"].every(
    (name) => proxyBody[name]?.enabled === true,
  ),
  sessionPersisted: session.status === 200 && session.body?.data?.sessionId === identity.sessionId,
  agentToSimulator:
    message.status === 200 &&
    message.body?.data?.status === "completed" &&
    message.body?.data?.policyDecisions?.some(
      (decision) => decision.tool === "get_vehicle_state" && decision.decision === "ALLOW",
    ),
  metricsAvailable: metricsResponse.status === 200,
};
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    logicalCpu: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    baseUrl,
    simulatorUrl,
    toxiproxyUrl,
    providerMode: "faux",
  },
  identity,
  checks,
  endpoints: {
    live: { status: live.status, durationMs: live.durationMs },
    ready: { status: ready.status, durationMs: ready.durationMs, body: ready.body },
    simulator: { status: simulator.status, durationMs: simulator.durationMs },
    session: { status: session.status, durationMs: session.durationMs },
    message: {
      status: message.status,
      durationMs: message.durationMs,
      runId: message.body?.data?.runId ?? null,
      traceId: message.body?.data?.traceId ?? null,
      outcome: message.body?.data?.status ?? null,
    },
  },
  proxies: Object.fromEntries(
    Object.entries(proxyBody).map(([name, proxy]) => [
      name,
      { enabled: proxy.enabled, listen: proxy.listen, upstream: proxy.upstream },
    ]),
  ),
  metrics: {
    agentSucceeded: metricValue(metricsText, 'driveguard_agent_runs_total{status="succeeded"}'),
    agentFailed: metricValue(metricsText, 'driveguard_agent_runs_total{status="failed"}'),
    postgresTotal: metricValue(metricsText, 'driveguard_postgres_pool_connections{state="total"}'),
    postgresWaiting: metricValue(
      metricsText,
      'driveguard_postgres_pool_connections{state="waiting"}',
    ),
    redisReady: metricValue(metricsText, "driveguard_redis_connection_ready"),
    natsPending: metricValue(metricsText, 'driveguard_nats_consumer_messages{state="pending"}'),
    natsAckPending: metricValue(
      metricsText,
      'driveguard_nats_consumer_messages{state="ack_pending"}',
    ),
    executorQueued: metricValue(metricsText, "driveguard_executor_queued"),
  },
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ outputPath, checks })}\n`);
if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
