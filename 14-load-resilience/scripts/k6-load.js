import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

const baseUrl = __ENV.BASE_URL || "http://127.0.0.1:3000";
const scenarioName = __ENV.SCENARIO || "MIXED_WORKLOAD";
const virtualUsers = Number(__ENV.VUS || "1");
const duration = __ENV.DURATION || "30s";
const runId = (__ENV.RUN_ID || `${Date.now()}`).replace(/[^A-Za-z0-9._:-]/g, "-");
const simulatorVehicleId = __ENV.SIMULATOR_VEHICLE_ID || "simulator-vehicle-001";
const sessionMode = __ENV.SESSION_MODE || "per_vu";

if (!Number.isInteger(virtualUsers) || virtualUsers < 1 || virtualUsers > 1000) {
  throw new Error("VUS must be an integer between 1 and 1000");
}
if (!/^[A-Za-z0-9._:-]{1,128}$/.test(simulatorVehicleId)) {
  throw new Error("SIMULATOR_VEHICLE_ID must be a valid DriveGuard identity");
}
if (sessionMode !== "per_vu" && sessionMode !== "per_iteration") {
  throw new Error("SESSION_MODE must be per_vu or per_iteration");
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
const safeReplan = new Counter("safe_replan");
const safeDegraded = new Counter("safe_degraded");
const unexpectedHttp500 = new Counter("unexpected_http_500");
const externalSessionBusy = new Counter("external_session_busy");
const http429 = new Counter("http_429");
const http503 = new Counter("http_503");

function identity(index, userId = `phase14-user:${runId}:${index}`) {
  return {
    headers: {
      "content-type": "application/json",
      "x-driveguard-user-id": userId,
      "x-driveguard-vehicle-id": simulatorVehicleId,
    },
  };
}

function sessionId(index) {
  return `phase14-session:${runId}:${index}`;
}

export function setup() {
  if (scenarioName === "READ_ONLY" || sessionMode === "per_iteration") {
    return { sessions: [] };
  }
  const sessions = [];
  for (let index = 1; index <= virtualUsers; index += 1) {
    const id = sessionId(index);
    const userId = `phase14-user:${runId}:${index}`;
    const response = http.post(
      `${baseUrl}/v1/sessions`,
      JSON.stringify({ sessionId: id }),
      identity(index, userId),
    );
    if (response.status !== 200) {
      throw new Error(`Session setup failed with HTTP ${response.status}`);
    }
    sessions.push({ id, userId });
  }
  return { sessions };
}

function createIterationSession(index) {
  const suffix = `${index}:${__ITER}`;
  const id = `phase14-session:${runId}:iteration:${suffix}`;
  const userId = `phase14-user:${runId}:iteration:${suffix}`;
  const response = http.post(
    `${baseUrl}/v1/sessions`,
    JSON.stringify({ sessionId: id }),
    identity(index, userId),
  );
  if (response.status !== 200) {
    throw new Error(`Fresh session setup failed with HTTP ${response.status}`);
  }
  return { id, userId };
}

function requestSessionContext(data, index) {
  return sessionMode === "per_iteration"
    ? createIterationSession(index)
    : sessionContext(data, index);
}

function responseErrorCode(response) {
  try {
    return response.json("error.code");
  } catch {
    return undefined;
  }
}

function sessionContext(data, index) {
  const context = data && data.sessions && data.sessions[index - 1];
  if (!context) throw new Error(`Session setup data is missing for VU ${index}`);
  return context;
}

function record(response, trend, acceptedStatuses = [200]) {
  trend.add(response.timings.duration);
  const accepted = acceptedStatuses.includes(response.status);
  const errorCode = responseErrorCode(response);
  expectedSuccess.add(accepted);
  if (response.status === 429 || response.status === 503) controlledBusy.add(1);
  if (response.status === 429) http429.add(1);
  if (response.status === 503) http503.add(1);
  if (response.status === 500) unexpectedHttp500.add(1);
  if (errorCode === "SESSION_BUSY") externalSessionBusy.add(1);
  if (response.status === 0) timeouts.add(1);
  check(response, { "response follows scenario contract": () => accepted });
  return accepted;
}

function readOnly() {
  const path = __ENV.READ_ONLY_PATH || "/health/live";
  const response = http.get(`${baseUrl}${path}`);
  record(response, backendOverhead);
}

function sendMessage(data, prompt, acceptedStatuses = [200, 429, 503], suppliedContext) {
  const index = __VU;
  const context = suppliedContext || requestSessionContext(data, index);
  const response = http.post(
    `${baseUrl}/v1/sessions/${context.id}/messages`,
    JSON.stringify({ prompt }),
    identity(index, context.userId),
  );
  record(response, agentEndToEnd, acceptedStatuses);
  return response;
}

function protectedAction(data) {
  const context = requestSessionContext(data, __VU);
  const response = sendMessage(
    data,
    "Reserve station-pudong-001 for charging. phase14:protected_action",
    [200, 409, 429, 503],
    context,
  );
  if (response.status === 409) {
    safeReplan.add(1);
    return;
  }
  if (response.status !== 200) return;
  const body = response.json();
  const action = body && body.data && body.data.actions && body.data.actions[0];
  if (!action) {
    expectedSuccess.add(false);
    return;
  }
  const rejected = http.post(
    `${baseUrl}/v1/actions/${action.actionId}/reject`,
    JSON.stringify({ sessionId: context.id }),
    identity(__VU, context.userId),
  );
  record(rejected, backendOverhead);
}

function mixed(data) {
  const bucket = __ITER % 100;
  if (bucket < 35) return readOnly();
  if (bucket < 55) return sendMessage(data, "DriveGuard status check. phase14:no_tool");
  if (bucket < 80)
    return sendMessage(data, "Get the current vehicle battery state. phase14:simple_tool");
  if (bucket < 90)
    return sendMessage(
      data,
      "Get current vehicle state and current trip state. phase14:multi_tool",
    );
  if (bucket < 98) return protectedAction(data);
  return sendMessage(
    data,
    "Get current vehicle state during injected fault. phase14:fault_recovery",
    [200, 503],
  );
}

export default function (data) {
  switch (scenarioName) {
    case "READ_ONLY":
      readOnly();
      break;
    case "NO_TOOL":
      sendMessage(data, "DriveGuard status check. phase14:no_tool");
      break;
    case "SIMPLE_TOOL":
      sendMessage(data, "Get the current vehicle battery state. phase14:simple_tool");
      break;
    case "MULTI_TOOL":
      sendMessage(data, "Get current vehicle state and current trip state. phase14:multi_tool");
      break;
    case "PROTECTED_ACTION":
      protectedAction(data);
      break;
    case "FAULT_RECOVERY":
      if (
        sendMessage(
          data,
          "Get current vehicle state during injected fault. phase14:fault_recovery",
          [200, 409, 429, 503],
        ).status === 409
      )
        safeDegraded.add(1);
      break;
    case "MIXED_WORKLOAD":
      mixed(data);
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
        sessionMode,
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
