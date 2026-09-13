import assert from "node:assert/strict";

const hmiOrigin = process.env.DRIVEGUARD_HMI_ORIGIN ?? "http://127.0.0.1:23002";
const simulatorOrigin = process.env.DRIVEGUARD_SIMULATOR_ORIGIN ?? "http://127.0.0.1:23001";
const userId = "phase20-driver";
const vehicleId = "simulator-vehicle-001";
const identityHeaders = Object.freeze({
  "content-type": "application/json",
  "x-driveguard-user-id": userId,
  "x-driveguard-vehicle-id": vehicleId,
});

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${hmiOrigin}/api${path}`, {
    ...options,
    headers: { ...identityHeaders, ...(options.headers ?? {}) },
  });
  const payload = await response.json();
  return { response, payload };
}

function parseSse(body) {
  return body
    .replaceAll("\r\n", "\n")
    .split("\n\n")
    .flatMap((frame) => {
      const data = frame.split("\n").find((line) => line.startsWith("data: "));
      return data === undefined ? [] : [JSON.parse(data.slice(6))];
    });
}

async function stream(sessionId, prompt) {
  const response = await fetch(
    `${hmiOrigin}/api/v1/sessions/${encodeURIComponent(sessionId)}/messages/stream?vehicleId=${encodeURIComponent(vehicleId)}`,
    { method: "POST", headers: identityHeaders, body: JSON.stringify({ prompt }) },
  );
  assert.equal(response.status, 200);
  return parseSse(await response.text());
}

async function reservationCount() {
  const response = await fetch(`${simulatorOrigin}/charging/status`, {
    headers: { "x-driveguard-vehicle-id": vehicleId },
  });
  assert.equal(response.status, 200);
  return (await response.json()).reservations.length;
}

const counters = {
  confirmationBypass: 0,
  duplicateSideEffect: 0,
  falseSuccess: 0,
};

const hmi = await fetch(hmiOrigin);
assert.equal(hmi.status, 200);
assert.match(await hmi.text(), /DriveGuard HMI/u);

const live = await fetch(`${hmiOrigin}/api/health/live`);
assert.deepEqual(await live.json(), { status: "ok" });
const ready = await fetch(`${hmiOrigin}/api/health/ready`);
assert.equal(ready.status, 200);
assert.equal((await ready.json()).status, "ready");

const context = await jsonRequest(`/v1/context?vehicleId=${encodeURIComponent(vehicleId)}`);
assert.equal(context.response.status, 200);
assert.equal(context.payload.data.vehicle.vehicleId, vehicleId);
assert.ok(context.payload.data.simulationVersion >= 1);

const created = await jsonRequest("/v1/sessions", {
  method: "POST",
  body: JSON.stringify({ vehicleId }),
});
assert.equal(created.response.status, 200);
assert.equal(
  created.response.headers.get("x-driveguard-identity-boundary"),
  "DEVELOPMENT_IDENTITY_BOUNDARY",
);
const sessionId = created.payload.data.sessionId;

const normal = await stream(sessionId, "Hello DriveGuard");
assert.ok(normal.some((event) => event.event_type === "run.started"));
assert.ok(
  normal.some(
    (event) => event.event_type === "assistant.completed" && event.data.status === "completed",
  ),
);

const simpleTool = await stream(sessionId, "What is the current vehicle state?");
assert.ok(
  simpleTool.some(
    (event) => event.event_type === "tool.requested" && event.data.tool === "get_vehicle_state",
  ),
);
assert.ok(
  simpleTool.some(
    (event) => event.event_type === "tool.completed" && event.data.is_error === false,
  ),
);

const firstBusyRequest = fetch(
  `${hmiOrigin}/api/v1/sessions/${encodeURIComponent(sessionId)}/messages/stream?vehicleId=${encodeURIComponent(vehicleId)}`,
  {
    method: "POST",
    headers: identityHeaders,
    body: JSON.stringify({ prompt: "Check vehicle state" }),
  },
);
const firstBusyResponse = await firstBusyRequest;
const busyEventsPromise = stream(sessionId, "Check vehicle state again");
const [firstBusyEvents, busyEvents] = await Promise.all([
  firstBusyResponse.text().then(parseSse),
  busyEventsPromise,
]);
assert.ok(firstBusyEvents.some((event) => event.event_type === "assistant.completed"));
assert.ok(
  busyEvents.some(
    (event) => event.event_type === "run.failed" && event.data.code === "SERVICE_BUSY",
  ),
);
assert.ok(!busyEvents.some((event) => event.event_type === "assistant.completed"));

const reset = await fetch(`${simulatorOrigin}/simulator/reset`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ scenario: "low_soc", seed: 2020 }),
});
assert.equal(reset.status, 200);
const beforeProtected = await reservationCount();
const protectedEvents = await stream(sessionId, "Reserve a charging slot");
const confirmation = protectedEvents.find((event) => event.event_type === "confirmation.required");
assert.ok(confirmation, JSON.stringify(protectedEvents));
assert.equal(confirmation.data.risk_level, "R2");
const beforeConfirm = await reservationCount();
if (beforeConfirm !== beforeProtected) counters.confirmationBypass += 1;

const confirmed = await jsonRequest(
  `/v1/actions/${encodeURIComponent(confirmation.data.action_id)}/confirm`,
  {
    method: "POST",
    body: JSON.stringify({
      sessionId,
      vehicleId,
      confirmationCredential: confirmation.data.confirmation_credential,
    }),
  },
);
assert.equal(confirmed.response.status, 200);
assert.equal(confirmed.payload.data.execution.status, "SUCCEEDED");
const executionId = confirmed.payload.data.execution.executionId;
assert.ok(executionId);

const receipt = await jsonRequest(
  `/v1/executions/${encodeURIComponent(executionId)}?vehicleId=${encodeURIComponent(vehicleId)}`,
);
assert.equal(receipt.response.status, 200);
assert.equal(receipt.payload.data.state, "SUCCEEDED");
assert.equal(receipt.payload.data.executionId, executionId);

const afterConfirm = await reservationCount();
assert.equal(afterConfirm, beforeConfirm + 1);
const duplicate = await jsonRequest(
  `/v1/actions/${encodeURIComponent(confirmation.data.action_id)}/confirm`,
  {
    method: "POST",
    body: JSON.stringify({
      sessionId,
      vehicleId,
      confirmationCredential: confirmation.data.confirmation_credential,
    }),
  },
);
if (duplicate.response.status === 200) {
  assert.equal(duplicate.payload.data.execution.status, "SUCCEEDED");
  assert.equal(duplicate.payload.data.execution.executionId, executionId);
  assert.equal(duplicate.payload.data.execution.deduplicated, true);
}
const afterDuplicate = await reservationCount();
if (afterDuplicate !== afterConfirm) counters.duplicateSideEffect += 1;

const missingSession = await jsonRequest(
  `/v1/sessions/session:missing?vehicleId=${encodeURIComponent(vehicleId)}`,
);
assert.equal(missingSession.response.status, 404);
assert.equal(missingSession.payload.error.code, "SESSION_NOT_FOUND");
if (missingSession.payload.data?.status === "completed") counters.falseSuccess += 1;

assert.deepEqual(counters, {
  confirmationBypass: 0,
  duplicateSideEffect: 0,
  falseSuccess: 0,
});

process.stdout.write(
  `${JSON.stringify(
    {
      result: "PASS",
      hmiOrigin,
      sessionCreation: "PASS",
      normalChat: "PASS",
      simpleTool: "PASS",
      vehicleStateRefresh: "PASS",
      protectedAction: "PASS",
      confirmation: "PASS",
      executionReceipt: "PASS",
      serviceBusy: "PASS",
      sessionError: "PASS",
      counters,
    },
    null,
    2,
  )}\n`,
);
