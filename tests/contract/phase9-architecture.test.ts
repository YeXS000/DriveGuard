import { readFile } from "node:fs/promises";

import { createPhase9ProductionDriveGuardRuntime } from "@driveguard/agent-runtime";

import { describe, expect, it } from "vitest";

describe("Phase 9 architecture and security boundaries", () => {
  it("fails closed when the durable production binding object is incomplete", () => {
    expect(() =>
      createPhase9ProductionDriveGuardRuntime(
        {} as never,
        {
          pendingActionRepository: undefined,
        } as never,
      ),
    ).toThrow(/pendingActionRepository binding is required/u);
  });

  it.each(["apply_brake", "control_steering", "set_throttle", "disable_aeb", "disable_esc"])(
    "does not register forbidden RX capability %s in persistence or memory",
    async (name) => {
      const sources = await Promise.all([
        readFile("packages/persistence/src/index.ts", "utf8"),
        readFile("packages/memory/src/index.ts", "utf8"),
        readFile("infra/db/migrations/0000_phase9_persistence.sql", "utf8"),
      ]);
      expect(sources.join("\n")).not.toContain(name);
    },
  );

  it("keeps conversation memory free of VehicleState and TripState fields", async () => {
    const schema = await readFile("packages/persistence/src/schema.ts", "utf8");
    const memory = await readFile("packages/memory/src/types.ts", "utf8");
    expect(memory).not.toMatch(/VehicleState|TripState|soc|speedKph|routeId/u);
    const conversationSection = schema.slice(
      schema.indexOf("export const conversationMessages"),
      schema.indexOf("export const pendingActions"),
    );
    expect(conversationSection).not.toMatch(/vehicle|trip|contextSnapshot/u);
  });

  it("does not persist plaintext confirmation tokens, credentials, headers, or chain-of-thought", async () => {
    const sources = await Promise.all([
      readFile("packages/persistence/src/schema.ts", "utf8"),
      readFile("infra/db/migrations/0000_phase9_persistence.sql", "utf8"),
    ]);
    const text = sources.join("\n");
    expect(text).not.toMatch(/DEEPSEEK_API_KEY|api_key|authorization_header|chain_of_thought/iu);
    expect(text).not.toMatch(/confirmation_token/iu);
    expect(text).toContain("token_hash");
  });

  it("contains no Phase 10 API, HMI, urgent-event, or NATS workflow implementation", async () => {
    const files = await Promise.all([
      readFile("packages/persistence/src/index.ts", "utf8"),
      readFile("packages/memory/src/index.ts", "utf8"),
    ]);
    expect(files.join("\n")).not.toMatch(/HMI|UrgentEvent|NATS|Streaming API/iu);
  });
});
