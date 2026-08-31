import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const apiBaseUrl = process.env.DRIVEGUARD_API_BASE_URL ?? "http://127.0.0.1:3000";
const hmiBaseUrl = process.env.DRIVEGUARD_HMI_BASE_URL ?? "http://127.0.0.1:3002";
const applicationBaseUrl = `${hmiBaseUrl}/api`;
const simulatorBaseUrl = process.env.SIMULATOR_BASE_URL ?? "http://127.0.0.1:3001";
const identityHeaders = Object.freeze({
  "x-driveguard-user-id": "user:phase10-docker",
  "x-driveguard-vehicle-id": "simulator-vehicle-001",
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(url, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The service is expected to be temporarily unavailable during restart.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Service did not become ready: ${url}`);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Non-JSON response from ${new URL(url).pathname}`);
  }
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}): ${body?.error?.code ?? "UNKNOWN_ERROR"}`);
  }
  return body;
}

async function streamMessage(sessionId, prompt) {
  const response = await fetch(`${applicationBaseUrl}/v1/sessions/${sessionId}/messages/stream`, {
    method: "POST",
    headers: { ...identityHeaders, "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  invariant(response.ok, `SSE request failed with ${response.status}`);
  invariant(
    response.headers.get("content-type")?.includes("text/event-stream"),
    "SSE content type is missing",
  );
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}

function reservationCount(state) {
  const reservations = state?.charging?.reservations;
  invariant(Array.isArray(reservations), "Simulator reservation state is invalid");
  return reservations.length;
}

await waitFor(`${apiBaseUrl}/health/ready`);
await waitFor(hmiBaseUrl);
await waitFor(`${simulatorBaseUrl}/health/ready`);

const hmi = await fetch(hmiBaseUrl);
invariant((await hmi.text()).includes("DriveGuard HMI"), "HMI content is not reachable");

await requestJson(`${simulatorBaseUrl}/simulator/reset`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ scenario: "low_soc", seed: 1010 }),
});
const beforeState = await requestJson(`${simulatorBaseUrl}/simulator/state`);
const beforeReservations = reservationCount(beforeState);
const sessionId = `session:docker:${randomUUID()}`;
await requestJson(`${applicationBaseUrl}/v1/sessions`, {
  method: "POST",
  headers: { ...identityHeaders, "content-type": "application/json" },
  body: JSON.stringify({ sessionId }),
});

const r0Events = await streamMessage(sessionId, "show vehicle state");
const r0Types = new Set(r0Events.map((event) => event.event_type));
const r0FailureCode = r0Events.find((event) => event.event_type === "run.failed")?.data?.code;
for (const required of ["run.started", "tool.requested", "tool.completed", "assistant.completed"]) {
  invariant(
    r0Types.has(required),
    `R0 SSE event is missing: ${required}; observed=${[...r0Types].join(",")}; failure=${r0FailureCode ?? "none"}`,
  );
}

const r2Events = await streamMessage(sessionId, "reserve charging");
const confirmation = r2Events.find((event) => event.event_type === "confirmation.required");
const r2Types = r2Events.map((event) => event.event_type);
const r2FailureCode = r2Events.find((event) => event.event_type === "run.failed")?.data?.code;
invariant(
  confirmation !== undefined,
  `R2 confirmation event is missing; observed=${r2Types.join(",")}; failure=${r2FailureCode ?? "none"}`,
);
invariant(confirmation.data?.risk_level === "R2", "R2 risk level is missing");
const actionId = confirmation.data?.action_id;
const confirmationCredential = confirmation.data?.confirmation_credential;
invariant(typeof actionId === "string", "Confirmation action id is missing");
invariant(typeof confirmationCredential === "string", "Confirmation credential is missing");

const unconfirmedState = await requestJson(`${simulatorBaseUrl}/simulator/state`);
invariant(
  reservationCount(unconfirmedState) === beforeReservations,
  "Unconfirmed R2 action produced a side effect",
);

execFileSync("docker", ["compose", "restart", "api"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "pipe",
  timeout: 60_000,
});
await waitFor(`${apiBaseUrl}/health/ready`);

const restoredSession = await requestJson(`${applicationBaseUrl}/v1/sessions/${sessionId}`, {
  headers: identityHeaders,
});
invariant(restoredSession.data?.sessionId === sessionId, "Session was not restored after restart");
const restoredAction = await requestJson(`${applicationBaseUrl}/v1/actions/${actionId}`, {
  headers: identityHeaders,
});
invariant(
  restoredAction.data?.state === "AWAITING_CONFIRMATION",
  "Pending action was not restored",
);

const confirmed = await requestJson(`${applicationBaseUrl}/v1/actions/${actionId}/confirm`, {
  method: "POST",
  headers: { ...identityHeaders, "content-type": "application/json" },
  body: JSON.stringify({ sessionId, confirmationCredential }),
});
invariant(confirmed.data?.execution?.status === "SUCCEEDED", "Confirmed execution did not succeed");
const executionId = confirmed.data?.execution?.executionId;
invariant(typeof executionId === "string", "Execution id is missing");
const execution = await requestJson(`${applicationBaseUrl}/v1/executions/${executionId}`, {
  headers: identityHeaders,
});
invariant(execution.data?.state === "SUCCEEDED", "Durable execution status is not SUCCEEDED");

const afterState = await requestJson(`${simulatorBaseUrl}/simulator/state`);
invariant(
  reservationCount(afterState) === beforeReservations + 1,
  "Confirmed R2 action did not produce exactly one side effect",
);

process.stdout.write(
  `${JSON.stringify({
    status: "PASS",
    apiHealth: "PASS",
    hmiReachable: "PASS",
    r0Streaming: "PASS",
    r2Confirmation: "PASS",
    sessionRestartRecovery: "PASS",
    pendingActionRestartRecovery: "PASS",
    unconfirmedSideEffects: 0,
    duplicateSideEffects: 0,
  })}\n`,
);
