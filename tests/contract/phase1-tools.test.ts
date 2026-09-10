import { describe, expect, it } from "vitest";

import {
  createPhase1Tools,
  PHASE_1_FIXTURE_ONLY,
  PHASE_1_TRIP_STATE,
  PHASE_1_VEHICLE_STATE,
} from "../../packages/agent-runtime/src/index.js";

describe("Phase 1 read-only tool contracts", () => {
  it("registers exactly the two allowed business tools with closed empty schemas", () => {
    const tools = createPhase1Tools();

    expect(tools.map((tool) => tool.name)).toEqual(["get_vehicle_state", "get_trip_state"]);
    expect(tools).toHaveLength(2);
    for (const tool of tools) {
      expect(tool.label.length).toBeGreaterThan(0);
      expect(tool.description).toContain("PHASE_1_FIXTURE_ONLY");
      expect(tool.parameters).toMatchObject({
        type: "object",
        properties: {},
        additionalProperties: false,
      });
    }
  });

  it("returns the strongly structured vehicle fixture", async () => {
    const [tool] = createPhase1Tools();
    const result = await tool.execute("vehicle-call", {});

    expect(result.details).toEqual({
      source: PHASE_1_FIXTURE_ONLY,
      state: PHASE_1_VEHICLE_STATE,
    });
    expect(
      JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "null"),
    ).toEqual({
      source: PHASE_1_FIXTURE_ONLY,
      ...PHASE_1_VEHICLE_STATE,
    });
  });

  it("returns the strongly structured trip fixture", async () => {
    const [, tool] = createPhase1Tools();
    const result = await tool.execute("trip-call", {});

    expect(result.details).toEqual({
      source: PHASE_1_FIXTURE_ONLY,
      state: PHASE_1_TRIP_STATE,
    });
    expect(
      JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "null"),
    ).toEqual({
      source: PHASE_1_FIXTURE_ONLY,
      ...PHASE_1_TRIP_STATE,
    });
  });

  it("is deterministic and does not mutate either fixture", async () => {
    const [vehicleTool, tripTool] = createPhase1Tools();
    const firstVehicle = await vehicleTool.execute("vehicle-1", {});
    const secondVehicle = await vehicleTool.execute("vehicle-2", {});
    const firstTrip = await tripTool.execute("trip-1", {});
    const secondTrip = await tripTool.execute("trip-2", {});

    expect(firstVehicle).toEqual(secondVehicle);
    expect(firstTrip).toEqual(secondTrip);
    expect(Object.isFrozen(PHASE_1_VEHICLE_STATE)).toBe(true);
    expect(Object.isFrozen(PHASE_1_TRIP_STATE)).toBe(true);
  });
});
