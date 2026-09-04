import {
  ContextFreshnessEvaluator,
  ContextSnapshotBuilder,
  type ContextFreshnessResult,
  type ContextFreshnessStatus,
  type FreshnessRequirement,
} from "@driveguard/context";
import type {
  ContextSnapshot,
  DrivingUser,
  TripState,
  VehicleCapabilities,
  VehicleState,
  WeatherState,
} from "@driveguard/domain";
import { DomainValidationError } from "@driveguard/domain";
import type { ServiceAvailability } from "@driveguard/capabilities";
import {
  RecoveryExhaustedError,
  RecoveryManager,
  type RecoveryReceipt,
} from "@driveguard/executor";
import type { SimulatorClient } from "@driveguard/tools";

import { AgentRuntimeError } from "./runtime-errors.js";

export interface ContextProvider {
  loadVehicleState(): Promise<VehicleState>;
  loadTripState(): Promise<TripState>;
  loadWeatherState(): Promise<WeatherState>;
  loadUser(): Promise<DrivingUser>;
  loadCapabilities(): Promise<VehicleCapabilities>;
  loadServiceAvailability(): Promise<ServiceAvailability>;
}

export interface ContextFreshnessReport {
  readonly status: ContextFreshnessStatus;
  readonly context: ContextFreshnessResult;
  readonly vehicle: ContextFreshnessResult;
  readonly trip: ContextFreshnessResult;
}

export interface LoadedRuntimeContext {
  readonly snapshot: ContextSnapshot;
  readonly freshness: ContextFreshnessReport;
  readonly services: ServiceAvailability;
}

export interface ContextLoaderOptions {
  readonly provider: ContextProvider;
  readonly snapshotBuilder: ContextSnapshotBuilder;
  readonly freshnessEvaluator: ContextFreshnessEvaluator;
  readonly freshnessRequirement?: FreshnessRequirement;
  readonly latestVersionProvider?: (snapshot: ContextSnapshot) => unknown;
  readonly recoveryManager?: RecoveryManager;
}

export class ContextLoadFailure extends AgentRuntimeError {
  readonly recovery: RecoveryReceipt | undefined;

  constructor(recovery?: RecoveryReceipt) {
    super(
      "CONTEXT_LOAD_FAILED",
      "Current vehicle or trip context could not be loaded after bounded recovery",
      true,
    );
    this.name = "ContextLoadFailure";
    this.recovery = recovery;
  }
}

export function selectEffectiveFreshness(
  results: readonly [ContextFreshnessResult, ...ContextFreshnessResult[]],
): ContextFreshnessResult {
  const precedence: readonly ContextFreshnessStatus[] = [
    "INVALID_FUTURE_TIMESTAMP",
    "NOT_LATEST",
    "STALE",
    "FRESH",
  ];
  for (const status of precedence) {
    const result = results.find((candidate) => candidate.status === status);
    if (result !== undefined) return result;
  }
  return { ...results[0], status: "STALE" };
}

export class ContextLoader {
  readonly #provider: ContextProvider;
  readonly #snapshotBuilder: ContextSnapshotBuilder;
  readonly #freshnessEvaluator: ContextFreshnessEvaluator;
  readonly #requirement: FreshnessRequirement;
  readonly #latestVersionProvider: (snapshot: ContextSnapshot) => unknown;
  readonly #recoveryManager: RecoveryManager;

  constructor(options: ContextLoaderOptions) {
    this.#provider = options.provider;
    this.#snapshotBuilder = options.snapshotBuilder;
    this.#freshnessEvaluator = options.freshnessEvaluator;
    this.#requirement = options.freshnessRequirement ?? {
      maxAgeMs: 5_000,
      requiresLatest: true,
    };
    this.#latestVersionProvider =
      options.latestVersionProvider ?? ((snapshot) => snapshot.contextVersion);
    this.#recoveryManager = options.recoveryManager ?? new RecoveryManager();
  }

  async load(): Promise<LoadedRuntimeContext> {
    let source: {
      vehicle: VehicleState;
      trip: TripState;
      weather: WeatherState;
      user: DrivingUser;
      capabilities: VehicleCapabilities;
      services: ServiceAvailability;
    };
    try {
      const [vehicle, trip, weather, user, capabilities, services] = await Promise.all([
        this.#recoveryManager.executeRead(() => this.#provider.loadVehicleState()),
        this.#recoveryManager.executeRead(() => this.#provider.loadTripState()),
        this.#provider.loadWeatherState(),
        this.#provider.loadUser(),
        this.#provider.loadCapabilities(),
        this.#provider.loadServiceAvailability(),
      ]);
      source = { vehicle, trip, weather, user, capabilities, services };
    } catch (error) {
      throw new ContextLoadFailure(
        error instanceof RecoveryExhaustedError ? error.receipt : undefined,
      );
    }

    try {
      const snapshot = this.#snapshotBuilder.create({
        vehicle: source.vehicle,
        trip: source.trip,
        weather: source.weather,
        user: source.user,
        capabilities: source.capabilities,
      });
      const context = this.#freshnessEvaluator.evaluate(
        snapshot,
        this.#requirement,
        this.#latestVersionProvider(snapshot),
      );
      const sourceRequirement = {
        maxAgeMs: this.#requirement.maxAgeMs,
        requiresLatest: false,
      } as const;
      const vehicle = this.#freshnessEvaluator.evaluate(
        { ...snapshot, capturedAt: snapshot.vehicle.timestamp },
        sourceRequirement,
      );
      const trip = this.#freshnessEvaluator.evaluate(
        { ...snapshot, capturedAt: snapshot.trip.timestamp },
        sourceRequirement,
      );
      return Object.freeze({
        snapshot,
        services: structuredClone(source.services),
        freshness: Object.freeze({
          status: selectEffectiveFreshness([context, vehicle, trip]).status,
          context,
          vehicle,
          trip,
        }),
      });
    } catch (error) {
      if (error instanceof AgentRuntimeError) throw error;
      if (
        error instanceof DomainValidationError &&
        error.issues.some(
          (issue) => issue.code === "INVALID_TIMESTAMP" && /future/iu.test(issue.message),
        )
      ) {
        throw new AgentRuntimeError(
          "CONTEXT_INVALID",
          "Current context freshness is INVALID_FUTURE_TIMESTAMP",
        );
      }
      throw new AgentRuntimeError("CONTEXT_INVALID", "Current context failed runtime validation");
    }
  }
}

export interface SimulatorContextProviderOptions {
  readonly simulator: SimulatorClient;
  readonly weather: WeatherState;
  readonly user: DrivingUser;
  readonly capabilities: VehicleCapabilities;
  readonly serviceAvailability: ServiceAvailability;
  readonly capabilitiesProvider?: () => Promise<VehicleCapabilities>;
  readonly serviceAvailabilityProvider?: () => Promise<ServiceAvailability>;
}

export class SimulatorContextProvider implements ContextProvider {
  readonly #simulator: SimulatorClient;
  readonly #weather: WeatherState;
  readonly #user: DrivingUser;
  readonly #capabilities: VehicleCapabilities;
  readonly #services: ServiceAvailability;
  readonly #capabilitiesProvider: (() => Promise<VehicleCapabilities>) | undefined;
  readonly #serviceAvailabilityProvider: (() => Promise<ServiceAvailability>) | undefined;

  constructor(options: SimulatorContextProviderOptions) {
    this.#simulator = options.simulator;
    this.#weather = structuredClone(options.weather);
    this.#user = structuredClone(options.user);
    this.#capabilities = structuredClone(options.capabilities);
    this.#services = structuredClone(options.serviceAvailability);
    this.#capabilitiesProvider = options.capabilitiesProvider;
    this.#serviceAvailabilityProvider = options.serviceAvailabilityProvider;
  }

  loadVehicleState(): Promise<VehicleState> {
    return this.#simulator.getVehicleState();
  }

  loadTripState(): Promise<TripState> {
    return this.#simulator.getTripState();
  }

  loadWeatherState(): Promise<WeatherState> {
    return Promise.resolve(structuredClone(this.#weather));
  }

  loadUser(): Promise<DrivingUser> {
    return Promise.resolve(structuredClone(this.#user));
  }

  loadCapabilities(): Promise<VehicleCapabilities> {
    return this.#capabilitiesProvider?.() ?? Promise.resolve(structuredClone(this.#capabilities));
  }

  loadServiceAvailability(): Promise<ServiceAvailability> {
    return (
      this.#serviceAvailabilityProvider?.() ?? Promise.resolve(structuredClone(this.#services))
    );
  }
}
