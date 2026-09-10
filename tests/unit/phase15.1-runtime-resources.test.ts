import { DriveGuardMetrics } from "@driveguard/observability";
import { describe, expect, it } from "vitest";

describe("Phase 15.1 retained-runtime diagnostics", () => {
  it("exports only bounded resource kinds and their current values", async () => {
    const metrics = new DriveGuardMetrics({ collectProcessMetrics: false });
    metrics.observeRuntimeResources({
      activeRequests: 3,
      runtimes: 20,
      sessions: 20,
      contextBytes: 12_345,
      issuedRunIds: 5_120,
      issuedTraceIds: 5_120,
      issuedEventIds: 40_960,
      cancelledRunIds: 0,
      executionRecords: 0,
      idempotencyEntries: 0,
    });

    const text = await metrics.metrics();
    expect(text).toContain('driveguard_runtime_retained{kind="activeRequests"} 3');
    expect(text).toContain('driveguard_runtime_retained{kind="runtimes"} 20');
    expect(text).toContain('driveguard_runtime_retained{kind="contextBytes"} 12345');
    expect(text).toContain('driveguard_runtime_retained{kind="executionRecords"} 0');
    expect(text).toContain('driveguard_runtime_retained{kind="idempotencyEntries"} 0');
    expect(text).not.toMatch(/sessionId=|runId=|traceId=/u);
  });
});
