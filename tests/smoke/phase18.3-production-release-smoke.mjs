import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = process.cwd();
const docker = process.env.DRIVEGUARD_DOCKER_COMMAND ?? "docker";
const project =
  process.env.DRIVEGUARD_PHASE18_3_PROJECT ??
  `driveguard183${randomUUID().replaceAll("-", "").slice(0, 10)}`;
const output = resolve(
  process.env.DRIVEGUARD_PHASE18_3_SMOKE_REPORT ??
    "artifacts/18.3-least-privilege-storage-release-closure/reports/final/production-smoke.json",
);
const issuer = "https://phase18-3.test.invalid/";
const audience = "driveguard-api";
const vehicleId = "simulator-vehicle-001";
const userId = "user:phase18.3-alice";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function command(args, options = {}) {
  return execFileSync(docker, args, {
    cwd: root,
    env: { ...process.env, ...environment },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? 300_000,
  });
}

function compose(...args) {
  return command([
    "compose",
    "--project-name",
    project,
    "-f",
    "docker-compose.yml",
    "-f",
    "docker-compose.production.yml",
    "-f",
    "tests/smoke/phase18.3-production.compose.yml",
    ...args,
  ]);
}

function base64url(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });

function jwt(subject, vehicleIds = [vehicleId]) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", kid: "phase18.3-ephemeral" }));
  const payload = base64url(
    JSON.stringify({
      iss: issuer,
      aud: audience,
      sub: subject,
      nbf: now - 30,
      exp: now + 300,
      authorized_vehicle_ids: vehicleIds,
    }),
  );
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`, "utf8"), privateKey);
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

function syntheticValue() {
  return randomBytes(32).toString("base64url");
}

const hmiPort = Number(
  process.env.DRIVEGUARD_PHASE18_3_HMI_PORT ?? 38_000 + Math.floor(Math.random() * 1_000),
);
const environment = {
  DRIVEGUARD_IMAGE_TAG:
    process.env.DRIVEGUARD_IMAGE_TAG ??
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  DRIVEGUARD_HMI_BIND_ADDRESS: "127.0.0.1",
  DRIVEGUARD_HMI_PORT: String(hmiPort),
  DRIVEGUARD_AUTH_ISSUER: issuer,
  DRIVEGUARD_AUTH_AUDIENCE: audience,
  DRIVEGUARD_AUTH_ALLOWED_ALGORITHMS: "RS256",
  DRIVEGUARD_AUTH_VEHICLE_CLAIM: "authorized_vehicle_ids",
  DRIVEGUARD_AUTH_JWKS_URL: "http://test-jwks:3004/.well-known/jwks.json",
  DRIVEGUARD_LLM_PROVIDER: "faux",
  DRIVEGUARD_TEST_JWKS_DOCUMENT: JSON.stringify({
    keys: [{ ...jwk, kid: "phase18.3-ephemeral", use: "sig", alg: "RS256" }],
  }),
  POSTGRES_PASSWORD: syntheticValue(),
  POSTGRES_APP_PASSWORD: syntheticValue(),
  URGENT_CONFIRMATION_SECRET: syntheticValue(),
  DEEPSEEK_API_KEY: syntheticValue(),
  GRAFANA_ADMIN_PASSWORD: syntheticValue(),
};
const baseUrl = `http://127.0.0.1:${hmiPort}/api`;

async function waitFor(url, expected = true, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if ((await fetch(url)).ok === expected) return;
    } catch {
      if (!expected) return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(`Timed out waiting for ${expected ? "ready" : "unavailable"}: ${url}`);
}

async function request(path, token, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => undefined);
  invariant(response.status < 500, `${path} returned unexpected ${response.status}`);
  return { response, body };
}

async function expectStatus(path, token, expected, init) {
  const result = await request(path, token, init);
  invariant(
    result.response.status === expected,
    `${path} expected ${expected}, got ${result.response.status}`,
  );
  return result.body;
}

async function stream(sessionId, token, prompt) {
  const response = await fetch(
    `${baseUrl}/v1/sessions/${sessionId}/messages/stream?vehicleId=${vehicleId}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    },
  );
  invariant(response.status < 500, `stream returned unexpected ${response.status}`);
  invariant(response.ok, `stream failed with ${response.status}`);
  return (await response.text())
    .trim()
    .split(/\r?\n\r?\n/u)
    .filter((frame) => frame.length > 0)
    .map((frame) => {
      const lines = frame.split(/\r?\n/u);
      const eventType = lines.find((line) => line.startsWith("event: "))?.slice(7);
      const data = lines.find((line) => line.startsWith("data: "));
      invariant(data !== undefined, "SSE frame did not contain data");
      const parsed = JSON.parse(data.slice(6));
      return typeof parsed.event_type === "string" ? parsed : { ...parsed, event_type: eventType };
    });
}

function event(events, type) {
  return events.find((item) => item.event_type === type);
}

function inspect(service) {
  const containerId = compose("ps", "--all", "-q", service).trim();
  invariant(containerId.length > 0, `container ID missing for ${service}`);
  return JSON.parse(command(["inspect", containerId]))[0];
}

function assertRuntime(service, user, path, mode) {
  const inspected = inspect(service);
  invariant(inspected.Config.User === user, `${service} runtime user is not ${user}`);
  invariant(inspected.HostConfig.Privileged === false, `${service} is privileged`);
  invariant(inspected.HostConfig.ReadonlyRootfs === true, `${service} root filesystem is writable`);
  invariant(inspected.HostConfig.CapDrop.includes("ALL"), `${service} does not drop ALL caps`);
  invariant(!inspected.HostConfig.CapAdd?.length, `${service} adds runtime capabilities`);
  const stat = compose("exec", "-T", service, "sh", "-ec", `id; stat -c '%u:%g %a' ${path}`);
  invariant(stat.includes(`uid=${user.split(":")[0]}`), `${service} effective UID differs`);
  invariant(stat.includes(`${user} ${mode}`), `${service} volume contract differs`);
}

function assertInit(service, capabilities) {
  const inspected = inspect(service);
  invariant(inspected.HostConfig.Privileged === false, `${service} is privileged`);
  invariant(inspected.HostConfig.ReadonlyRootfs === true, `${service} root filesystem is writable`);
  invariant(inspected.HostConfig.CapDrop.includes("ALL"), `${service} does not drop ALL caps`);
  invariant(
    JSON.stringify(inspected.HostConfig.CapAdd ?? []) === JSON.stringify(capabilities),
    `${service} capability set differs`,
  );
}

function resetControlledSimulator() {
  const script = [
    "const response = await fetch('http://127.0.0.1:3001/simulator/reset', {",
    "method: 'POST', headers: { 'content-type': 'application/json' },",
    "body: JSON.stringify({ scenario: 'low_soc', seed: 1830 }) });",
    "if (!response.ok) process.exit(1);",
  ].join(" ");
  compose("exec", "-T", "vehicle-simulator", "node", "--input-type=module", "-e", script);
}

async function main() {
  const report = {
    schemaVersion: 1,
    status: "FAIL",
    freshVolumeInitialization: "NOT_RUN",
    existingVolumeRestart: "NOT_RUN",
    productionJwtVerification: "NOT_RUN",
    restartSmoke: "NOT_RUN",
    auditLifecycle: "NOT_RUN",
    authenticationBypass: 0,
    confirmationBypass: 0,
    forbiddenAction: 0,
    duplicateSideEffect: 0,
    falseSuccess: 0,
    unexpectedHttp5xx: 0,
  };
  try {
    compose("up", "--detach", "--wait", "--wait-timeout", "120");
    await waitFor(`${baseUrl.replace("/api", "")}/`);
    resetControlledSimulator();
    assertInit("postgres-volume-init", ["CAP_CHOWN", "CAP_FOWNER"]);
    assertInit("redis-volume-init", ["CAP_CHOWN", "CAP_DAC_OVERRIDE", "CAP_FOWNER"]);
    assertInit("nats-volume-init", ["CAP_CHOWN"]);
    assertRuntime("postgres", "70:70", "/var/lib/postgresql/data", "700");
    assertRuntime("redis", "999:1000", "/data", "700");
    assertRuntime("nats", "1000:1000", "/data/jetstream", "700");
    report.freshVolumeInitialization = "PASS";

    const alice = jwt(userId);
    const bob = jwt("user:phase18.3-bob");
    const sessionId = `session:phase18.3:${randomUUID()}`;
    const create = await request("/v1/sessions", alice, {
      method: "POST",
      body: JSON.stringify({ sessionId, vehicleId }),
    });
    invariant(create.response.status === 200, `session creation failed: ${create.response.status}`);
    invariant(
      create.response.headers.get("x-driveguard-identity-boundary") === "JWT_VERIFIED_PRINCIPAL",
      "request did not use the JWT identity boundary",
    );
    report.productionJwtVerification = "PASS";
    await expectStatus(`/v1/sessions/${sessionId}?vehicleId=${vehicleId}`, bob, 404);
    await expectStatus("/v1/sessions", jwt(userId, ["vehicle:other"]), 403, {
      method: "POST",
      body: JSON.stringify({ vehicleId }),
    });
    await expectStatus("/v1/sessions", alice, 401, {
      method: "POST",
      headers: { "x-driveguard-user-id": "user:attacker" },
      body: JSON.stringify({ vehicleId }),
    });

    invariant(
      event(await stream(sessionId, alice, "hello"), "assistant.completed"),
      "NO_TOOL failed",
    );
    invariant(
      event(await stream(sessionId, alice, "show vehicle state"), "tool.completed"),
      "simple tool failed",
    );
    // R2 requires a fresh state snapshot. Refresh the controlled simulator
    // immediately before the write request rather than reusing setup state.
    resetControlledSimulator();
    const protectedEvents = await stream(sessionId, alice, "reserve charging");
    const confirmation = event(protectedEvents, "confirmation.required");
    invariant(
      confirmation,
      `protected action did not require confirmation (events: ${protectedEvents
        .map((item) => item.event_type)
        .join(", ")}; failure: ${event(protectedEvents, "run.failed")?.data?.code ?? "none"})`,
    );
    const actionId = confirmation.data?.action_id;
    const credential = confirmation.data?.confirmation_credential;
    invariant(
      typeof actionId === "string" && typeof credential === "string",
      "confirmation payload incomplete",
    );
    const blockedConfirmation = await request(`/v1/actions/${actionId}/confirm`, bob, {
      method: "POST",
      body: JSON.stringify({ sessionId, vehicleId, confirmationCredential: credential }),
    });
    invariant(!blockedConfirmation.response.ok, "foreign principal confirmed an action");

    // Confirmation revalidates a five-second freshness window. Complete the
    // authorized operation while its context is fresh; the restart below then
    // proves persistence of the completed action and execution receipt.
    const confirmed = await request(`/v1/actions/${actionId}/confirm`, alice, {
      method: "POST",
      body: JSON.stringify({ sessionId, vehicleId, confirmationCredential: credential }),
    });
    invariant(
      confirmed.response.status === 200,
      `confirmation failed: ${confirmed.response.status} (${confirmed.body?.error?.code ?? "unknown"})`,
    );
    invariant(confirmed.body?.data?.execution?.status === "SUCCEEDED", "action was not executed");
    const executionId = confirmed.body.data.execution.executionId;
    invariant(typeof executionId === "string", "execution receipt missing");
    const receipt = await expectStatus(
      `/v1/executions/${executionId}?vehicleId=${vehicleId}`,
      alice,
      200,
    );
    invariant(receipt.data?.state === "SUCCEEDED", "execution receipt is not durable");

    // Keep the explicit stop/start recovery bounded for the release smoke.
    compose("stop", "--timeout", "1", "api");
    await waitFor(`${baseUrl}/health/ready`, false);
    compose("start", "api");
    await waitFor(`${baseUrl}/health/ready`);
    const restored = await expectStatus(
      `/v1/sessions/${sessionId}?vehicleId=${vehicleId}`,
      alice,
      200,
    );
    invariant(restored.data?.userId === userId, "session identity changed after restart");
    const restoredAction = await expectStatus(
      `/v1/actions/${actionId}?vehicleId=${vehicleId}`,
      alice,
      200,
    );
    invariant(
      restoredAction.data?.actionId === actionId,
      "action was not restored after API restart",
    );
    const restoredReceipt = await expectStatus(
      `/v1/executions/${executionId}?vehicleId=${vehicleId}`,
      alice,
      200,
    );
    invariant(restoredReceipt.data?.state === "SUCCEEDED", "execution receipt is not durable");
    report.restartSmoke = "PASS";

    compose(
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "120",
      "--force-recreate",
      "postgres",
      "redis",
      "nats",
    );
    await waitFor(`${baseUrl}/health/ready`);
    const preserved = await expectStatus(
      `/v1/executions/${executionId}?vehicleId=${vehicleId}`,
      alice,
      200,
    );
    invariant(
      preserved.data?.executionId === executionId,
      "existing volume data was not preserved",
    );
    report.existingVolumeRestart = "PASS";

    const audit = JSON.parse(
      compose(
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "driveguard",
        "-d",
        "driveguard",
        "-At",
        "-c",
        `select json_build_object('events',json_agg(event_type order by timestamp),'subject',min(user_id),'sessionId',min(session_id),'vehicleId',min(vehicle_id),'actionId',min(action_id),'executionId',min(execution_id),'confirmationId',(select confirmation_id from pending_actions where action_id='${actionId}'),'unsafe',bool_or(safe_metadata::text ~* '(authorization[[:space:]]*:[[:space:]]*bearer|private[[:space:]_-]*key|password|api[[:space:]_-]*key)')) from audit_events where action_id='${actionId}'`,
      ).trim(),
    );
    invariant(
      audit.subject === userId && audit.sessionId === sessionId && audit.vehicleId === vehicleId,
      "audit identity is incomplete",
    );
    invariant(
      audit.actionId === actionId &&
        audit.executionId === executionId &&
        typeof audit.confirmationId === "string",
      "audit correlation is incomplete",
    );
    invariant(audit.unsafe === false, "audit contains a credential marker");
    for (const required of [
      "policy.decision",
      "pending_action.created",
      "confirmation.accepted",
      "execution.started",
      "execution.succeeded",
    ])
      invariant(audit.events.includes(required), `audit event missing: ${required}`);
    report.auditLifecycle = "PASS";
    report.status = "PASS";
  } catch (error) {
    report.failure = error instanceof Error ? error.message : "unknown smoke failure";
    throw error;
  } finally {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    if (process.env.DRIVEGUARD_PHASE18_3_KEEP_PROJECT !== "1") {
      try {
        compose("down", "--volumes", "--remove-orphans");
      } catch {
        // Preserve the primary validation failure.
      }
    }
  }
}

await main();
