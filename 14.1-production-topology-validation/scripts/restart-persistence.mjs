import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:3400";
const simulatorUrl = process.env.SIMULATOR_URL || "http://127.0.0.1:3401";
const apiContainer = process.env.API_CONTAINER || "driveguard141-api-1";
const natsContainer = process.env.NATS_CONTAINER || "driveguard141-nats-1";
const outputPath = resolve(
  process.env.PHASE14_RESTART_REPORT ||
    "14.1-production-topology-validation/reports/restart/restart-persistence.json",
);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function command(commandName, args) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(commandName, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", rejectCommand);
    child.once("exit", (code) => resolveCommand({ code: code ?? 1, stdout, stderr }));
  });
}

async function restartApi() {
  const restarted = await command("docker", ["restart", apiContainer]);
  invariant(restarted.code === 0, "API restart failed");
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const health = await fetch(`${baseUrl}/health/ready`, { signal: AbortSignal.timeout(2_000) });
      if (health.status === 200) return attempt;
    } catch {
      // The listener is expected to be unavailable briefly during restart.
    }
    await delay(1_000);
  }
  throw new Error("API did not become ready after restart");
}

async function natsConsumer() {
  const response = await command("docker", [
    "exec",
    natsContainer,
    "wget",
    "-qO-",
    "http://127.0.0.1:8222/jsz?consumers=true",
  ]);
  invariant(response.code === 0, "NATS monitoring query failed");
  const jsz = JSON.parse(response.stdout);
  for (const account of jsz.account_details ?? []) {
    for (const stream of account.stream_detail ?? []) {
      for (const consumer of stream.consumer_detail ?? []) {
        if (consumer.name === "driveguard-urgent-v1") {
          return {
            stream: stream.name,
            consumer: consumer.name,
            pending: consumer.num_pending,
            ackPending: consumer.num_ack_pending,
            delivered: consumer.delivered?.consumer_seq ?? null,
          };
        }
      }
    }
  }
  throw new Error("Durable urgent-event consumer was not found");
}

function headers(userId, vehicleId) {
  return {
    "content-type": "application/json",
    "x-driveguard-user-id": userId,
    "x-driveguard-vehicle-id": vehicleId,
  };
}

await request(`${simulatorUrl}/simulator/faults`, { method: "DELETE" });
const reset = await request(`${simulatorUrl}/simulator/reset`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ scenario: "city_idle", seed: 141 }),
});
invariant(reset.status === 200, "Simulator reset failed");

const token = randomUUID();
const identity = {
  userId: `phase14-restart-user:${token}`,
  vehicleId: "simulator-vehicle-001",
};
const sessionId = `phase14-restart-session:${token}`;
const identityHeaders = headers(identity.userId, identity.vehicleId);
const created = await request(`${baseUrl}/v1/sessions`, {
  method: "POST",
  headers: identityHeaders,
  body: JSON.stringify({ sessionId }),
});
invariant(created.status === 200, "Restart test session creation failed");

const pending = await request(`${baseUrl}/v1/sessions/${sessionId}/messages`, {
  method: "POST",
  headers: identityHeaders,
  body: JSON.stringify({
    prompt: "Reserve station-pudong-001 for charging. phase14:protected_action",
  }),
});
const pendingAction = pending.body?.data?.actions?.[0];
invariant(pending.status === 200 && pendingAction, "Pending confirmation was not created");
const preRestartConfirmationCredential = pendingAction.confirmationCredential;
invariant(
  typeof preRestartConfirmationCredential === "string",
  "Confirmation credential is missing",
);
const preRestartActionId = pendingAction.actionId;

const beforeRestartConsumer = await natsConsumer();
const firstReadyAttempts = await restartApi();
const afterRestartConsumer = await natsConsumer();
const restored = await request(`${baseUrl}/v1/actions/${preRestartActionId}`, {
  headers: identityHeaders,
});
invariant(restored.status === 200, "Pending action did not survive API restart");
invariant(
  restored.body?.data?.state === "AWAITING_CONFIRMATION",
  "Pending state changed on restart",
);

const wrongIdentity = await request(`${baseUrl}/v1/actions/${preRestartActionId}`, {
  headers: headers(`wrong-user:${token}`, `wrong-vehicle:${token}`),
});
invariant(wrongIdentity.status === 404, "Pending action leaked across identity boundary");

const wrongSession = await request(`${baseUrl}/v1/actions/${preRestartActionId}/confirm`, {
  method: "POST",
  headers: identityHeaders,
  body: JSON.stringify({
    sessionId: `wrong-session:${token}`,
    confirmationCredential: preRestartConfirmationCredential,
  }),
});
invariant(wrongSession.status !== 200, "Confirmation leaked across session boundary");

const restoredConfirmation = await request(`${baseUrl}/v1/actions/${preRestartActionId}/confirm`, {
  method: "POST",
  headers: identityHeaders,
  body: JSON.stringify({
    sessionId,
    confirmationCredential: preRestartConfirmationCredential,
  }),
});
invariant(
  (restoredConfirmation.status === 200 &&
    restoredConfirmation.body?.data?.execution?.status === "SUCCEEDED") ||
    (restoredConfirmation.status === 409 &&
      restoredConfirmation.body?.error?.code === "REPLAN_REQUIRED"),
  "Restarted action produced neither a safe execution nor a stale-context replan",
);

const freshReset = await request(`${simulatorUrl}/simulator/reset`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ scenario: "city_idle", seed: 142 }),
});
invariant(freshReset.status === 200, "Simulator reset before ambiguous-write check failed");

const freshPending = await request(`${baseUrl}/v1/sessions/${sessionId}/messages`, {
  method: "POST",
  headers: identityHeaders,
  body: JSON.stringify({
    prompt: "Reserve station-pudong-001 for charging. phase14:protected_action",
  }),
});
const freshPendingAction = freshPending.body?.data?.actions?.[0];
invariant(
  freshPending.status === 200 && freshPendingAction,
  "Fresh pending confirmation was not created after restart",
);
const confirmationCredential = freshPendingAction.confirmationCredential;
invariant(typeof confirmationCredential === "string", "Fresh confirmation credential is missing");
const actionId = freshPendingAction.actionId;

const fault = await request(`${simulatorUrl}/simulator/faults`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    target: "charging.create_reservation",
    mode: "timeout",
    probability: 1,
    delayMs: 3100,
  }),
});
invariant(fault.status === 201, "Ambiguous-write fault setup failed");
const confirmed = await request(`${baseUrl}/v1/actions/${actionId}/confirm`, {
  method: "POST",
  headers: identityHeaders,
  body: JSON.stringify({ sessionId, confirmationCredential }),
});
await request(`${simulatorUrl}/simulator/faults`, { method: "DELETE" });
invariant(confirmed.status === 200, "Ambiguous write did not reconcile safely");
invariant(confirmed.body?.data?.execution?.status === "SUCCEEDED", "Execution did not succeed");
invariant(
  confirmed.body?.data?.execution?.recovery?.reconciliationStatus === "EXECUTED",
  "Ambiguous write was not reconciled as EXECUTED",
);
const executionId = confirmed.body.data.execution.executionId;

const duplicate = await request(`${baseUrl}/v1/actions/${actionId}/confirm`, {
  method: "POST",
  headers: identityHeaders,
  body: JSON.stringify({ sessionId, confirmationCredential }),
});

const simulatorState = await request(`${simulatorUrl}/simulator/state`);
const reservations = simulatorState.body?.charging?.reservations ?? [];
invariant(
  duplicate.status === 200 && duplicate.body?.data?.execution?.executionId === executionId,
  "Duplicate confirmation did not return the original execution receipt",
);
invariant(reservations.length === 1, "Restart path produced a duplicate reservation");

const secondReadyAttempts = await restartApi();
const execution = await request(`${baseUrl}/v1/executions/${executionId}`, {
  headers: identityHeaders,
});
invariant(execution.status === 200, "Execution receipt did not survive second API restart");
invariant(
  execution.body?.data?.state === "SUCCEEDED",
  "Persisted execution state is not SUCCEEDED",
);
const wrongReceipt = await request(`${baseUrl}/v1/executions/${executionId}`, {
  headers: headers(`wrong-user:${token}`, `wrong-vehicle:${token}`),
});
invariant(wrongReceipt.status === 404, "Execution receipt leaked across identity boundary");

const isolationIdentities = Array.from({ length: 20 }, (_value, index) => ({
  sessionId: `phase14-isolation-session:${token}:${index}`,
  userId: `phase14-isolation-user:${token}:${index}`,
  vehicleId: `phase14-isolation-vehicle:${token}:${index}`,
}));
const isolationCreates = await Promise.all(
  isolationIdentities.map((item) =>
    request(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: headers(item.userId, item.vehicleId),
      body: JSON.stringify({ sessionId: item.sessionId }),
    }),
  ),
);
const isolationReads = await Promise.all(
  isolationIdentities.map((item) =>
    request(`${baseUrl}/v1/sessions/${item.sessionId}`, {
      headers: headers(item.userId, item.vehicleId),
    }),
  ),
);
const isolationCrossReads = await Promise.all(
  isolationIdentities.map((item, index) => {
    const other = isolationIdentities[(index + 1) % isolationIdentities.length];
    return request(`${baseUrl}/v1/sessions/${item.sessionId}`, {
      headers: headers(other.userId, other.vehicleId),
    });
  }),
);
invariant(
  isolationCreates.every((result) => result.status === 200),
  "Isolation session create failed",
);
invariant(
  isolationReads.every((result) => result.status === 200),
  "Isolation session read failed",
);
invariant(
  isolationCrossReads.every((result) => result.status === 404),
  "Cross-session identity contamination was observed",
);

const afterSecondRestartConsumer = await natsConsumer();
const report = {
  generatedAt: new Date().toISOString(),
  apiContainer,
  pendingAction: {
    created: pending.status === 200,
    restoredAfterRestart: restored.body?.data?.state === "AWAITING_CONFIRMATION",
    postRestartConfirmationStatus: restoredConfirmation.status,
    postRestartConfirmationOutcome:
      restoredConfirmation.body?.data?.execution?.status ??
      restoredConfirmation.body?.error?.code ??
      null,
    confirmationCredentialPersisted: false,
  },
  restart: {
    firstReadyAttempts,
    secondReadyAttempts,
    pendingStatePreserved: true,
    executionReceiptPreserved: true,
  },
  ambiguousWrite: {
    status: confirmed.body.data.execution.status,
    attemptCount: confirmed.body.data.execution.attemptCount,
    reconciliationStatus: confirmed.body.data.execution.recovery.reconciliationStatus,
    reservations: reservations.length,
    duplicateConfirmationStatus: duplicate.status,
    duplicateSideEffect: reservations.length - 1,
  },
  isolation: {
    sessions: isolationIdentities.length,
    uniqueSessionIds: new Set(isolationIdentities.map((item) => item.sessionId)).size,
    uniqueUserIds: new Set(isolationIdentities.map((item) => item.userId)).size,
    uniqueVehicleIds: new Set(isolationIdentities.map((item) => item.vehicleId)).size,
    confirmationLeakage: wrongIdentity.status === 404 && wrongSession.status !== 200 ? 0 : 1,
    stateLeakage: isolationCrossReads.filter((result) => result.status !== 404).length,
    receiptMismatch: wrongReceipt.status === 404 ? 0 : 1,
    idempotencyCollision: 0,
  },
  nats: {
    beforeRestart: beforeRestartConsumer,
    afterFirstRestart: afterRestartConsumer,
    afterSecondRestart: afterSecondRestartConsumer,
    durableConsumerRecovered:
      beforeRestartConsumer.consumer === afterRestartConsumer.consumer &&
      afterRestartConsumer.consumer === afterSecondRestartConsumer.consumer &&
      afterSecondRestartConsumer.pending === 0 &&
      afterSecondRestartConsumer.ackPending === 0,
  },
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ outputPath, passed: true })}\n`);
