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
  /** Atomically sampled vehicle and trip state when the provider supports it. */
  loadVehicleTripState?(): Promise<{
    readonly vehicle: VehicleState;
    readonly trip: TripState;
    readonly simulationVersion: number;
  }>;
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
  readonly loadAttempts: number;
  readonly simulatorGeneration?: number;
}

export interface ContextLoaderOptions {
  readonly provider: ContextProvider;
  readonly snapshotBuilder: ContextSnapshotBuilder;
  readonly freshnessEvaluator: ContextFreshnessEvaluator;
  readonly freshnessRequirement?: FreshnessRequirement;
  readonly latestVersionProvider?: (snapshot: ContextSnapshot) => unknown;
  readonly recoveryManager?: RecoveryManager;
}

interface LoadedContextSource {
  readonly vehicle: VehicleState;
  readonly trip: TripState;
  readonly weather: WeatherState;
  readonly user: DrivingUser;
  readonly capabilities: VehicleCapabilities;
  readonly services: ServiceAvailability;
  readonly simulationVersion?: number;
}

function isFutureTimestampValidationError(error: unknown): boolean {
  return (
    error instanceof DomainValidationError &&
    error.issues.some(
      (issue) => issue.code === "INVALID_TIMESTAMP" && /future/iu.test(issue.message),
    )
  );
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
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const source = await this.#loadSource();
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
          loadAttempts: attempt + 1,
          ...(source.simulationVersion === undefined
            ? {}
            : { simulatorGeneration: source.simulationVersion }),
          freshness: Object.freeze({
            status: selectEffectiveFreshness([context, vehicle, trip]).status,
            context,
            vehicle,
            trip,
          }),
        });
      } catch (error) {
        if (attempt === 0 && isFutureTimestampValidationError(error)) continue;
        if (error instanceof AgentRuntimeError) throw error;
        if (isFutureTimestampValidationError(error)) {
          throw new AgentRuntimeError(
            "POLICY_REPLAN_REQUIRED",
            "Context clock skew remained after one bounded refresh",
            true,
          );
        }
        throw new AgentRuntimeError("CONTEXT_INVALID", "Current context failed runtime validation");
      }
    }
    throw new AgentRuntimeError("POLICY_REPLAN_REQUIRED", "Context refresh was exhausted", true);
  }

  async #loadSource(): Promise<LoadedContextSource> {
    try {
      const atomic = this.#provider.loadVehicleTripState?.bind(this.#provider);
      const [states, weather, user, capabilities, services] = await Promise.all([
        atomic === undefined
          ? Promise.all([
              this.#recoveryManager.executeRead(() => this.#provider.loadVehicleState()),
              this.#recoveryManager.executeRead(() => this.#provider.loadTripState()),
            ])
          : this.#recoveryManager.executeRead(atomic),
        this.#provider.loadWeatherState(),
        this.#provider.loadUser(),
        this.#provider.loadCapabilities(),
        this.#provider.loadServiceAvailability(),
      ]);
      const [vehicle, trip] = Array.isArray(states)
        ? states
        : ([states.vehicle, states.trip] as const);
      return {
        vehicle,
        trip,
        weather,
        user,
        capabilities,
        services,
        ...(Array.isArray(states) ? {} : { simulationVersion: states.simulationVersion }),
      };
    } catch (error) {
      throw new ContextLoadFailure(
        error instanceof RecoveryExhaustedError ? error.receipt : undefined,
      );
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

  async loadVehicleTripState(): Promise<{
    readonly vehicle: VehicleState;
    readonly trip: TripState;
    readonly simulationVersion: number;
  }> {
    return this.#simulator.getContextState();
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
