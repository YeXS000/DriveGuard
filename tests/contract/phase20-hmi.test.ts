import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildApi } from "../../apps/api/src/app.js";
import { createFakeApiHarness } from "../fixtures/phase10-api.js";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");
const html = read("apps/hmi/public/index.html");
const css = read("apps/hmi/public/styles.css");
const appScript = read("apps/hmi/public/app.js");

describe("Phase 20 final HMI contract", () => {
  it("renders the professional cockpit information architecture", () => {
    for (const marker of [
      "DriveGuard",
      "Assistant",
      "Vehicle State",
      "Trip &amp; navigation",
      "Charging",
      "System health",
      "Execution receipt",
    ]) {
      expect(html).toContain(marker);
    }
    expect(html).toContain('id="global-alert"');
    expect(html).toContain('id="vehicle-loading"');
    expect(css).toContain("@media (max-width: 820px)");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("prefers-reduced-motion");
  });

  it("keeps confirmation as a dedicated, explicit lifecycle card", () => {
    for (const marker of [
      "Protected action",
      "Action",
      "Target",
      "Risk",
      "Reason",
      "Confirm action",
      "Cancel",
    ]) {
      expect(html).toContain(marker);
    }
    for (const state of ["pending", "confirmed", "executing", "completed", "failed"]) {
      expect(`${html}\n${css}\n${appScript}`).toContain(state);
    }
    expect(appScript).toContain("confirmationCredential: action.confirmation_credential");
    expect(appScript).not.toMatch(/localStorage\.setItem\([^\n]*confirmation/iu);
  });

  it("shows bounded progress and maps safe failure states without false success", async () => {
    const model = await import("../../apps/hmi/public/ui-model.js");
    expect(model.errorPresentation("SERVICE_BUSY")).toMatchObject({
      retryable: true,
      tone: "info",
    });
    expect(model.errorPresentation("AUTHENTICATION_INVALID")).toMatchObject({ retryable: false });
    expect(model.errorPresentation("REPLAN_REQUIRED").title).toBe("Replan required");
    expect(model.executionPresentation({ status: "FAILED" }).successful).toBe(false);
    expect(model.executionPresentation({ status: "SUCCEEDED" }).successful).toBe(true);
    expect(appScript).toContain('delete $("global-alert").dataset.healthAlert');
    expect(`${html}\n${appScript}`).toContain("Understanding");
    expect(html).toContain("Checking vehicle");
    expect(`${html}\n${appScript}`).toContain("Failed / Replan required");
  });

  it("uses only the authenticated API proxy for context, session, stream, and confirmation", () => {
    expect(appScript).toContain("request(`/v1/context${sessionQuery()}`)");
    expect(appScript).toContain('request("/v1/sessions"');
    expect(appScript).toContain("/messages/stream");
    expect(appScript).toContain("/confirm");
    expect(`${html}\n${appScript}`).not.toMatch(/vehicle-simulator|:3001|\/simulator\//u);
    expect(appScript).not.toMatch(/fake|mock|demoSuccess|successPath/iu);
  });

  it("serves validated, identity-bound vehicle context through the real API boundary", async () => {
    const harness = createFakeApiHarness();
    const api = buildApi({ service: harness.service });
    await api.ready();
    try {
      const response = await api.inject({
        method: "GET",
        url: "/v1/context?vehicleId=vehicle:test",
        headers: {
          "x-driveguard-user-id": "user:test",
          "x-driveguard-vehicle-id": "vehicle:test",
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["x-driveguard-identity-boundary"]).toBe(
        "DEVELOPMENT_IDENTITY_BOUNDARY",
      );
      expect(response.json()).toMatchObject({
        data: {
          vehicle: { vehicleId: "vehicle:test", soc: 64 },
          trip: { navigationActive: true },
          simulationVersion: 4,
        },
      });
    } finally {
      await api.close();
    }
  });
});
