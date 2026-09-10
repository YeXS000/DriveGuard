import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

export const PHASE_1_FIXTURE_ONLY = "PHASE_1_FIXTURE_ONLY" as const;

export interface Phase1VehicleStateFixture {
  readonly vehicleId: string;
  readonly speedKph: number;
  readonly soc: number;
  readonly chargingState: "idle" | "charging";
}

export interface Phase1TripStateFixture {
  readonly navigationActive: boolean;
  readonly destination: string;
  readonly remainingDistanceKm: number;
  readonly etaMinutes: number;
}

export interface Phase1FixtureDetails<TState> {
  readonly source: typeof PHASE_1_FIXTURE_ONLY;
  readonly state: TState;
}

export const PHASE_1_VEHICLE_STATE = Object.freeze<Phase1VehicleStateFixture>({
  vehicleId: "phase1-vehicle-001",
  speedKph: 0,
  soc: 67,
  chargingState: "idle",
});

export const PHASE_1_TRIP_STATE = Object.freeze<Phase1TripStateFixture>({
  navigationActive: true,
  destination: "Phase 1 Test Destination",
  remainingDistanceKm: 42.5,
  etaMinutes: 38,
});

const phase1EmptyParameters = Type.Object({}, { additionalProperties: false });

function fixtureContent<TState>(state: TState): string {
  return JSON.stringify({ source: PHASE_1_FIXTURE_ONLY, ...state });
}

export type Phase1VehicleStateTool = AgentTool<
  typeof phase1EmptyParameters,
  Phase1FixtureDetails<Phase1VehicleStateFixture>
>;

export type Phase1TripStateTool = AgentTool<
  typeof phase1EmptyParameters,
  Phase1FixtureDetails<Phase1TripStateFixture>
>;

export function createPhase1VehicleStateTool(): Phase1VehicleStateTool {
  return {
    name: "get_vehicle_state",
    label: "Get vehicle state",
    description:
      "Read the deterministic PHASE_1_FIXTURE_ONLY vehicle state, including battery SOC. This tool has no side effects.",
    parameters: phase1EmptyParameters,
    execute: () =>
      Promise.resolve({
        content: [{ type: "text", text: fixtureContent(PHASE_1_VEHICLE_STATE) }],
        details: { source: PHASE_1_FIXTURE_ONLY, state: PHASE_1_VEHICLE_STATE },
      }),
  };
}

export function createPhase1TripStateTool(): Phase1TripStateTool {
  return {
    name: "get_trip_state",
    label: "Get trip state",
    description:
      "Read the deterministic PHASE_1_FIXTURE_ONLY navigation and trip state. This tool has no side effects.",
    parameters: phase1EmptyParameters,
    execute: () =>
      Promise.resolve({
        content: [{ type: "text", text: fixtureContent(PHASE_1_TRIP_STATE) }],
        details: { source: PHASE_1_FIXTURE_ONLY, state: PHASE_1_TRIP_STATE },
      }),
  };
}

export function createPhase1Tools(): [Phase1VehicleStateTool, Phase1TripStateTool] {
  return [createPhase1VehicleStateTool(), createPhase1TripStateTool()];
}
