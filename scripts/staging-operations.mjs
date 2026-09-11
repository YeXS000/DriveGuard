import { execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const commandName = process.argv[2] ?? "help";
const workspace = process.cwd();
const dockerCommand = process.env.DRIVEGUARD_DOCKER_COMMAND ?? "docker";
const project = process.env.DRIVEGUARD_STAGING_PROJECT ?? "driveguard-phase17";
const artifactsRoot = resolve(
  process.env.DRIVEGUARD_PHASE17_ARTIFACTS ??
    "artifacts/17-staging-release-operational-readiness/reports",
);
const stateFile = resolve(artifactsRoot, "upgrade/durable-state.json");

function fail(message) {
  throw new Error(`Phase 17 staging operation: ${message}`);
}

function run(executable, args, options = {}) {
  return execFileSync(executable, args, {
    cwd: workspace,
    encoding: "utf8",
    stdio: options.stdio ?? "inherit",
    env: options.env ?? process.env,
  });
}

function capture(executable, args, env = process.env) {
  return execFileSync(executable, args, {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
  }).trim();
}

function assertProjectName(value) {
  if (!/^driveguard-phase17[a-z0-9_-]*$/u.test(value)) {
    fail("DRIVEGUARD_STAGING_PROJECT must start with driveguard-phase17");
  }
  return value;
}

function assertGitSha(value, label) {
  if (!/^[0-9a-f]{40}$/u.test(value)) fail(`${label} must be a full 40-character Git SHA`);
  try {
    capture("git", ["cat-file", "-e", `${value}^{commit}`]);
  } catch {
    fail(`${label} is not a commit available in this repository`);
  }
  return value;
}

function currentSha() {
  return capture("git", ["rev-parse", "HEAD"]);
}

function releaseSha(variableName = "DRIVEGUARD_RELEASE_SHA") {
  return assertGitSha(process.env[variableName] ?? currentSha(), variableName);
}

function compose(args, env = process.env) {
  return run(dockerCommand, ["compose", "--project-name", assertProjectName(project), ...args], {
    env,
  });
}

function composeCapture(args, env = process.env) {
  return capture(
    dockerCommand,
    ["compose", "--project-name", assertProjectName(project), ...args],
    env,
  );
}

function releaseEnvironment(sha) {
  if (dockerCommand.endsWith(".exe") && process.env.DRIVEGUARD_IMAGE_TAG !== sha) {
    fail(
      "when using docker.exe from WSL, set the Windows-host DRIVEGUARD_IMAGE_TAG to the same release SHA",
    );
  }
  return { ...process.env, DRIVEGUARD_IMAGE_TAG: sha, COMPOSE_PROJECT_NAME: project };
}

function assertDockerAvailable() {
  try {
    capture(dockerCommand, ["version", "--format", "{{.Server.Version}}"]);
  } catch {
    fail(
      "Docker Engine is unavailable; start Docker Engine and enable this environment before staging",
    );
  }
}

async function waitFor(url, label) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // A deployment may be briefly unavailable while Compose recreates services.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  fail(`${label} did not become ready: ${url}`);
}

function parseComposePs(raw) {
  if (raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

async function verifyReadiness() {
  const rows = parseComposePs(composeCapture(["ps", "--all", "--format", "json"]));
  const services = new Map(rows.map((row) => [row.Service, row]));
  for (const name of ["postgres", "redis", "nats", "vehicle-simulator", "api", "hmi"]) {
    if (services.get(name)?.State !== "running")
      fail(`${name} is not running according to Compose`);
  }
  const migration = services.get("persistence-migrate");
  if (migration?.State !== "exited" || migration?.ExitCode !== 0) {
    fail("persistence-migrate did not complete successfully");
  }
  await waitFor(process.env.DRIVEGUARD_API_BASE_URL ?? "http://127.0.0.1:3000/health/ready", "API");
  await waitFor(process.env.DRIVEGUARD_HMI_BASE_URL ?? "http://127.0.0.1:3002", "HMI");
  await waitFor(
    process.env.SIMULATOR_BASE_URL ?? "http://127.0.0.1:3001/health/ready",
    "simulator",
  );
  process.stdout.write(`${JSON.stringify({ status: "PASS", operation: "readiness", project })}\n`);
}

function startRelease(sha, forceRecreate = false) {
  const args = [
    "--profile",
    "observability",
    "up",
    "--detach",
    "--wait",
    "--wait-timeout",
    "90",
    "--pull",
    "never",
    "--no-build",
  ];
  if (forceRecreate) args.push("--force-recreate");
  compose(args, releaseEnvironment(sha));
}

function runDurableSmoke(mode) {
  run("node", ["tests/smoke/phase17-durable-state-smoke.mjs", mode], {
    env: { ...process.env, DRIVEGUARD_PHASE17_STATE_FILE: stateFile },
  });
}

function help() {
  process.stdout.write(`Usage: npm run staging:operations -- <command>\n\n`);
  process.stdout.write(
    "Commands: build, fresh-deploy, deploy, readiness, smoke, upgrade, rollback\n",
  );
  process.stdout.write(
    "All release tags are full Git SHAs. fresh-deploy requires DRIVEGUARD_ALLOW_CLEAN_RESET=1.\n",
  );
}

assertProjectName(project);

switch (commandName) {
  case "help":
  case "--help":
  case "-h":
    help();
    break;
  case "build": {
    assertDockerAvailable();
    const sha = releaseSha();
    const buildArgs = ["build"];
    if (process.env.DRIVEGUARD_PULL_BASE_IMAGES === "1") buildArgs.push("--pull");
    buildArgs.push("api", "vehicle-simulator", "hmi");
    compose(buildArgs, releaseEnvironment(sha));
    await mkdir(artifactsRoot, { recursive: true });
    run("node", ["scripts/release-manifest.mjs"], {
      env: {
        ...releaseEnvironment(sha),
        DRIVEGUARD_CAPTURE_IMAGE_DIGESTS: "1",
        DRIVEGUARD_DOCKER_VERSION: capture(dockerCommand, [
          "version",
          "--format",
          "{{.Server.Version}}",
        ]),
        DRIVEGUARD_RELEASE_MANIFEST: resolve(
          artifactsRoot,
          "final/release-candidate-manifest.json",
        ),
      },
    });
    break;
  }
  case "fresh-deploy": {
    assertDockerAvailable();
    if (process.env.DRIVEGUARD_ALLOW_CLEAN_RESET !== "1") {
      fail(
        "fresh-deploy removes only this project's named volumes; set DRIVEGUARD_ALLOW_CLEAN_RESET=1",
      );
    }
    const sha = releaseSha();
    compose(
      ["--profile", "observability", "down", "--volumes", "--remove-orphans"],
      releaseEnvironment(sha),
    );
    startRelease(sha, true);
    await verifyReadiness();
    break;
  }
  case "deploy": {
    assertDockerAvailable();
    const sha = releaseSha();
    startRelease(sha, true);
    await verifyReadiness();
    break;
  }
  case "readiness":
    assertDockerAvailable();
    await verifyReadiness();
    break;
  case "smoke":
    assertDockerAvailable();
    run("node", ["tests/smoke/phase16-release-smoke.mjs"], {
      env: { ...process.env, COMPOSE_PROJECT_NAME: project },
    });
    break;
  case "upgrade": {
    assertDockerAvailable();
    const from = releaseSha("DRIVEGUARD_RELEASE_N_SHA");
    const to = releaseSha("DRIVEGUARD_RELEASE_N_PLUS_1_SHA");
    await mkdir(resolve(artifactsRoot, "upgrade"), { recursive: true });
    await rm(stateFile, { force: true });
    startRelease(from, true);
    await verifyReadiness();
    runDurableSmoke("prepare");
    startRelease(to, true);
    await verifyReadiness();
    runDurableSmoke("verify");
    break;
  }
  case "rollback": {
    assertDockerAvailable();
    const knownGood = releaseSha("DRIVEGUARD_KNOWN_GOOD_SHA");
    const simulatedFailureTag = `phase17-intentional-missing-${Date.now()}`;
    await mkdir(resolve(artifactsRoot, "rollback"), { recursive: true });
    await rm(stateFile, { force: true });
    startRelease(knownGood, true);
    await verifyReadiness();
    runDurableSmoke("prepare");
    let failedAsExpected = false;
    try {
      startRelease(simulatedFailureTag, true);
    } catch {
      failedAsExpected = true;
    }
    if (!failedAsExpected) fail("simulated missing-image release unexpectedly deployed");
    startRelease(knownGood, true);
    await verifyReadiness();
    runDurableSmoke("verify");
    process.stdout.write(
      `${JSON.stringify({ status: "PASS", operation: "rollback", simulatedFailureTag })}\n`,
    );
    break;
  }
  default:
    fail(`unknown command ${commandName}`);
}
