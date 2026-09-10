import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("Phase 12 urgent-event architecture boundaries", () => {
  it("keeps NATS transport separate from planning and direct Simulator mutation", () => {
    const nats = source("packages/urgent-events/src/nats.ts");
    expect(nats).not.toMatch(/SimulatorClient|fetch\(|\/simulator\//u);
    expect(nats).not.toMatch(/policyEngine\.evaluate|reliableExecutor\.execute/u);
  });

  it("routes action candidates through formal Tool, Policy, Confirmation, and Executor boundaries", () => {
    const dispatcher = source("packages/urgent-events/src/dispatcher.ts");
    expect(dispatcher).toContain("this.#registry.get");
    expect(dispatcher).toContain("this.#policyEngine.evaluate");
    expect(dispatcher).toContain("new ConfirmationService");
    expect(dispatcher).toContain("this.#reliableExecutor.execute");
  });

  it("contains no RX execution vocabulary in the Phase 12 implementation", () => {
    const implementation = [
      "packages/urgent-events/src/planner.ts",
      "packages/urgent-events/src/dispatcher.ts",
      "packages/urgent-events/src/factory.ts",
      "apps/api/src/urgent.ts",
    ]
      .map(source)
      .join("\n");
    expect(implementation).not.toMatch(
      /apply_brake|control_steering|set_throttle|disable_aeb|disable_esc/u,
    );
  });

  it("uses a durable pull consumer with explicit ACK and bounded delivery", () => {
    const nats = source("packages/urgent-events/src/nats.ts");
    expect(nats).toContain("durable_name: URGENT_NATS.durable");
    expect(nats).toContain("ack_policy: AckPolicy.Explicit");
    expect(nats).toContain("max_deliver: this.#maxDeliver");
    expect(nats).toContain("filter_subject: URGENT_NATS.urgentSubject");
  });

  it("stores only safe result metadata rather than an original event payload", () => {
    const migration = source("infra/db/migrations/0001_phase12_urgent_events.sql");
    expect(migration).toContain('"result" jsonb NOT NULL');
    expect(migration).not.toMatch(/payload|confirmation_credential|api_key/iu);
  });

  it("uses PostgreSQL eventId ownership as the durable deduplication authority", () => {
    const repository = source("packages/persistence/src/urgent-event.ts");
    expect(repository).toContain("on conflict (event_id) do nothing");
    expect(repository).toContain("processing_owner=$2");
    expect(repository).toContain("processing_expires_at <= $5");
    expect(repository).not.toMatch(/redis/iu);
  });

  it("keeps Prometheus labels bounded and free of request identities", () => {
    const metrics = source("packages/observability/src/metrics.ts");
    const urgentSection = metrics.slice(metrics.indexOf("driveguard_urgent_events_total"));
    for (const forbidden of ["eventId", "vehicleId", "sessionId", "runId", "traceId"]) {
      expect(urgentSection).not.toMatch(new RegExp(`labelNames:[^\\n]*${forbidden}`, "u"));
    }
  });

  it("exposes only safe urgent history fields to API clients", () => {
    const api = source("apps/api/src/urgent.ts");
    expect(api).toContain("safeSummary: record.result.safeSummary");
    expect(api).not.toMatch(/record\.payload|originalPayload|rawPayload/u);
  });

  it("does not introduce Phase 13 benchmark implementation", () => {
    const phase12 = [
      source("packages/urgent-events/src/index.ts"),
      source("apps/api/src/urgent.ts"),
      source("apps/hmi/public/app.js"),
    ].join("\n");
    expect(phase12).not.toMatch(/benchmark orchestrator|10,000-case.*urgent/iu);
  });
});
