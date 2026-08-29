import { createModels, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  ConfirmationService,
  ContextRevalidator,
  InMemoryActionLifecycleEventSink,
  type ActionLifecycleEvent,
  type ActionLifecycleEventSink,
} from "@driveguard/action-lifecycle";
import type { ServiceAvailability } from "@driveguard/capabilities";
import {
  ContextFreshnessEvaluator,
  ContextSnapshotBuilder,
  ContextSnapshotIdAllocator,
  ContextVersionAllocator,
} from "@driveguard/context";
import type { DrivingUser, VehicleCapabilities, WeatherState } from "@driveguard/domain";
import { ReliableToolExecutor, type ExecutionEventSink } from "@driveguard/executor";
import { SystemClock, type Clock } from "@driveguard/shared";
import { createDefaultToolPolicyProfileRegistry, PolicyEngine } from "@driveguard/policy";
import {
  createDriveGuardToolRegistry,
  DevelopmentEmergencySupportProvider,
  DevelopmentWeatherProvider,
  SimulatorClient,
} from "@driveguard/tools";

import { ContextLoader, SimulatorContextProvider } from "./context-loader.js";
import {
  DriveGuardAgentRuntime,
  type DriveGuardRuntimeOptions,
  type ProductionDriveGuardRuntime,
} from "./production-runtime.js";
import { AgentRuntimeError } from "./runtime-errors.js";
import type { Phase5RuntimeMode } from "./pi-tool-adapter.js";
import {
  InMemoryTrustedConfirmationChallengeChannel,
  type TrustedConfirmationChallengeChannel,
} from "./trusted-confirmation-channel.js";

const PREFERRED_DEEPSEEK_MODEL_ID = "deepseek-v4-flash";

export interface DeepSeekPhase5Selection {
  readonly models: MutableModels;
  readonly model: Model<string>;
  readonly modelId: string;
  readonly providerId: "deepseek";
  readonly api: string;
}

export interface CreateProductionRuntimeOptions {
  readonly model: Model<string>;
  readonly streamFn: StreamFn;
  readonly simulatorBaseUrl: string;
  readonly capabilities: VehicleCapabilities;
  readonly serviceAvailability: ServiceAvailability;
  readonly clock?: Clock;
  readonly weather?: WeatherState;
  readonly user?: DrivingUser;
  readonly mode?: Phase5RuntimeMode;
  readonly developmentExecutionOptIn?: boolean;
  readonly sensitiveValues?: readonly string[];
  readonly capabilitiesProvider?: () => Promise<VehicleCapabilities>;
  readonly serviceAvailabilityProvider?: () => Promise<ServiceAvailability>;
  readonly latestContextVersionProvider?: (snapshotVersion: number) => unknown;
  readonly runtimeOverrides?: Pick<
    DriveGuardRuntimeOptions,
    "runIdFactory" | "traceIdFactory" | "eventIdFactory" | "eventSink"
  >;
  readonly actionLifecycleEventSink?: ActionLifecycleEventSink;
  readonly executionEventSink?: ExecutionEventSink;
  readonly trustedConfirmationChallengeChannel?: TrustedConfirmationChallengeChannel;
}

export const DEFAULT_PHASE_5_CAPABILITIES = Object.freeze({
  navigation: true,
  charging: true,
  cabinTemperature: true,
  seatHeating: true,
  media: true,
  roadsideAssistance: true,
}) as VehicleCapabilities;

export const DEFAULT_PHASE_5_SERVICES = Object.freeze({
  vehicleSimulator: true,
  weather: true,
  emergencySupport: true,
}) as ServiceAvailability;

const DEFAULT_WEATHER = Object.freeze({ condition: "clear", temperatureC: 25 }) as WeatherState;
const DEFAULT_USER = Object.freeze({ userId: "phase5-driver", role: "driver" }) as DrivingUser;

export function parsePhase5RuntimeMode(value: string | undefined): Phase5RuntimeMode {
  const selected = value ?? "read_only";
  if (selected !== "read_only" && selected !== "development") {
    throw new AgentRuntimeError(
      "CONFIGURATION_ERROR",
      "PHASE_5_RUNTIME_MODE must be read_only or development",
    );
  }
  return selected;
}

export function createDeepSeekPhase5Selection(
  requestedModelId = process.env.DEEPSEEK_MODEL,
): DeepSeekPhase5Selection {
  const models = createModels();
  models.setProvider(deepseekProvider());
  const catalog = models.getModels("deepseek");
  const selectedId = requestedModelId ?? PREFERRED_DEEPSEEK_MODEL_ID;
  const selected = models.getModel("deepseek", selectedId);
  if (selected === undefined) {
    throw new AgentRuntimeError(
      "CONFIGURATION_ERROR",
      `DEEPSEEK_MODEL must match the installed Pi catalog. Available model IDs: ${catalog
        .map((model) => model.id)
        .join(", ")}`,
    );
  }
  return {
    models,
    model: selected,
    modelId: selected.id,
    providerId: "deepseek",
    api: selected.api,
  };
}

export function createProductionDriveGuardRuntime(
  options: CreateProductionRuntimeOptions,
): ProductionDriveGuardRuntime {
  const mode = options.mode ?? "read_only";
  if (mode === "development") {
    let simulatorOrigin: URL;
    try {
      simulatorOrigin = new URL(options.simulatorBaseUrl);
    } catch {
      throw new AgentRuntimeError("CONFIGURATION_ERROR", "Simulator base URL is invalid");
    }
    const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
    if (!loopbackHosts.has(simulatorOrigin.hostname.toLowerCase())) {
      throw new AgentRuntimeError(
        "CONFIGURATION_ERROR",
        "Development side-effect execution requires a loopback Simulator origin",
      );
    }
  }
  const clock = options.clock ?? new SystemClock();
  const simulator = new SimulatorClient({ baseUrl: options.simulatorBaseUrl });
  const contextProvider = new SimulatorContextProvider({
    simulator,
    weather: options.weather ?? DEFAULT_WEATHER,
    user: options.user ?? DEFAULT_USER,
    capabilities: options.capabilities,
    serviceAvailability: options.serviceAvailability,
    ...(options.capabilitiesProvider === undefined
      ? {}
      : { capabilitiesProvider: options.capabilitiesProvider }),
    ...(options.serviceAvailabilityProvider === undefined
      ? {}
      : { serviceAvailabilityProvider: options.serviceAvailabilityProvider }),
  });
  const snapshotBuilder = new ContextSnapshotBuilder({
    clock,
    versionAllocator: new ContextVersionAllocator(),
    snapshotIdAllocator: new ContextSnapshotIdAllocator("phase5-context"),
  });
  const contextLoader = new ContextLoader({
    provider: contextProvider,
    snapshotBuilder,
    freshnessEvaluator: new ContextFreshnessEvaluator(clock),
    ...(options.latestContextVersionProvider === undefined
      ? {}
      : {
          latestVersionProvider: (snapshot: { readonly contextVersion: number }) =>
            options.latestContextVersionProvider?.(snapshot.contextVersion),
        }),
  });
  const registry = createDriveGuardToolRegistry({
    simulator,
    weatherProvider: new DevelopmentWeatherProvider({
      condition: (options.weather ?? DEFAULT_WEATHER).condition,
      temperatureC: (options.weather ?? DEFAULT_WEATHER).temperatureC,
    }),
    emergencySupportProvider: new DevelopmentEmergencySupportProvider(),
  });
  const policyProfiles = createDefaultToolPolicyProfileRegistry();
  const policyEngine = new PolicyEngine({ profiles: policyProfiles });
  const trustedConfirmationChallengeChannel =
    options.trustedConfirmationChallengeChannel ??
    new InMemoryTrustedConfirmationChallengeChannel(clock);
  const configuredActionLifecycleEventSink =
    options.actionLifecycleEventSink ?? new InMemoryActionLifecycleEventSink();
  const actionLifecycleEventSink: ActionLifecycleEventSink = {
    async emit(event: ActionLifecycleEvent): Promise<void> {
      let deliveryFailure: unknown;
      try {
        await configuredActionLifecycleEventSink.emit(event);
      } catch (error) {
        deliveryFailure = error;
      }
      if (event.state !== "AWAITING_CONFIRMATION") {
        try {
          trustedConfirmationChallengeChannel.discard(event.actionId);
        } catch (error) {
          deliveryFailure ??= error;
        }
      }
      if (deliveryFailure instanceof Error) throw deliveryFailure;
      if (deliveryFailure !== undefined) {
        throw new Error("Action lifecycle event delivery failed", { cause: deliveryFailure });
      }
    },
  };
  const confirmationService = new ConfirmationService({
    clock,
    eventSink: actionLifecycleEventSink,
    isTrustedDefinition: (definition) => registry.get(definition.name) === definition,
    revalidator: new ContextRevalidator({
      freshnessEvaluator: new ContextFreshnessEvaluator(clock),
      profiles: policyProfiles,
      definitionProvider: (toolName) => registry.get(toolName),
      currentContextProvider: async () => {
        const current = await contextLoader.load();
        return {
          snapshot: current.snapshot,
          latestContextVersion: current.freshness.context.latestVersion,
          availability: {
            capabilities: current.snapshot.capabilities,
            services: current.services,
          },
        };
      },
    }),
  });
  const reliableExecutor = new ReliableToolExecutor({
    registry,
    authorizationConsumer: confirmationService,
    clock,
    ...(options.executionEventSink === undefined ? {} : { eventSink: options.executionEventSink }),
  });
  return new DriveGuardAgentRuntime({
    model: options.model,
    streamFn: options.streamFn,
    contextLoader,
    toolRegistry: registry,
    clock,
    policyEngine,
    policyProfiles,
    confirmationService,
    trustedConfirmationChallengeChannel,
    reliableExecutor,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.developmentExecutionOptIn === undefined
      ? {}
      : { developmentExecutionOptIn: options.developmentExecutionOptIn }),
    ...(options.sensitiveValues === undefined ? {} : { sensitiveValues: options.sensitiveValues }),
    ...(options.runtimeOverrides ?? {}),
  });
}

export function createLiveProductionDriveGuardRuntime(
  simulatorBaseUrl = process.env.SIMULATOR_BASE_URL ?? "http://127.0.0.1:3001",
): { readonly runtime: ProductionDriveGuardRuntime; readonly selection: DeepSeekPhase5Selection } {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new AgentRuntimeError(
      "CONFIGURATION_ERROR",
      "DEEPSEEK_API_KEY is required for the Phase 5 live DeepSeek runtime",
    );
  }
  const mode = parsePhase5RuntimeMode(process.env.PHASE_5_RUNTIME_MODE);
  const selection = createDeepSeekPhase5Selection();
  const runtime = createProductionDriveGuardRuntime({
    model: selection.model,
    streamFn: selection.models.streamSimple.bind(selection.models),
    simulatorBaseUrl,
    capabilities: DEFAULT_PHASE_5_CAPABILITIES,
    serviceAvailability: DEFAULT_PHASE_5_SERVICES,
    mode,
    developmentExecutionOptIn:
      mode === "development" && process.env.PHASE_5_DEVELOPMENT_OPT_IN === "NON_PRODUCTION",
    sensitiveValues: [apiKey],
  });
  return { runtime, selection };
}
