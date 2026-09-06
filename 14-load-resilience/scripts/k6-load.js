import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

const baseUrl = __ENV.BASE_URL || "http://127.0.0.1:3000";
const scenarioName = __ENV.SCENARIO || "MIXED_WORKLOAD";
const virtualUsers = Number(__ENV.VUS || "1");
const duration = __ENV.DURATION || "30s";
const runId = (__ENV.RUN_ID || `${Date.now()}`).replace(/[^A-Za-z0-9._:-]/g, "-");

if (!Number.isInteger(virtualUsers) || virtualUsers < 1 || virtualUsers > 1000) {
  throw new Error("VUS must be an integer between 1 and 1000");
}

export const options = {
  vus: virtualUsers,
  duration,
  discardResponseBodies: false,
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
  thresholds:
    scenarioName === "READ_ONLY"
      ? {
          expected_success: ["rate>0.995"],
          backend_overhead_ms: ["p(95)<100", "p(99)<250"],
        }
      : { expected_success: ["rate>0.995"] },
};

const backendOverhead = new Trend("backend_overhead_ms", true);
const agentEndToEnd = new Trend("agent_end_to_end_ms", true);
const expectedSuccess = new Rate("expected_success");
const controlledBusy = new Counter("controlled_busy");
const timeouts = new Counter("request_timeouts");

function identity(index) {
  return {
    headers: {
      "content-type": "application/json",
      "x-driveguard-user-id": `phase14-user:${runId}:${index}`,
      "x-driveguard-vehicle-id": `phase14-vehicle:${runId}:${index}`,
    },
  };
}

function sessionId(index) {
  return `phase14-session:${runId}:${index}`;
}

export function setup() {
  if (scenarioName === "READ_ONLY") return { sessions: [] };
  const sessions = [];
  for (let index = 1; index <= virtualUsers; index += 1) {
    const id = sessionId(index);
    const response = http.post(
      `${baseUrl}/v1/sessions`,
      JSON.stringify({ sessionId: id }),
      identity(index),
    );
    if (response.status !== 200) {
      throw new Error(`Session setup failed with HTTP ${response.status}`);
    }
    sessions.push(id);
  }
  return { sessions };
}

function record(response, trend, acceptedStatuses = [200]) {
  trend.add(response.timings.duration);
  const accepted = acceptedStatuses.includes(response.status);
  expectedSuccess.add(accepted);
  if (response.status === 429 || response.status === 503) controlledBusy.add(1);
  if (response.status === 0) timeouts.add(1);
  check(response, { "response follows scenario contract": () => accepted });
  return accepted;
}

function readOnly() {
  const path = __ENV.READ_ONLY_PATH || "/health/live";
  const response = http.get(`${baseUrl}${path}`);
  record(response, backendOverhead);
}

function sendMessage(prompt, acceptedStatuses = [200]) {
  const index = __VU;
  const response = http.post(
    `${baseUrl}/v1/sessions/${sessionId(index)}/messages`,
    JSON.stringify({ prompt }),
    identity(index),
  );
  record(response, agentEndToEnd, acceptedStatuses);
  return response;
}

function protectedAction() {
  const response = sendMessage("Reserve station-pudong-001 for charging. phase14:protected_action");
  if (response.status !== 200) return;
  const body = response.json();
  const action = body && body.data && body.data.actions && body.data.actions[0];
  if (!action) {
    expectedSuccess.add(false);
    return;
  }
  const rejected = http.post(
    `${baseUrl}/v1/actions/${action.actionId}/reject`,
    JSON.stringify({ sessionId: sessionId(__VU) }),
    identity(__VU),
  );
  record(rejected, backendOverhead);
}

function mixed() {
  const bucket = __ITER % 100;
  if (bucket < 35) return readOnly();
  if (bucket < 55) return sendMessage("DriveGuard status check. phase14:no_tool");
  if (bucket < 80) return sendMessage("Get the current vehicle battery state. phase14:simple_tool");
  if (bucket < 90)
    return sendMessage("Get current vehicle state and trip state. phase14:multi_tool");
  if (bucket < 98) return protectedAction();
  return sendMessage(
    "Get current vehicle state during injected fault. phase14:fault_recovery",
    [200, 503],
  );
}

export default function () {
  switch (scenarioName) {
    case "READ_ONLY":
      readOnly();
      break;
    case "NO_TOOL":
      sendMessage("DriveGuard status check. phase14:no_tool");
      break;
    case "SIMPLE_TOOL":
      sendMessage("Get the current vehicle battery state. phase14:simple_tool");
      break;
    case "MULTI_TOOL":
      sendMessage("Get current vehicle state and trip state. phase14:multi_tool");
      break;
    case "PROTECTED_ACTION":
      protectedAction();
      break;
    case "FAULT_RECOVERY":
      sendMessage(
        "Get current vehicle state during injected fault. phase14:fault_recovery",
        [200, 503],
      );
      break;
    case "MIXED_WORKLOAD":
      mixed();
      break;
    default:
      throw new Error(`Unsupported SCENARIO: ${scenarioName}`);
  }
  sleep(Number(__ENV.THINK_TIME_SECONDS || "0"));
}

export function handleSummary(data) {
  const output = __ENV.K6_SUMMARY_PATH || "stdout";
  return {
    [output]: JSON.stringify(
      {
        schemaVersion: 1,
        scenario: scenarioName,
        virtualUsers,
        duration,
        providerMode: __ENV.PROVIDER_MODE || "faux",
        generatedAt: new Date().toISOString(),
        k6: data,
      },
      null,
      2,
    ),
  };
}
