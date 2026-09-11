import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const mode = process.argv[2];
const apiBaseUrl = process.env.DRIVEGUARD_API_BASE_URL ?? "http://127.0.0.1:3000";
const simulatorBaseUrl = process.env.SIMULATOR_BASE_URL ?? "http://127.0.0.1:3001";
const applicationBaseUrl = `${process.env.DRIVEGUARD_HMI_BASE_URL ?? "http://127.0.0.1:3002"}/api`;
const stateFile = resolve(
  process.env.DRIVEGUARD_PHASE17_STATE_FILE ?? "phase17-durable-state.json",
);
const identityHeaders = Object.freeze({
  "x-driveguard-user-id": "user:phase17-staging",
  "x-driveguard-vehicle-id": "simulator-vehicle-001",
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok)
    throw new Error(`Request failed (${response.status}): ${body?.error?.code ?? "UNKNOWN_ERROR"}`);
  return body;
}

async function streamMessage(sessionId, prompt) {
  const response = await fetch(`${applicationBaseUrl}/v1/sessions/${sessionId}/messages/stream`, {
    method: "POST",
    headers: { ...identityHeaders, "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  invariant(response.ok, `SSE request failed with ${response.status}`);
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}

async function createSession(sessionId) {
  await requestJson(`${applicationBaseUrl}/v1/sessions`, {
    method: "POST",
    headers: { ...identityHeaders, "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
}

function confirmationFrom(events) {
  const confirmation = events.find((event) => event.event_type === "confirmation.required");
  invariant(confirmation?.data?.risk_level === "R2", "R2 confirmation is missing");
  invariant(typeof confirmation.data.action_id === "string", "confirmation action id is missing");
  invariant(
    typeof confirmation.data.confirmation_credential === "string",
    "confirmation credential is missing",
  );
  return confirmation.data;
}

async function prepare() {
  await requestJson(`${apiBaseUrl}/health/ready`);
  await requestJson(`${simulatorBaseUrl}/simulator/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenario: "low_soc", seed: 1717 }),
  });

  const pendingSessionId = `session:phase17:pending:${randomUUID()}`;
  await createSession(pendingSessionId);
  const pending = confirmationFrom(await streamMessage(pendingSessionId, "reserve charging"));

  const receiptSessionId = `session:phase17:receipt:${randomUUID()}`;
  await createSession(receiptSessionId);
  const completed = confirmationFrom(await streamMessage(receiptSessionId, "reserve charging"));
  const confirmation = await requestJson(
    `${applicationBaseUrl}/v1/actions/${completed.action_id}/confirm`,
    {
      method: "POST",
      headers: { ...identityHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: receiptSessionId,
        confirmationCredential: completed.confirmation_credential,
      }),
    },
  );
  const executionId = confirmation.data?.execution?.executionId;
  invariant(
    typeof executionId === "string",
    "confirmed action did not return an execution receipt",
  );

  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(
    stateFile,
    `${JSON.stringify({ pendingSessionId, pendingActionId: pending.action_id, receiptSessionId, executionId }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  process.stdout.write(
    `${JSON.stringify({ status: "PASS", operation: "durable-state-prepare" })}\n`,
  );
}

async function verify() {
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  const session = await requestJson(`${applicationBaseUrl}/v1/sessions/${state.pendingSessionId}`, {
    headers: identityHeaders,
  });
  invariant(
    session.data?.sessionId === state.pendingSessionId,
    "durable pending session was not preserved",
  );
  const pending = await requestJson(`${applicationBaseUrl}/v1/actions/${state.pendingActionId}`, {
    headers: identityHeaders,
  });
  invariant(
    pending.data?.state === "AWAITING_CONFIRMATION",
    "pending confirmation was not preserved",
  );
  const receipt = await requestJson(`${applicationBaseUrl}/v1/executions/${state.executionId}`, {
    headers: identityHeaders,
  });
  invariant(receipt.data?.state === "SUCCEEDED", "execution receipt was not preserved");
  const simulatorState = await requestJson(`${simulatorBaseUrl}/simulator/state`);
  invariant(
    simulatorState?.charging?.reservations?.length === 0,
    "recreated simulator replayed a completed side effect",
  );
  process.stdout.write(
    `${JSON.stringify({ status: "PASS", operation: "durable-state-verify", duplicateSideEffects: 0 })}\n`,
  );
}

if (mode === "prepare") await prepare();
else if (mode === "verify") await verify();
else throw new Error("Usage: node tests/smoke/phase17-durable-state-smoke.mjs <prepare|verify>");
