import type { TripState, UtcTimestamp, VehicleState } from "@driveguard/domain";

export const SCENARIO_IDS = [
  "city_idle",
  "highway_driving",
  "low_soc",
  "charging",
  "active_navigation",
  "parked_no_navigation",
  "network_failure_ready",
] as const;

export type ScenarioId = (typeof SCENARIO_IDS)[number];

export interface CabinState {
  readonly seatHeating: Readonly<Record<"driver" | "front_passenger", 0 | 1 | 2 | 3>>;
  readonly mediaVolume: number;
}

export interface ChargingStation {
  readonly id: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly availableSlots: number;
  readonly maxPowerKw: number;
}

export interface ChargingReservation {
  readonly id: string;
  readonly stationId: string;
  readonly createdAt: UtcTimestamp;
  readonly status: "active";
}

export interface ChargingSimulatorState {
  readonly stations: readonly ChargingStation[];
  readonly reservations: readonly ChargingReservation[];
}

export interface AssistanceRequest {
  readonly id: string;
  readonly reason: string;
  readonly createdAt: UtcTimestamp;
  readonly status: "requested";
}

export interface AssistanceSimulatorState {
  readonly requests: readonly AssistanceRequest[];
}

export interface SimulatorState {
  readonly vehicle: VehicleState;
  readonly trip: TripState;
  readonly cabin: CabinState;
  readonly charging: ChargingSimulatorState;
  readonly assistance: AssistanceSimulatorState;
  readonly scenario: ScenarioId;
  readonly seed: number;
  readonly simulationVersion: number;
  readonly updatedAt: UtcTimestamp;
}

export interface ResetCommand {
  readonly scenario: ScenarioId;
  readonly seed: number;
}

export interface NavigationDestinationCommand {
  readonly destination: string;
}

export interface ChargingReservationCommand {
  readonly stationId: string;
}

export const FAULT_TARGETS = [
  "vehicle.get_state",
  "trip.get_state",
  "cabin.set_temperature",
  "cabin.set_seat_heating",
  "media.set_volume",
  "navigation.set_destination",
  "navigation.reroute",
  "charging.list_stations",
  "charging.get_status",
  "charging.create_reservation",
  "charging.cancel_reservation",
  "assistance.roadside",
] as const;

export type FaultTarget = (typeof FAULT_TARGETS)[number];

export const FAULT_MODES = [
  "delay",
  "timeout",
  "http_500",
  "http_503",
  "connection_abort",
  "stale_response",
] as const;

export type FaultMode = (typeof FAULT_MODES)[number];

export interface FaultConfig {
  readonly target: FaultTarget;
  readonly mode: FaultMode;
  readonly probability: number;
  readonly delayMs: number;
}

export interface TriggeredFault extends FaultConfig {
  readonly triggered: true;
}
