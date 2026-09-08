import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { buildApi } from "../../apps/api/src/app.js";
import { RequestAdmissionController } from "../../apps/api/src/admission-control.js";
import { ExecutionConcurrencyController } from "../../packages/executor/src/concurrency.js";

const apps: ReturnType<typeof buildApi>[] = [];
const k6Source = readFileSync(new URL("../scripts/k6-load.js", import.meta.url), "utf8");

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("Phase 14 production load identity", () => {
  it("uses the configured production Simulator identity for every VU", () => {
    expect(k6Source).toContain(
      'const simulatorVehicleId = __ENV.SIMULATOR_VEHICLE_ID || "simulator-vehicle-001";',
    );
    expect(k6Source).toContain('"x-driveguard-vehicle-id": simulatorVehicleId');
    expect(k6Source).not.toContain("phase14-vehicle:");
  });

  it("passes setup-created session identity into each isolated k6 VU", () => {
    expect(k6Source).toContain("sessions.push({ id, userId })");
    expect(k6Source).toContain("export default function (data)");
    expect(k6Source).toContain(
      "const context = suppliedContext || requestSessionContext(data, index)",
    );
    expect(k6Source).toContain("`${baseUrl}/v1/sessions/${context.id}/messages`");
    expect(k6Source).toContain("identity(index, context.userId)");
  });

  it("classifies controlled overload responses as valid load contracts", () => {
    expect(k6Source).toContain(
      "function sendMessage(data, prompt, acceptedStatuses = [200, 429, 503], suppliedContext)",
    );
  });

  it("supports isolated fresh-session and same-session diagnosis with explicit error counters", () => {
    expect(k6Source).toContain('const sessionMode = __ENV.SESSION_MODE || "per_vu"');
    expect(k6Source).toContain('const unexpectedHttp500 = new Counter("unexpected_http_500")');
    expect(k6Source).toContain('const externalSessionBusy = new Counter("external_session_busy")');
    expect(k6Source).toContain('sessionMode === "per_iteration"');
    expect(k6Source).toContain("requestSessionContext(data, index)");
  });

  it("routes the multi-Tool fixture to both trusted read tools", () => {
    expect(k6Source).toContain(
      "Get current vehicle state and current trip state. phase14:multi_tool",
    );
  });

  it("records stale-context replanning as a safe protected-action outcome", () => {
    expect(k6Source).toContain('const safeReplan = new Counter("safe_replan")');
    expect(k6Source).toContain("[200, 409, 429, 503]");
    expect(k6Source).toContain("safeReplan.add(1)");
  });
});

async function eventually(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not reached");
}

describe("Phase 14 bounded request admission", () => {
  it("bounds the FIFO queue and returns controlled busy responses", async () => {
    const controller = new RequestAdmissionController({
      maxConcurrent: 1,
      maxQueue: 1,
      queueTimeoutMs: 1_000,
    });
    const app = buildApi({ admissionController: controller });
    apps.push(app);
    let release: (() => void) | undefined;
    app.get("/v1/hold", async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ok: true };
    });

    const first = app.inject({ method: "GET", url: "/v1/hold" });
    await eventually(() => controller.snapshot().active === 1);
    const queued = app.inject({ method: "GET", url: "/v1/hold" });
    await eventually(() => controller.snapshot().queued === 1);
    const rejected = await app.inject({ method: "GET", url: "/v1/hold" });

    expect(rejected.statusCode).toBe(503);
    expect(rejected.headers["retry-after"]).toBe("1");
    expect(rejected.json()).toEqual({
      error: {
        code: "SERVICE_BUSY",
        message: "Service capacity is temporarily unavailable",
      },
    });
    expect((await app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);

    release?.();
    await first;
    await eventually(() => controller.snapshot().active === 1);
    release?.();
    expect((await queued).statusCode).toBe(200);
    expect(controller.snapshot()).toMatchObject({ active: 0, queued: 0, rejected: 1 });
  });

  it("fails queued and new stateful work closed during shutdown", async () => {
    const controller = new RequestAdmissionController({
      maxConcurrent: 1,
      maxQueue: 2,
      queueTimeoutMs: 1_000,
    });
    const first = await controller.acquire();
    expect(first.admitted).toBe(true);
    const queued = controller.acquire();
    controller.beginShutdown();

    expect(await queued).toEqual({ admitted: false, reason: "SHUTTING_DOWN" });
    expect(await controller.acquire()).toEqual({ admitted: false, reason: "SHUTTING_DOWN" });
    if (first.admitted) first.permit.release();
    expect(controller.snapshot()).toMatchObject({ accepting: false, active: 0, queued: 0 });
  });

  it("times out queued work without leaking capacity", async () => {
    const controller = new RequestAdmissionController({
      maxConcurrent: 1,
      maxQueue: 1,
      queueTimeoutMs: 5,
    });
    const owner = await controller.acquire();
    const queued = await controller.acquire();
    expect(queued).toEqual({ admitted: false, reason: "QUEUE_TIMEOUT" });
    if (owner.admitted) owner.permit.release();
    expect(controller.snapshot()).toMatchObject({ active: 0, queued: 0, rejected: 1 });
  });
});

describe("Phase 14 bounded Executor concurrency", () => {
  it("caps reads at four while preserving completion", async () => {
    const controller = new ExecutionConcurrencyController({
      maxReadConcurrency: 4,
      maxWriteConcurrency: 2,
      maxQueue: 20,
      queueTimeoutMs: 1_000,
    });
    let maximum = 0;
    const operations = Array.from({ length: 20 }, async (_value, index) => {
      const admission = await controller.acquire({
        sideEffect: false,
        vehicleId: `vehicle:${index}`,
      });
      expect(admission.admitted).toBe(true);
      if (!admission.admitted) return;
      maximum = Math.max(maximum, controller.snapshot().readActive);
      await new Promise((resolve) => setTimeout(resolve, 2));
      admission.permit.release();
    });
    await Promise.all(operations);
    expect(maximum).toBe(4);
    expect(controller.snapshot()).toMatchObject({ readActive: 0, queued: 0, rejected: 0 });
  });

  it("serializes same-vehicle side effects and bounds global writes", async () => {
    const controller = new ExecutionConcurrencyController({
      maxReadConcurrency: 4,
      maxWriteConcurrency: 3,
      maxQueue: 100,
      queueTimeoutMs: 1_000,
    });
    const perVehicle = new Map<string, number>();
    let duplicateVehicleOverlap = 0;
    let maximumWrites = 0;
    let effects = 0;
    await Promise.all(
      Array.from({ length: 60 }, async (_value, index) => {
        const vehicleId = `vehicle:${index % 6}`;
        const admission = await controller.acquire({ sideEffect: true, vehicleId });
        expect(admission.admitted).toBe(true);
        if (!admission.admitted) return;
        const active = (perVehicle.get(vehicleId) ?? 0) + 1;
        perVehicle.set(vehicleId, active);
        if (active > 1) duplicateVehicleOverlap += 1;
        maximumWrites = Math.max(maximumWrites, controller.snapshot().writeActive);
        await new Promise((resolve) => setTimeout(resolve, 1));
        effects += 1;
        perVehicle.set(vehicleId, active - 1);
        admission.permit.release();
      }),
    );
    expect(effects).toBe(60);
    expect(duplicateVehicleOverlap).toBe(0);
    expect(maximumWrites).toBe(3);
    expect(controller.snapshot()).toMatchObject({ writeActive: 0, queued: 0, rejected: 0 });
  });

  it("rejects over-capacity work explicitly and validates configuration", async () => {
    const controller = new ExecutionConcurrencyController({
      maxReadConcurrency: 1,
      maxWriteConcurrency: 1,
      maxQueue: 1,
      queueTimeoutMs: 1_000,
    });
    const owner = await controller.acquire({ sideEffect: true, vehicleId: "vehicle:1" });
    const waiting = controller.acquire({ sideEffect: true, vehicleId: "vehicle:1" });
    const rejected = await controller.acquire({ sideEffect: true, vehicleId: "vehicle:2" });
    expect(rejected).toEqual({ admitted: false, reason: "QUEUE_FULL" });
    if (owner.admitted) owner.permit.release();
    const next = await waiting;
    if (next.admitted) next.permit.release();
    expect(controller.snapshot()).toMatchObject({ writeActive: 0, queued: 0, rejected: 1 });
    expect(() => new ExecutionConcurrencyController({ maxReadConcurrency: 0 })).toThrow(TypeError);
  });
});
