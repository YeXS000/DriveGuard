import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApi } from "../../apps/api/src/app.js";
import type { DependencyProbe } from "../../apps/api/src/health.js";

const applications: ReturnType<typeof buildApi>[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map(async (application) => application.close()));
});

function createProbe(name: string, check: DependencyProbe["check"]): DependencyProbe {
  return { name, check };
}

describe("health endpoints", () => {
  it("reports process liveness without invoking dependency probes", async () => {
    const check = vi.fn(() => Promise.reject(new Error("dependency unavailable")));
    const application = buildApi({ dependencies: [createProbe("postgres", check)] });
    applications.push(application);

    const response = await application.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(check).not.toHaveBeenCalled();
  });

  it("reports readiness when every configured dependency is usable", async () => {
    const application = buildApi({
      dependencies: [
        createProbe("postgres", () => Promise.resolve()),
        createProbe("redis", () => Promise.resolve()),
        createProbe("nats_jetstream", () => Promise.resolve()),
      ],
    });
    applications.push(application);

    const response = await application.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ready",
      dependencies: [
        { name: "postgres", status: "up" },
        { name: "redis", status: "up" },
        { name: "nats_jetstream", status: "up" },
      ],
    });
  });

  it("fails readiness without exposing dependency error details", async () => {
    const application = buildApi({
      dependencies: [
        createProbe("postgres", () => Promise.reject(new Error("sensitive connection detail"))),
      ],
    });
    applications.push(application);

    const response = await application.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "not_ready",
      dependencies: [{ name: "postgres", status: "down" }],
    });
    expect(response.body).not.toContain("sensitive connection detail");
  });

  it("fails readiness when a dependency probe exceeds its timeout", async () => {
    const application = buildApi({
      dependencies: [createProbe("redis", () => new Promise(() => undefined))],
      dependencyTimeoutMs: 5,
    });
    applications.push(application);

    const response = await application.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "not_ready",
      dependencies: [{ name: "redis", status: "down" }],
    });
  });
});
