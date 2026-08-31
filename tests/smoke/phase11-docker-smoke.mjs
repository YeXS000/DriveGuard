import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const apiBaseUrl = process.env.DRIVEGUARD_API_BASE_URL ?? "http://127.0.0.1:3000";
const hmiBaseUrl = process.env.DRIVEGUARD_HMI_BASE_URL ?? "http://127.0.0.1:3002";
const simulatorBaseUrl = process.env.SIMULATOR_BASE_URL ?? "http://127.0.0.1:3001";
const prometheusBaseUrl = process.env.PROMETHEUS_BASE_URL ?? "http://127.0.0.1:9090";
const grafanaBaseUrl = process.env.GRAFANA_BASE_URL ?? "http://127.0.0.1:3003";
const grafanaUser = process.env.GRAFANA_ADMIN_USER ?? "admin";
const grafanaPassword = process.env.GRAFANA_ADMIN_PASSWORD;
const composeProject = process.env.DRIVEGUARD_COMPOSE_PROJECT ?? "driveguard";
const identityHeaders = Object.freeze({
  "x-driveguard-user-id": "user:phase11-docker",
  "x-driveguard-vehicle-id": "simulator-vehicle-001",
});
const secretSentinel = `PHASE11_SECRET_${randomUUID()}`;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(url, attempts = 90, options = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
    } catch {
      // Containers are expected to be temporarily unavailable while starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Service did not become ready: ${new URL(url).pathname}`);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}): ${body?.error?.code ?? "UNKNOWN_ERROR"}`);
  }
  return body;
}

async function streamMessage(sessionId, prompt) {
  const response = await fetch(`${hmiBaseUrl}/api/v1/sessions/${sessionId}/messages/stream`, {
    method: "POST",
    headers: { ...identityHeaders, "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  invariant(response.ok, `SSE request failed with ${response.status}`);
  const text = await response.text();
  const events = text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
  const types = new Set(events.map((event) => event.event_type));
  invariant(types.has("run.started"), "SSE run.started event is missing");
  invariant(types.has("assistant.completed"), "SSE assistant.completed event is missing");
  invariant(!types.has("run.failed"), "SSE run failed");
  return events;
}

function metricValue(metrics, name) {
  return metrics
    .split("\n")
    .filter((line) => line.startsWith(name) && !line.startsWith(`#`))
    .reduce((total, line) => total + Number(line.trim().split(/\s+/u).at(-1)), 0);
}

async function prometheusQuery(query) {
  return requestJson(`${prometheusBaseUrl}/api/v1/query?query=${encodeURIComponent(query)}`);
}

invariant(
  typeof grafanaPassword === "string" && grafanaPassword.length > 0,
  "GRAFANA_ADMIN_PASSWORD must be set",
);
const grafanaAuthorization = `Basic ${Buffer.from(`${grafanaUser}:${grafanaPassword}`).toString("base64")}`;

await Promise.all([
  waitFor(`${apiBaseUrl}/health/ready`),
  waitFor(hmiBaseUrl),
  waitFor(`${simulatorBaseUrl}/health/ready`),
  waitFor(`${prometheusBaseUrl}/-/ready`),
  waitFor(`${grafanaBaseUrl}/api/health`),
]);

const hmi = await fetch(hmiBaseUrl);
invariant((await hmi.text()).includes("DriveGuard HMI"), "HMI is not reachable");
await requestJson(`${simulatorBaseUrl}/simulator/reset`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ scenario: "low_soc", seed: 1111 }),
});

let businessRequestCount = 0;
let confirmationCredential;
for (let index = 0; index < 20; index += 1) {
  const sessionId = `session:phase11-docker:${randomUUID()}`;
  await requestJson(`${hmiBaseUrl}/api/v1/sessions`, {
    method: "POST",
    headers: { ...identityHeaders, "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  businessRequestCount += 1;
  const prompt =
    index === 19 ? "reserve charging" : `show vehicle state ${index === 0 ? secretSentinel : ""}`;
  const events = await streamMessage(sessionId, prompt);
  businessRequestCount += 1;
  if (index === 19) {
    const confirmation = events.find((event) => event.event_type === "confirmation.required");
    invariant(confirmation?.data?.risk_level === "R2", "R2 confirmation is missing");
    confirmationCredential = confirmation.data.confirmation_credential;
    const actionId = confirmation.data.action_id;
    invariant(typeof actionId === "string", "R2 action id is missing");
    invariant(typeof confirmationCredential === "string", "R2 credential is missing");
    const confirmed = await requestJson(`${hmiBaseUrl}/api/v1/actions/${actionId}/confirm`, {
      method: "POST",
      headers: { ...identityHeaders, "content-type": "application/json" },
      body: JSON.stringify({ sessionId, confirmationCredential }),
    });
    businessRequestCount += 1;
    invariant(confirmed.data?.execution?.status === "SUCCEEDED", "R2 execution failed");
  }
}
invariant(businessRequestCount === 41, "Unexpected business request count");

const metricsResponse = await fetch(`${apiBaseUrl}/metrics`);
invariant(metricsResponse.ok, "API /metrics is not reachable");
invariant(
  metricsResponse.headers.get("content-type")?.includes("text/plain"),
  "API /metrics content type is invalid",
);
const metrics = await metricsResponse.text();
const requiredMetrics = [
  "driveguard_http_requests_total",
  "driveguard_agent_runs_total",
  "driveguard_agent_run_duration_seconds",
  "driveguard_tool_calls_total",
  "driveguard_tool_duration_seconds",
  "driveguard_policy_decisions_total",
  "driveguard_confirmations_total",
  "driveguard_confirmation_pending",
  "driveguard_executions_total",
  "driveguard_execution_duration_seconds",
  "driveguard_execution_attempts_total",
  "driveguard_retries_total",
  "driveguard_circuit_state",
  "driveguard_llm_tokens_total",
  "driveguard_llm_cost_total",
  "driveguard_context_conflicts_total",
  "driveguard_dependency_up",
];
for (const metric of requiredMetrics) {
  invariant(metrics.includes(metric), `Required metric is missing: ${metric}`);
}
invariant(metricValue(metrics, "driveguard_agent_runs_total") >= 20, "Agent runs < 20");
invariant(metricValue(metrics, "driveguard_executions_total") >= 20, "Executions < 20");
for (const forbidden of ["session:", "run:", "action:", "execution:", secretSentinel]) {
  invariant(!metrics.includes(forbidden), `High-cardinality or secret value leaked to metrics`);
}

let prometheusReady = false;
for (let attempt = 0; attempt < 30; attempt += 1) {
  const query = await prometheusQuery("sum(driveguard_agent_runs_total)");
  const value = Number(query.data?.result?.[0]?.value?.[1] ?? 0);
  if (value >= 20) {
    prometheusReady = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
invariant(prometheusReady, "Prometheus did not scrape Phase 11 metrics");
const targets = await requestJson(`${prometheusBaseUrl}/api/v1/targets`);
invariant(
  targets.data?.activeTargets?.some(
    (target) => target.labels?.job === "driveguard-api" && target.health === "up",
  ),
  "Prometheus driveguard-api target is not up",
);

const grafanaHeaders = { authorization: grafanaAuthorization };
const dataSource = await requestJson(
  `${grafanaBaseUrl}/api/datasources/uid/driveguard-prometheus`,
  { headers: grafanaHeaders },
);
invariant(dataSource.type === "prometheus", "Grafana Prometheus datasource is missing");
const dataSourceHealth = await requestJson(
  `${grafanaBaseUrl}/api/datasources/uid/driveguard-prometheus/health`,
  { headers: grafanaHeaders },
);
invariant(dataSourceHealth.status === "OK", "Grafana datasource health check failed");
const dashboard = await requestJson(
  `${grafanaBaseUrl}/api/dashboards/uid/driveguard-observability`,
  { headers: grafanaHeaders },
);
const dashboardRows = dashboard.dashboard?.panels
  ?.filter((panel) => panel.type === "row")
  .map((panel) => panel.title);
for (const row of ["Agent", "Safety", "Reliability", "Infrastructure"]) {
  invariant(dashboardRows?.includes(row), `Grafana dashboard row is missing: ${row}`);
}

const logs = execFileSync(
  "docker",
  ["compose", "-p", composeProject, "logs", "--no-color", "--no-log-prefix", "api"],
  {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    timeout: 30_000,
  },
);
invariant(!logs.includes(secretSentinel), "Prompt secret sentinel leaked to logs");
invariant(!logs.includes(confirmationCredential), "Confirmation credential leaked to logs");
const structuredEvents = logs
  .split("\n")
  .filter((line) => line.trim().startsWith("{"))
  .map((line) => JSON.parse(line))
  .filter((record) => record.runId !== null && record.runId !== undefined);
invariant(structuredEvents.length > 0, "No structured business logs were emitted");
for (const record of structuredEvents) {
  for (const field of ["timestamp", "level", "service", "event", "traceId", "runId", "sessionId"]) {
    invariant(record[field] !== undefined, `Structured log field is missing: ${field}`);
  }
}

process.stdout.write(
  `${JSON.stringify({
    status: "PASS",
    businessRequestCount,
    agentRunsObserved: metricValue(metrics, "driveguard_agent_runs_total"),
    executionsObserved: metricValue(metrics, "driveguard_executions_total"),
    prometheusTarget: "up",
    grafanaDatasource: "OK",
    grafanaDashboardRows: dashboardRows,
    structuredBusinessLogs: structuredEvents.length,
    secretLeakageCount: 0,
    highCardinalityMetricLabelCount: 0,
  })}\n`,
);
