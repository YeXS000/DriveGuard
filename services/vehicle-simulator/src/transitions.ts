import {
  parseTripState,
  parseVehicleState,
  toUtcTimestamp,
  type TripState,
  type VehicleState,
} from "@driveguard/domain";

import { SimulatorError } from "./errors.js";
import type { AssistanceRequest, ChargingReservation, SimulatorState } from "./types.js";

function nextVersion(version: number, path: string): number {
  if (!Number.isSafeInteger(version) || version >= Number.MAX_SAFE_INTEGER) {
    throw new SimulatorError("INVALID_TRANSITION", `${path} version is exhausted`, 409);
  }
  return version + 1;
}

function vehicleTransition(
  current: SimulatorState,
  nowMs: number,
  change: Partial<VehicleState>,
): SimulatorState {
  const vehicle = parseVehicleState(
    {
      ...current.vehicle,
      ...change,
      timestamp: toUtcTimestamp(nowMs),
      version: nextVersion(current.vehicle.version, "vehicle"),
    },
    { nowMs },
  );
  return {
    ...current,
    vehicle,
    simulationVersion: nextVersion(current.simulationVersion, "simulation"),
    updatedAt: toUtcTimestamp(nowMs),
  };
}

function tripTransition(
  current: SimulatorState,
  nowMs: number,
  change: Partial<Record<keyof TripState, unknown>>,
): SimulatorState {
  const trip = parseTripState(
    {
      ...current.trip,
      ...change,
      timestamp: toUtcTimestamp(nowMs),
      version: nextVersion(current.trip.version, "trip"),
    },
    { nowMs },
  );
  return {
    ...current,
    trip,
    simulationVersion: nextVersion(current.simulationVersion, "simulation"),
    updatedAt: toUtcTimestamp(nowMs),
  };
}

function simulatorOnlyTransition(
  current: SimulatorState,
  nowMs: number,
  change: Pick<Partial<SimulatorState>, "cabin" | "charging" | "assistance">,
): SimulatorState {
  return {
    ...current,
    ...change,
    simulationVersion: nextVersion(current.simulationVersion, "simulation"),
    updatedAt: toUtcTimestamp(nowMs),
  };
}

export function setVehicleSpeed(
  current: SimulatorState,
  speedKph: number,
  nowMs: number,
): SimulatorState {
  if (current.vehicle.chargingState === "charging" && speedKph > 0) {
    throw new SimulatorError(
      "INVALID_TRANSITION",
      "Vehicle cannot move while actively charging",
      409,
    );
  }
  return vehicleTransition(current, nowMs, {
    speedKph,
    gear: speedKph === 0 ? "P" : "D",
    driveMode: speedKph === 0 ? "parked" : "driving",
  });
}

export function setSoc(current: SimulatorState, soc: number, nowMs: number): SimulatorState {
  return vehicleTransition(current, nowMs, {
    soc,
    estimatedRangeKm: Math.round(soc * 5 * 10) / 10,
  });
}

export function setCabinTemperature(
  current: SimulatorState,
  temperatureC: number,
  nowMs: number,
): SimulatorState {
  return vehicleTransition(current, nowMs, { cabinTemperature: temperatureC });
}

export function setSeatHeating(
  current: SimulatorState,
  seat: "driver" | "front_passenger",
  level: 0 | 1 | 2 | 3,
  nowMs: number,
): SimulatorState {
  return simulatorOnlyTransition(current, nowMs, {
    cabin: {
      ...current.cabin,
      seatHeating: { ...current.cabin.seatHeating, [seat]: level },
    },
  });
}

export function setMediaVolume(
  current: SimulatorState,
  volume: number,
  nowMs: number,
): SimulatorState {
  return simulatorOnlyTransition(current, nowMs, {
    cabin: { ...current.cabin, mediaVolume: volume },
  });
}

export function setNavigationDestination(
  current: SimulatorState,
  destination: string,
  routeId: string,
  distanceKm: number,
  nowMs: number,
): SimulatorState {
  return tripTransition(current, nowMs, {
    destination,
    routeId,
    remainingDistanceKm: distanceKm,
    etaMinutes: Math.ceil(distanceKm * 1.6),
    navigationActive: true,
  });
}

export function reroute(
  current: SimulatorState,
  allocateRouteId: () => string,
  nowMs: number,
): SimulatorState {
  if (!current.trip.navigationActive || current.trip.destination === null) {
    throw new SimulatorError("INVALID_TRANSITION", "Cannot reroute without active navigation", 409);
  }
  const distanceKm = Math.max(0.1, Math.round(current.trip.remainingDistanceKm * 0.92 * 10) / 10);
  return tripTransition(current, nowMs, {
    routeId: allocateRouteId(),
    remainingDistanceKm: distanceKm,
    etaMinutes: Math.ceil(distanceKm * 1.5),
  });
}

export function createReservation(
  current: SimulatorState,
  stationId: string,
  allocateId: () => string,
  nowMs: number,
): SimulatorState {
  const station = current.charging.stations.find((candidate) => candidate.id === stationId);
  if (station === undefined) {
    throw new SimulatorError("STATION_NOT_FOUND", "Charging station was not found", 404);
  }
  if (station.availableSlots < 1) {
    throw new SimulatorError("NO_AVAILABLE_SLOT", "Charging station has no available slot", 409);
  }
  if (
    current.charging.reservations.some(
      (candidate) => candidate.stationId === stationId && candidate.status === "active",
    )
  ) {
    throw new SimulatorError(
      "INVALID_TRANSITION",
      "An active reservation already exists for this station",
      409,
    );
  }
  const reservation: ChargingReservation = {
    id: allocateId(),
    stationId,
    createdAt: toUtcTimestamp(nowMs),
    status: "active",
  };
  return simulatorOnlyTransition(current, nowMs, {
    charging: {
      stations: current.charging.stations.map((candidate) =>
        candidate.id === station.id
          ? { ...candidate, availableSlots: candidate.availableSlots - 1 }
          : candidate,
      ),
      reservations: [...current.charging.reservations, reservation],
    },
  });
}

export function cancelReservation(
  current: SimulatorState,
  reservationId: string,
  nowMs: number,
): SimulatorState {
  const reservation = current.charging.reservations.find(
    (candidate) => candidate.id === reservationId,
  );
  if (reservation === undefined) {
    throw new SimulatorError("RESERVATION_NOT_FOUND", "Charging reservation was not found", 404);
  }
  return simulatorOnlyTransition(current, nowMs, {
    charging: {
      stations: current.charging.stations.map((station) =>
        station.id === reservation.stationId
          ? { ...station, availableSlots: station.availableSlots + 1 }
          : station,
      ),
      reservations: current.charging.reservations.filter(
        (candidate) => candidate.id !== reservationId,
      ),
    },
  });
}

export function requestRoadsideAssistance(
  current: SimulatorState,
  request: AssistanceRequest,
  nowMs: number,
): SimulatorState {
  return simulatorOnlyTransition(current, nowMs, {
    assistance: { requests: [...current.assistance.requests, request] },
  });
}
