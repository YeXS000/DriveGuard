import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
  createProductionDriveGuardRuntime,
  DEFAULT_PHASE_5_CAPABILITIES,
  DEFAULT_PHASE_5_SERVICES,
} from "@driveguard/agent-runtime";
import { buildVehicleSimulator } from "@driveguard/vehicle-simulator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const simulator = buildVehicleSimulator();
let baseUrl = "";

beforeAll(async () => {
  baseUrl = await simulator.listen({ host: "127.0.0.1", port: 0 });
});

afterAll(async () => {
  await simulator.close();
});

describe("Phase 15.1 bounded runtime retention", () => {
  it("bounds duplicate-detection identities under a long same-session run", async () => {
    const faux = fauxProvider({ provider: "phase15-retention", api: "phase15-retention-api" });
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime = createProductionDriveGuardRuntime({
      model: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
      simulatorBaseUrl: baseUrl,
      vehicleId: "vehicle:retention",
      capabilities: DEFAULT_PHASE_5_CAPABILITIES,
      serviceAvailability: DEFAULT_PHASE_5_SERVICES,
      user: { userId: "user:retention" as never, role: "driver" },
    });

    for (let index = 0; index < 320; index += 1) {
      faux.setResponses([fauxAssistantMessage("ready")]);
      await runtime.run({ sessionId: "session:retention", prompt: `status ${index}` });
    }

    expect(runtime.retentionSnapshot()).toMatchObject({
      sessions: 1,
      issuedRunIds: 256,
      issuedTraceIds: 256,
      cancelledRunIds: 0,
      executionRecords: 0,
      idempotencyEntries: 0,
    });
    expect(runtime.retentionSnapshot().issuedEventIds).toBeLessThanOrEqual(2_048);
    expect(runtime.sessionSnapshot("session:retention")?.messageCount).toBeLessThanOrEqual(40);
  });
});
