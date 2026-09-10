import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import { buildApi } from "../../apps/api/src/app.js";
import { createFakeApiHarness } from "../fixtures/phase10-api.js";

function percentile(values: readonly number[], fraction: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * fraction) - 1] ?? Number.POSITIVE_INFINITY;
}

describe("Phase 10 lightweight non-LLM API performance smoke", () => {
  it("measures 300 valid local requests below the P95/P99 gate with zero errors", async () => {
    const harness = createFakeApiHarness();
    await harness.service.createSession(
      { userId: "user:performance", vehicleId: "vehicle:performance" },
      "session:performance",
    );
    const app = buildApi({ service: harness.service });
    await app.ready();
    const headers = {
      "x-driveguard-user-id": "user:performance",
      "x-driveguard-vehicle-id": "vehicle:performance",
    };
    for (let index = 0; index < 20; index += 1) {
      await app.inject({ method: "GET", url: "/v1/sessions/session:performance", headers });
    }
    const durations: number[] = [];
    let errors = 0;
    for (let index = 0; index < 300; index += 1) {
      const started = performance.now();
      const response = await app.inject({
        method: "GET",
        url: "/v1/sessions/session:performance",
        headers,
      });
      durations.push(performance.now() - started);
      if (response.statusCode !== 200) errors += 1;
    }
    await app.close();
    const p95Ms = percentile(durations, 0.95);
    const p99Ms = percentile(durations, 0.99);
    process.stdout.write(
      `PHASE10_API_PERFORMANCE ${JSON.stringify({ requestCount: 300, p95Ms, p99Ms, errors })}\n`,
    );
    expect(errors).toBe(0);
    expect(p95Ms).toBeLessThan(100);
    expect(p99Ms).toBeLessThan(250);
  });
});
