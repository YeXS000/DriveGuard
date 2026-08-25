import { describe, expect, it } from "vitest";

import {
  PHASE_1_FIXTURE_ONLY,
  PHASE_1_TRIP_STATE,
  PHASE_1_VEHICLE_STATE,
} from "../../packages/agent-runtime/src/index.js";
import { parseTripState, parseVehicleState } from "@driveguard/domain";
import {
  createValidTripInput,
  createValidVehicleInput,
  PHASE_2_NOW_MS,
} from "../fixtures/phase2-domain.js";

describe("Phase 2 compatibility with Phase 1 fixture-only data", () => {
  it("maps the Phase 1 vehicle fixture without making it a Domain source", () => {
    const mapped = createValidVehicleInput();
    Object.assign(mapped, {
      vehicleId: PHASE_1_VEHICLE_STATE.vehicleId,
      speedKph: PHASE_1_VEHICLE_STATE.speedKph,
      soc: PHASE_1_VEHICLE_STATE.soc,
      chargingState: PHASE_1_VEHICLE_STATE.chargingState === "idle" ? "not_charging" : "charging",
    });
    const parsed = parseVehicleState(mapped, { nowMs: PHASE_2_NOW_MS });
    expect(parsed.vehicleId).toBe("phase1-vehicle-001");
    expect(PHASE_1_FIXTURE_ONLY).toBe("PHASE_1_FIXTURE_ONLY");
  });

  it("maps the Phase 1 trip fixture while adding explicit Phase 2 route identity", () => {
    const mapped = createValidTripInput();
    Object.assign(mapped, {
      navigationActive: PHASE_1_TRIP_STATE.navigationActive,
      destination: PHASE_1_TRIP_STATE.destination,
      remainingDistanceKm: PHASE_1_TRIP_STATE.remainingDistanceKm,
      etaMinutes: PHASE_1_TRIP_STATE.etaMinutes,
    });
    const parsed = parseTripState(mapped, { nowMs: PHASE_2_NOW_MS });
    expect(parsed.destination).toBe(PHASE_1_TRIP_STATE.destination);
    expect(parsed.routeId).toBe("route-001");
  });
});
