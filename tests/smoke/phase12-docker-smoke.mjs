import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { parseUrgentEvent, urgentEventFingerprint } from "@driveguard/urgent-events";

const apiBaseUrl = process.env.DRIVEGUARD_API_BASE_URL ?? "http://127.0.0.1:3000";
const hmiBaseUrl = process.env.DRIVEGUARD_HMI_BASE_URL ?? "http://127.0.0.1:3002";
const simulatorBaseUrl = process.env.SIMULATOR_BASE_URL ?? "http://127.0.0.1:3001";
const prometheusBaseUrl = process.env.PROMETHEUS_BASE_URL ?? "http://127.0.0.1:9090";
const grafanaBaseUrl = process.env.GRAFANA_BASE_URL ?? "http://127.0.0.1:3003";
const composeProject = process.env.DRIVEGUARD_COMPOSE_PROJECT ?? "driveguard";
const databaseUser = process.env.POSTGRES_USER ?? "driveguard";
const databaseName = process.env.POSTGRES_DB ?? "driveguard";
const identityHeaders = Object.freeze({
  "x-driveguard-user-id": process.env.URGENT_EVENT_USER_ID ?? "phase5-driver",
  "x-driveguard-vehicle-id": "simulator-vehicle-001",
});
const secretSentinel = `PHASE12_SECRET_${randomUUID().replaceAll("-", "_").toUpperCase()}`;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function compose(args, options = {}) {
  return execFileSync("docker", ["compose", "-p", composeProject, ...args], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 60_000,
    stdio: options.stdio ?? "pipe",
  });
}

async function waitFor(url, attempts = 90, options = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
    } catch {
      // Services are expected to be temporarily unavailable during startup/restart.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Service did not become ready: ${new URL(url).pathname}`);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}): ${body?.error?.code ?? "UNKNOWN"}`);
  }
  return body;
}

async function pollUrgent(eventId, expectedStatuses, attempts = 80) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(`${apiBaseUrl}/v1/urgent-events/${eventId}`, {
      headers: identityHeaders,
    });
    if (response.ok) {
      const body = await response.json();
      if (expectedStatuses.includes(body.data?.status)) return body.data;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Urgent event did not reach ${expectedStatuses.join("/")}: ${eventId}`);
}

function publish(event, { direct = false } = {}) {
  const program = direct
    ? `
      import { connect } from "@nats-io/transport-node";
      import { jetstream } from "@nats-io/jetstream";
      const nc = await connect({ servers: process.env.NATS_URL });
      const event = JSON.parse(process.argv[1]);
      const ack = await jetstream(nc).publish(
        "driveguard.urgent.events",
        new TextEncoder().encode(JSON.stringify(event)),
      );
      process.stdout.write(JSON.stringify({ sequence: ack.seq, duplicate: ack.duplicate }));
      await nc.drain();
    `
    : `
      import { connect } from "@nats-io/transport-node";
      import { UrgentEventPublisher } from "@driveguard/urgent-events";
      const nc = await connect({ servers: process.env.NATS_URL });
      const result = await new UrgentEventPublisher(nc).publish(JSON.parse(process.argv[1]));
      process.stdout.write(JSON.stringify(result));
      await nc.drain();
    `;
  return JSON.parse(
    compose([
      "exec",
      "-T",
      "api",
      "node",
      "--input-type=module",
      "-e",
      program,
      JSON.stringify(event),
    ]),
  );
}

async function waitForNotification(eventId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${hmiBaseUrl}/api/v1/urgent-events/stream`, {
      headers: identityHeaders,
      signal: controller.signal,
    });
    invariant(response.ok && response.body !== null, "Urgent HMI SSE stream is unavailable");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error("Urgent SSE stream ended before the expected event");
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame.split("\n").find((candidate) => candidate.startsWith("data: "));
        if (line === undefined) continue;
        const event = JSON.parse(line.slice(6));
        if (event.data?.event_id === eventId && event.event_type !== "urgent.received") {
          return event;
        }
      }
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function event(eventId, eventType, payload) {
  const receivedAt = new Date().toISOString();
  return {
    eventId,
    schemaVersion: 1,
    eventType,
    source: "SIMULATOR",
    vehicleId: "simulator-vehicle-001",
    occurredAt: new Date(Date.parse(receivedAt) - 1_000).toISOString(),
    receivedAt,
    severity: "INFO",
    payload,
    correlationId: `correlation-${eventId}`,
  };
}

function psql(query) {
  return compose([
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    databaseUser,
    "-d",
    databaseName,
    "-Atc",
    query,
  ]).trim();
}

function natsSubjectCount(subject) {
  const program = `
    import { connect } from "@nats-io/transport-node";
    import { jetstreamManager } from "@nats-io/jetstream";
    const nc = await connect({ servers: process.env.NATS_URL });
    const info = await (await jetstreamManager(nc)).streams.info("DRIVEGUARD_URGENT_EVENTS", {
      subjects_filter: process.argv[1],
    });
    process.stdout.write(String(info.state.subjects?.[process.argv[1]] ?? 0));
    await nc.drain();
  `;
  return Number(
    compose(["exec", "-T", "api", "node", "--input-type=module", "-e", program, subject]),
  );
}

function metricValue(metrics, name) {
  return metrics
    .split("\n")
    .filter((line) => line.startsWith(name) && !line.startsWith("#"))
    .reduce((sum, line) => sum + Number(line.trim().split(/\s+/u).at(-1)), 0);
}

await Promise.all([
  waitFor(`${apiBaseUrl}/health/ready`),
  waitFor(hmiBaseUrl),
  waitFor(`${simulatorBaseUrl}/health/ready`),
  waitFor(`${prometheusBaseUrl}/-/ready`),
  waitFor(`${grafanaBaseUrl}/api/health`),
]);

await requestJson(`${simulatorBaseUrl}/simulator/reset`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ scenario: "low_soc", seed: 1212 }),
});
const lowSoc = event(`phase12-low-soc-${randomUUID()}`, "LOW_SOC", { reportedSoc: 5 });
const lowSocNotificationPromise = waitForNotification(lowSoc.eventId);
await new Promise((resolve) => setTimeout(resolve, 100));
const lowSocPublish = publish(lowSoc);
const lowSocNotification = await lowSocNotificationPromise;
const lowSocRecord = await pollUrgent(lowSoc.eventId, ["HANDLED"]);
invariant(lowSocPublish.duplicate === false, "First LOW_SOC publication was marked duplicate");
invariant(lowSocRecord.severity === "CRITICAL", "LOW_SOC deterministic classification failed");
invariant(lowSocRecord.requiresConfirmation === true, "LOW_SOC did not require R2 confirmation");
invariant(
  lowSocNotification.event_type === "urgent.confirmation_required",
  "LOW_SOC confirmation notification is missing",
);
invariant(lowSocNotification.data?.risk_level === "R2", "LOW_SOC notification risk is not R2");

const beforeConfirm = await requestJson(`${simulatorBaseUrl}/simulator/state`);
const confirmed = await requestJson(
  `${apiBaseUrl}/v1/actions/${lowSocNotification.data.action_id}/confirm`,
  {
    method: "POST",
    headers: { ...identityHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: lowSocNotification.data.session_id,
      confirmationCredential: lowSocNotification.data.confirmation_credential,
    }),
  },
);
invariant(confirmed.data?.execution?.status === "SUCCEEDED", "Confirmed LOW_SOC action failed");
const afterConfirm = await requestJson(`${simulatorBaseUrl}/simulator/state`);
invariant(
  beforeConfirm.trip?.routeId !== afterConfirm.trip?.routeId,
  "Confirmed LOW_SOC action did not produce the expected reroute",
);

publish(lowSoc, { direct: true });
await new Promise((resolve) => setTimeout(resolve, 750));
const afterDuplicate = await requestJson(`${simulatorBaseUrl}/simulator/state`);
invariant(
  afterDuplicate.trip?.routeId === afterConfirm.trip?.routeId,
  "Duplicate LOW_SOC event produced another side effect",
);
invariant(
  psql(`select attempt_count from urgent_events where event_id='${lowSoc.eventId}'`) === "1",
  "Duplicate LOW_SOC event changed the durable attempt count",
);
invariant(
  psql(
    `select count(*) from pending_actions where action_id='${lowSocNotification.data.action_id}'`,
  ) === "1",
  "Duplicate LOW_SOC event created another action",
);

const collisionDlqBefore = natsSubjectCount("driveguard.urgent.dlq");
publish({ ...lowSoc, payload: { reportedSoc: 6 } }, { direct: true });
let collisionDlqObserved = false;
for (let attempt = 0; attempt < 20; attempt += 1) {
  if (natsSubjectCount("driveguard.urgent.dlq") > collisionDlqBefore) {
    collisionDlqObserved = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
invariant(collisionDlqObserved, "Same-ID altered content did not reach DLQ");
invariant(
  psql(`select attempt_count from urgent_events where event_id='${lowSoc.eventId}'`) === "1",
  "Same-ID altered content changed durable ownership",
);
const afterCollision = await requestJson(`${simulatorBaseUrl}/simulator/state`);
invariant(
  afterCollision.trip?.routeId === afterConfirm.trip?.routeId,
  "Same-ID altered content produced a side effect",
);

const fault = event(`phase12-fault-${randomUUID()}`, "VEHICLE_FAULT", {
  faultCode: "POWERTRAIN_FAULT",
  critical: true,
});
const faultNotificationPromise = waitForNotification(fault.eventId);
await new Promise((resolve) => setTimeout(resolve, 100));
publish(fault);
const faultNotification = await faultNotificationPromise;
const faultRecord = await pollUrgent(fault.eventId, ["HANDLED"]);
invariant(faultRecord.requiresConfirmation === true, "VEHICLE_FAULT did not require confirmation");
invariant(faultNotification.data?.risk_level === "R3", "VEHICLE_FAULT risk is not R3");

const invalid = {
  ...event(`phase12-invalid-${randomUUID()}`, "LOW_SOC", { reportedSoc: 4 }),
  schemaVersion: 2,
  secret: secretSentinel,
};
const actionCountBeforeInvalid = Number(
  psql(`select count(*) from pending_actions where action->>'runId' like 'urgent-run:%'`),
);
const dlqCountBeforeInvalid = natsSubjectCount("driveguard.urgent.dlq");
publish(invalid, { direct: true });
const invalidRecord = await pollUrgent(invalid.eventId, ["REJECTED"]);
invariant(invalidRecord.status === "REJECTED", "Invalid event was not rejected");
invariant(
  Number(
    psql(`select count(*) from pending_actions where action->>'runId' like 'urgent-run:%'`),
  ) === actionCountBeforeInvalid,
  "Invalid event created a business action",
);
let dlqObserved = false;
for (let attempt = 0; attempt < 20; attempt += 1) {
  if (natsSubjectCount("driveguard.urgent.dlq") > dlqCountBeforeInvalid) {
    dlqObserved = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
invariant(dlqObserved, "Invalid event was not published to the urgent DLQ");

const restart = event(`phase12-restart-${randomUUID()}`, "ROUTE_BLOCKED", {
  reasonCode: "ROAD_CLOSED",
});
psql(`insert into urgent_events (
  event_id,event_fingerprint,event_type,vehicle_id,severity,status,received_at,processed_at,correlation_id,
  processing_owner,processing_expires_at,attempt_count,result
) values (
  '${restart.eventId}','${urgentEventFingerprint(parseUrgentEvent(restart))}',
  'ROUTE_BLOCKED','simulator-vehicle-001','WARNING','PROCESSING',
  '${restart.receivedAt}',null,'${restart.correlationId}','crashed-owner',
  clock_timestamp()+interval '4 seconds',1,'{"safeSummary":"simulated crashed owner"}'::jsonb
)`);
const duplicateMetricBefore = metricValue(
  await (await fetch(`${apiBaseUrl}/metrics`)).text(),
  "driveguard_urgent_event_duplicates_total",
);
publish(restart, { direct: true });
let leaseObserved = false;
for (let attempt = 0; attempt < 30; attempt += 1) {
  const metrics = await (await fetch(`${apiBaseUrl}/metrics`)).text();
  if (metricValue(metrics, "driveguard_urgent_event_duplicates_total") > duplicateMetricBefore) {
    leaseObserved = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
invariant(leaseObserved, "Active durable lease was not observed before restart");
compose(["restart", "api"]);
await waitFor(`${apiBaseUrl}/health/ready`);
const restartRecord = await pollUrgent(restart.eventId, ["REPLAN_REQUIRED"], 120);
invariant(restartRecord.status === "REPLAN_REQUIRED", "Restarted consumer did not recover event");
invariant(
  psql(`select attempt_count from urgent_events where event_id='${restart.eventId}'`) === "2",
  "Restart recovery did not reacquire durable ownership exactly once",
);

const hmiHistory = await requestJson(`${hmiBaseUrl}/api/v1/urgent-events`, {
  headers: identityHeaders,
});
invariant(
  hmiHistory.data?.some((record) => record.eventId === lowSoc.eventId),
  "HMI urgent history does not include LOW_SOC",
);
invariant(!JSON.stringify(hmiHistory).includes("reportedSoc"), "Raw event payload leaked to HMI");

const metrics = await (await fetch(`${apiBaseUrl}/metrics`)).text();
for (const name of [
  "driveguard_urgent_events_total",
  "driveguard_urgent_event_processing_duration_seconds",
  "driveguard_urgent_event_duplicates_total",
]) {
  invariant(metrics.includes(name), `Required urgent metric is missing: ${name}`);
}
for (const forbidden of [lowSoc.eventId, fault.eventId, restart.eventId, secretSentinel]) {
  invariant(!metrics.includes(forbidden), "Identifier or secret leaked to Prometheus labels");
}

const logs = compose(["logs", "--no-color", "--no-log-prefix", "api"]);
invariant(!logs.includes(secretSentinel), "Invalid-event secret leaked to logs");
invariant(
  !logs.includes(lowSocNotification.data.confirmation_credential),
  "Confirmation credential leaked to logs",
);
invariant(
  !psql(`select result::text from urgent_events where event_id='${invalid.eventId}'`).includes(
    secretSentinel,
  ),
  "Invalid-event secret leaked to PostgreSQL result metadata",
);

process.stdout.write(
  `${JSON.stringify({
    status: "PASS",
    servicesHealthy: 8,
    lowSocFlow: "R2_CONFIRMED_EXECUTED",
    vehicleFaultFlow: "R3_CONFIRMATION_REQUIRED",
    duplicateEventSideEffects: 0,
    eventIdContentCollision: "REJECTED_TO_DLQ",
    invalidEventExecutions: 0,
    invalidEventDlq: "PASS",
    consumerRestartRecovery: "PASS",
    recoveredAttemptCount: 2,
    hmiNotification: "PASS",
    urgentMetrics: "PASS",
    secretLeakageCount: 0,
    highCardinalityMetricLabelCount: 0,
  })}\n`,
);
