import {
  ContextFreshnessEvaluator,
  ContextSnapshotBuilder,
  ContextSnapshotIdAllocator,
  ContextVersionAllocator,
} from "@driveguard/context";
import type {
  DrivingUser,
  ContextSnapshot,
  TripState,
  VehicleCapabilities,
  VehicleState,
  WeatherState,
} from "@driveguard/domain";
import type { Clock } from "@driveguard/shared";
import type { ServiceAvailability } from "@driveguard/capabilities";
import { describe, expect, it, vi } from "vitest";

import {
  AgentRuntimeError,
  ContextLoader,
  type ContextProvider,
} from "../../packages/agent-runtime/src/index.js";

class MutableClock implements Clock {
  constructor(public value: number) {}
  nowMs(): number {
    return this.value;
  }
}

const baseMs = Date.parse("2026-08-27T08:00:00.000Z");

function vehicle(timestamp = new Date(baseMs).toISOString(), soc = 72): VehicleState {
  return {
    vehicleId: "vehicle-phase5",
    timestamp,
    version: 1,
    speedKph: 0,
    gear: "P",
    driveMode: "parked",
    soc,
    chargingState: "not_charging",
    estimatedRangeKm: soc * 5,
    latitude: 31.23,
    longitude: 121.47,
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
    occupants: [{ seat: "driver", presence: "occupied" }],
  } as VehicleState;
}

function trip(timestamp = new Date(baseMs).toISOString(), distance = 18.4): TripState {
  return {
    timestamp,
    version: 1,
    destination: "Shanghai Science Museum",
    routeId: "route-phase5",
    remainingDistanceKm: distance,
    etaMinutes: 29,
    navigationActive: true,
  } as TripState;
}

const weather = { condition: "clear", temperatureC: 25 } as WeatherState;
const user = { userId: "driver-phase5", role: "driver" } as DrivingUser;
const capabilities = {
  navigation: true,
  charging: true,
  cabinTemperature: true,
  seatHeating: true,
  media: true,
  roadsideAssistance: true,
} as VehicleCapabilities;
const services = {
  vehicleSimulator: true,
  weather: true,
  emergencySupport: true,
} as ServiceAvailability;

class MutableProvider implements ContextProvider {
  currentVehicle = vehicle();
  currentTrip = trip();
  readonly calls = {
    vehicle: vi.fn(),
    trip: vi.fn(),
    weather: vi.fn(),
    user: vi.fn(),
    capabilities: vi.fn(),
    services: vi.fn(),
  };

  loadVehicleState(): Promise<VehicleState> {
    this.calls.vehicle();
    return Promise.resolve(structuredClone(this.currentVehicle));
  }
  loadTripState(): Promise<TripState> {
    this.calls.trip();
    return Promise.resolve(structuredClone(this.currentTrip));
  }
  loadWeatherState(): Promise<WeatherState> {
    this.calls.weather();
    return Promise.resolve(structuredClone(weather));
  }
  loadUser(): Promise<DrivingUser> {
    this.calls.user();
    return Promise.resolve(structuredClone(user));
  }
  loadCapabilities(): Promise<VehicleCapabilities> {
    this.calls.capabilities();
    return Promise.resolve(structuredClone(capabilities));
  }
  loadServiceAvailability(): Promise<ServiceAvailability> {
    this.calls.services();
    return Promise.resolve(structuredClone(services));
  }
}

function loader(
  provider: ContextProvider,
  clock: Clock = new MutableClock(baseMs),
  options: {
    maxAgeMs?: number;
    latestVersionProvider?: (snapshot: ContextSnapshot) => unknown;
  } = {},
): ContextLoader {
  return new ContextLoader({
    provider,
    snapshotBuilder: new ContextSnapshotBuilder({
      clock,
      versionAllocator: new ContextVersionAllocator(0),
      snapshotIdAllocator: new ContextSnapshotIdAllocator("phase5-test-context", 0),
    }),
    freshnessEvaluator: new ContextFreshnessEvaluator(clock),
    freshnessRequirement: {
      maxAgeMs: options.maxAgeMs ?? 5_000,
      requiresLatest: true,
    },
    ...(options.latestVersionProvider === undefined
      ? {}
      : { latestVersionProvider: options.latestVersionProvider }),
  });
}

describe("Phase 5 ContextLoader", () => {
  it("uses the formal five-second latest-context requirement by default", async () => {
    const provider = new MutableProvider();
    const clock = new MutableClock(baseMs);
    const contextLoader = new ContextLoader({
      provider,
      snapshotBuilder: new ContextSnapshotBuilder({
        clock,
        versionAllocator: new ContextVersionAllocator(0),
        snapshotIdAllocator: new ContextSnapshotIdAllocator("phase5-default-context", 0),
      }),
      freshnessEvaluator: new ContextFreshnessEvaluator(clock),
    });

    const loaded = await contextLoader.load();

    expect(loaded.freshness.context.maxAgeMs).toBe(5_000);
    expect(loaded.freshness.context.latestVersion).toBe(loaded.snapshot.contextVersion);
  });

  it("loads every formal world-state component for one turn", async () => {
    const provider = new MutableProvider();
    const loaded = await loader(provider).load();

    expect(loaded.snapshot.vehicle.soc).toBe(72);
    expect(loaded.snapshot.trip.remainingDistanceKm).toBe(18.4);
    expect(loaded.snapshot.weather).toEqual(weather);
    expect(loaded.snapshot.user).toEqual(user);
    expect(loaded.snapshot.capabilities).toEqual(capabilities);
    for (const spy of Object.values(provider.calls)) expect(spy).toHaveBeenCalledOnce();
  });

  it("uses one atomic simulator state read rather than mixed vehicle and trip reads", async () => {
    const provider = new MutableProvider();
    const atomic = vi.fn(() =>
      Promise.resolve({
        vehicle: structuredClone(provider.currentVehicle),
        trip: structuredClone(provider.currentTrip),
        simulationVersion: 41,
      }),
    );
    const atomicProvider: ContextProvider = {
      loadVehicleTripState: atomic,
      loadVehicleState: provider.loadVehicleState.bind(provider),
      loadTripState: provider.loadTripState.bind(provider),
      loadWeatherState: provider.loadWeatherState.bind(provider),
      loadUser: provider.loadUser.bind(provider),
      loadCapabilities: provider.loadCapabilities.bind(provider),
      loadServiceAvailability: provider.loadServiceAvailability.bind(provider),
    };

    const loaded = await loader(atomicProvider).load();

    expect(loaded.simulatorGeneration).toBe(41);
    expect(atomic).toHaveBeenCalledOnce();
    expect(provider.calls.vehicle).not.toHaveBeenCalled();
    expect(provider.calls.trip).not.toHaveBeenCalled();
  });

  it("reloads world state and creates a new snapshot on every invocation", async () => {
    const provider = new MutableProvider();
    const contextLoader = loader(provider);
    const first = await contextLoader.load();
    provider.currentVehicle = { ...provider.currentVehicle, soc: 20, estimatedRangeKm: 100 };
    provider.currentTrip = { ...provider.currentTrip, remainingDistanceKm: 7.5 };
    const second = await contextLoader.load();

    expect(first.snapshot.vehicle.soc).toBe(72);
    expect(second.snapshot.vehicle.soc).toBe(20);
    expect(second.snapshot.trip.remainingDistanceKm).toBe(7.5);
    expect(second.snapshot.contextVersion).toBe(first.snapshot.contextVersion + 1);
    expect(second.snapshot.snapshotId).not.toBe(first.snapshot.snapshotId);
    for (const spy of Object.values(provider.calls)) expect(spy).toHaveBeenCalledTimes(2);
  });

  it("returns deeply frozen validated snapshots", async () => {
    const loaded = await loader(new MutableProvider()).load();

    expect(Object.isFrozen(loaded.snapshot)).toBe(true);
    expect(Object.isFrozen(loaded.snapshot.vehicle)).toBe(true);
    expect(Object.isFrozen(loaded.snapshot.vehicle.doors)).toBe(true);
    expect(Object.isFrozen(loaded.snapshot.trip)).toBe(true);
  });

  it("reports FRESH for current snapshot and source states", async () => {
    const loaded = await loader(new MutableProvider()).load();

    expect(loaded.freshness.status).toBe("FRESH");
    expect(loaded.freshness.context.status).toBe("FRESH");
    expect(loaded.freshness.vehicle.status).toBe("FRESH");
    expect(loaded.freshness.trip.status).toBe("FRESH");
  });

  it.each([
    ["vehicle", 10_000],
    ["trip", 10_000],
  ] as const)(
    "reports STALE when the %s source is older than the runtime bound",
    async (kind, age) => {
      const provider = new MutableProvider();
      const timestamp = new Date(baseMs - age).toISOString();
      if (kind === "vehicle") provider.currentVehicle = vehicle(timestamp);
      else provider.currentTrip = trip(timestamp);

      const loaded = await loader(provider).load();

      expect(loaded.freshness.status).toBe("STALE");
      expect(loaded.freshness[kind].status).toBe("STALE");
    },
  );

  it("reports NOT_LATEST when the injected current version differs", async () => {
    const loaded = await loader(new MutableProvider(), new MutableClock(baseMs), {
      latestVersionProvider: () => 999,
    }).load();

    expect(loaded.freshness.status).toBe("NOT_LATEST");
    expect(loaded.freshness.context.status).toBe("NOT_LATEST");
  });

  it("preserves an already structured runtime failure from latest-version resolution", async () => {
    const expected = new AgentRuntimeError(
      "CONTEXT_INVALID",
      "Latest context version is unavailable",
      true,
    );
    const contextLoader = loader(new MutableProvider(), new MutableClock(baseMs), {
      latestVersionProvider: () => {
        throw expected;
      },
    });

    await expect(contextLoader.load()).rejects.toBe(expected);
  });

  it("fails conservatively when an evaluator produces no recognized freshness status", async () => {
    const provider = new MutableProvider();
    const clock = new MutableClock(baseMs);
    const evaluator = {
      evaluate: () => ({
        status: "UNRECOGNIZED",
        ageMs: 0,
        maxAgeMs: 5_000,
        snapshotVersion: 1,
      }),
    } as never;
    const contextLoader = new ContextLoader({
      provider,
      snapshotBuilder: new ContextSnapshotBuilder({
        clock,
        versionAllocator: new ContextVersionAllocator(0),
        snapshotIdAllocator: new ContextSnapshotIdAllocator("phase5-invalid-freshness", 0),
      }),
      freshnessEvaluator: evaluator,
    });

    expect((await contextLoader.load()).freshness.status).toBe("STALE");
  });

  it("maps a persistent future source timestamp to bounded REPLAN_REQUIRED", async () => {
    const provider = new MutableProvider();
    provider.currentVehicle = vehicle(new Date(baseMs + 1).toISOString());

    await expect(loader(provider).load()).rejects.toMatchObject({
      code: "POLICY_REPLAN_REQUIRED",
      message: "Context clock skew remained after one bounded refresh",
    });
  });

  it("reloads source state once when only a transient future timestamp is observed", async () => {
    const provider = new MutableProvider();
    provider.currentVehicle = vehicle(new Date(baseMs + 1).toISOString());
    const timestamps = [baseMs, baseMs + 1, baseMs + 1, baseMs + 1];
    const clock: Clock = {
      nowMs: () => timestamps.shift() ?? baseMs + 1,
    };

    const loaded = await loader(provider, clock).load();

    expect(loaded.snapshot.vehicle.timestamp).toBe(new Date(baseMs + 1).toISOString());
    expect(provider.calls.vehicle).toHaveBeenCalledTimes(2);
    expect(provider.calls.trip).toHaveBeenCalledTimes(2);
  });

  it.each(["vehicle", "trip", "weather", "user", "capabilities", "services"] as const)(
    "maps %s provider rejection to CONTEXT_LOAD_FAILED without raw dependency details",
    async (method) => {
      const provider = new MutableProvider();
      const secret = "provider-secret-must-not-escape";
      const methodNames = {
        vehicle: "loadVehicleState",
        trip: "loadTripState",
        weather: "loadWeatherState",
        user: "loadUser",
        capabilities: "loadCapabilities",
        services: "loadServiceAvailability",
      } as const;
      vi.spyOn(provider, methodNames[method]).mockRejectedValue(new Error(secret));

      try {
        await loader(provider).load();
        throw new Error("Expected ContextLoader to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(AgentRuntimeError);
        expect(error).toMatchObject({ code: "CONTEXT_LOAD_FAILED", retryable: true });
        expect(JSON.stringify(error)).not.toContain(secret);
      }
    },
  );

  it("maps schema-invalid provider data to CONTEXT_INVALID", async () => {
    const provider = new MutableProvider();
    provider.currentVehicle = { ...provider.currentVehicle, soc: 101 };

    await expect(loader(provider).load()).rejects.toMatchObject({ code: "CONTEXT_INVALID" });
  });

  it("preserves the prior snapshot when caller-owned source data is mutated later", async () => {
    const provider = new MutableProvider();
    const loaded = await loader(provider).load();
    provider.currentVehicle = { ...provider.currentVehicle, soc: 1, estimatedRangeKm: 5 };

    expect(loaded.snapshot.vehicle.soc).toBe(72);
  });
});
