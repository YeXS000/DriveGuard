import { FixedClock } from "@driveguard/shared";
import {
  ContextSnapshotBuilder,
  ContextSnapshotIdAllocator,
  ContextVersionAllocator,
} from "@driveguard/context";

export const PHASE_2_NOW_MS = Date.parse("2026-08-25T10:00:00.000Z");
export const PHASE_2_NOW = "2026-08-25T10:00:00.000Z";

export function createValidVehicleInput() {
  return {
    vehicleId: "vehicle-001",
    timestamp: PHASE_2_NOW,
    version: 1,
    speedKph: 0,
    gear: "P",
    driveMode: "parked",
    soc: 67,
    chargingState: "not_charging",
    estimatedRangeKm: 320,
    latitude: 31.2304,
    longitude: 121.4737,
    doors: {
      frontLeft: "locked",
      frontRight: "locked",
      rearLeft: "locked",
      rearRight: "locked",
      trunk: "locked",
    },
    windows: {
      frontLeft: "closed",
      frontRight: "closed",
      rearLeft: "closed",
      rearRight: "closed",
    },
    cabinTemperature: 22,
    outsideTemperature: 28,
    occupants: [
      { seat: "driver", presence: "occupied" },
      { seat: "front_passenger", presence: "vacant" },
    ],
  };
}

export function createValidTripInput() {
  return {
    timestamp: PHASE_2_NOW,
    version: 1,
    destination: "Shanghai Railway Station",
    routeId: "route-001",
    remainingDistanceKm: 42.5,
    etaMinutes: 38,
    navigationActive: true,
  };
}

export function createInactiveTripInput() {
  return {
    timestamp: PHASE_2_NOW,
    version: 1,
    destination: null,
    routeId: null,
    remainingDistanceKm: 0,
    etaMinutes: 0,
    navigationActive: false,
  };
}

export function createWeatherInput() {
  return { condition: "clear", temperatureC: 28 };
}

export function createUserInput() {
  return { userId: "user-001", role: "driver" };
}

export function createCapabilitiesInput() {
  return {
    navigation: true,
    charging: true,
    cabinTemperature: true,
    seatHeating: true,
    media: true,
    roadsideAssistance: true,
  };
}

export function createSnapshotBuilder(
  nowMs = PHASE_2_NOW_MS,
  currentVersion = 0,
  prefix = "phase2-snapshot",
) {
  return new ContextSnapshotBuilder({
    clock: new FixedClock(nowMs),
    versionAllocator: new ContextVersionAllocator(currentVersion),
    snapshotIdAllocator: new ContextSnapshotIdAllocator(prefix, 0),
  });
}

export function createValidSnapshot(builder = createSnapshotBuilder()) {
  return builder.create({
    vehicle: createValidVehicleInput(),
    trip: createValidTripInput(),
    weather: createWeatherInput(),
    user: createUserInput(),
    capabilities: createCapabilitiesInput(),
  });
}
