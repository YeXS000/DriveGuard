import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");
const routes = read("apps/api/src/routes.ts");
const service = read("apps/api/src/service.ts");
const hmi = read("apps/hmi/public/index.html");
const hmiScript = read("apps/hmi/public/app.js");
const hmiServer = read("infra/docker/hmi-server.mjs");
const compose = read("docker-compose.yml");

describe("Phase 10 architecture and HMI boundary", () => {
  it.each([
    ["POST /v1/sessions", '"/v1/sessions"'],
    ["GET /v1/sessions/:sessionId", '"/v1/sessions/:sessionId"'],
    ["POST messages", '"/v1/sessions/:sessionId/messages"'],
    ["POST message SSE", '"/v1/sessions/:sessionId/messages/stream"'],
    ["GET action", '"/v1/actions/:actionId"'],
    ["POST confirm", '"/v1/actions/:actionId/confirm"'],
    ["GET execution", '"/v1/executions/:executionId"'],
  ])("registers the required endpoint boundary: %s", (_name, marker) => {
    expect(routes).toContain(marker);
  });

  it.each([
    "run.started",
    "assistant.delta",
    "tool.requested",
    "policy.decision",
    "confirmation.required",
    "tool.completed",
    "assistant.completed",
    "run.failed",
  ])("defines the safe public SSE event %s", (eventType) => {
    expect(read("apps/api/src/events.ts")).toContain(`"${eventType}"`);
  });

  it.each([
    "Conversation",
    "Vehicle State",
    "Current Context",
    "Pending Confirmation",
    "Action Timeline",
    "Policy / Execution Result",
  ])("renders the required HMI region %s", (region) => {
    expect(hmi).toContain(region);
  });

  it("keeps HTTP routes free of database access", () => {
    expect(routes).not.toMatch(/\bpg\b|drizzle|\.query\(|\.select\(|\.insert\(|\.update\(/u);
  });

  it("keeps HTTP routes free of Simulator access", () => {
    expect(routes).not.toMatch(/SimulatorClient|vehicle-simulator|\/simulator\//u);
  });

  it("keeps the HMI free of direct Simulator calls", () => {
    expect(`${hmiScript}\n${hmiServer}`).not.toMatch(/vehicle-simulator|:3001|\/simulator\//u);
    expect(hmi).toContain("HMI never calls the Vehicle Simulator directly");
    expect(hmiScript).toContain('setExecution("Replan required"');
    expect(hmiScript).toContain('setExecution("Expired"');
    expect(hmiServer).toContain('req.once("aborted", destroyUpstream)');
    expect(hmiServer).toContain('res.once("close", destroyUpstream)');
  });

  it("routes confirmation through the formal Runtime and ConfirmationService", () => {
    expect(service).toContain("runtime.confirmAndExecute");
    expect(service).toContain("runtime.confirmationService.reject");
    expect(service).toContain("runtime.confirmationService.cancel");
    expect(service).not.toMatch(/action\.state\s*=(?!=)/u);
  });

  it("does not expose an RX capability in the API or HMI", () => {
    const surface = `${routes}\n${service}\n${hmi}\n${hmiScript}`;
    expect(surface).not.toMatch(
      /apply_brake|control_steering|set_throttle|disable_aeb|disable_esc/u,
    );
  });

  it("marks the development identity boundary on API and HMI", () => {
    expect(service).toContain("DEVELOPMENT_IDENTITY_BOUNDARY");
    expect(hmi).toContain("DEVELOPMENT_IDENTITY_BOUNDARY");
  });

  it("keeps NATS as infrastructure only with no Phase 10 business subject", () => {
    expect(compose).toContain("nats:");
    expect(`${routes}\n${service}`).not.toMatch(/jetstream|\.publish\(|\.subscribe\(/u);
  });

  it("keeps later additive phases free of benchmark orchestration", () => {
    const changedSurface = `${routes}\n${service}\n${hmiScript}`;
    expect(changedSurface).not.toMatch(/benchmark orchestrator/iu);
  });
});
