import { createModels, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  ConfirmationService,
  ContextRevalidator,
  InMemoryActionLifecycleEventSink,
  type ActionLifecycleEvent,
  type ActionLifecycleEventSink,
  type PendingActionRepository,
} from "@driveguard/action-lifecycle";
import type { ServiceAvailability } from "@driveguard/capabilities";
import {
  ContextFreshnessEvaluator,
  ContextSnapshotBuilder,
  ContextSnapshotIdAllocator,
  ContextVersionAllocator,
} from "@driveguard/context";
import type { DrivingUser, VehicleCapabilities, WeatherState } from "@driveguard/domain";
import {
  CircuitBreaker,
  ExecutionConcurrencyController,
  RecoveryManager,
  ReliableToolExecutor,
  type DurableExecutionCoordinator,
  type ExecutionEventSink,
} from "@driveguard/executor";
import type { ConversationMemory, SessionCoordinator } from "@driveguard/memory";
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
    | "runIdFactory"
    | "traceIdFactory"
    | "eventIdFactory"
    | "eventSink"
    | "assistantTextDeltaSink"
    | "modelUsageSink"
  >;
  readonly actionLifecycleEventSink?: ActionLifecycleEventSink;
  readonly executionEventSink?: ExecutionEventSink;
  readonly circuitBreaker?: CircuitBreaker;
  readonly executionConcurrencyController?: ExecutionConcurrencyController;
  readonly trustedConfirmationChallengeChannel?: TrustedConfirmationChallengeChannel;
  readonly pendingActionRepository?: PendingActionRepository;
  readonly durableExecutionCoordinator?: DurableExecutionCoordinator;
  readonly conversationMemory?: ConversationMemory;
  readonly sessionCoordinator?: SessionCoordinator;
  /** Exact non-production Simulator origins permitted in addition to loopback. */
  readonly developmentTrustedSimulatorOrigins?: readonly string[];
}

export interface Phase9DurableRuntimeBindings {
  readonly pendingActionRepository: PendingActionRepository;
  readonly durableExecutionCoordinator: DurableExecutionCoordinator;
  readonly executionEventSink: ExecutionEventSink;
  readonly conversationMemory: ConversationMemory;
  readonly sessionCoordinator: SessionCoordinator;
}

function requireBindingMethods(
  bindingName: string,
  binding: unknown,
  methods: readonly string[],
): void {
  if (typeof binding !== "object" || binding === null) {
    throw new AgentRuntimeError("CONFIGURATION_ERROR", `${bindingName} binding is required`);
  }
  for (const method of methods) {
    if (typeof Reflect.get(binding, method) !== "function") {
      throw new AgentRuntimeError(
        "CONFIGURATION_ERROR",
        `${bindingName}.${method} binding is required`,
      );
    }
  }
}

function assertPhase9Bindings(bindings: Phase9DurableRuntimeBindings): void {
  requireBindingMethods("pendingActionRepository", bindings?.pendingActionRepository, [
    "create",
    "get",
    "runExclusive",
    "transition",
    "acceptConfirmation",
    "authorize",
    "consumeAuthorization",
  ]);
  requireBindingMethods("durableExecutionCoordinator", bindings?.durableExecutionCoordinator, [
    "execute",
  ]);
  requireBindingMethods("executionEventSink", bindings?.executionEventSink, ["emit"]);
  requireBindingMethods("conversationMemory", bindings?.conversationMemory, [
    "restore",
    "bindIdentity",
    "appendTurn",
  ]);
  requireBindingMethods("sessionCoordinator", bindings?.sessionCoordinator, [
    "acquire",
    "renew",
    "release",
  ]);
  if (
    !Number.isSafeInteger(bindings.sessionCoordinator.leaseDurationMs) ||
    bindings.sessionCoordinator.leaseDurationMs < 1
  ) {
    throw new AgentRuntimeError(
      "CONFIGURATION_ERROR",
      "sessionCoordinator.leaseDurationMs binding is invalid",
    );
  }
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
  requestedBaseUrl = process.env.DEEPSEEK_BASE_URL,
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
  let model = selected;
  if (requestedBaseUrl !== undefined && requestedBaseUrl.trim().length > 0) {
    let parsed: URL;
    try {
      parsed = new URL(requestedBaseUrl);
    } catch {
      throw new AgentRuntimeError("CONFIGURATION_ERROR", "DEEPSEEK_BASE_URL is invalid");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      throw new AgentRuntimeError(
        "CONFIGURATION_ERROR",
        "DEEPSEEK_BASE_URL must be a credential-free HTTPS URL",
      );
    }
    model = Object.freeze({ ...selected, baseUrl: parsed.toString().replace(/\/$/u, "") });
  }
  return {
    models,
    model,
    modelId: model.id,
    providerId: "deepseek",
    api: model.api,
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
    const trustedOrigins = new Set(options.developmentTrustedSimulatorOrigins ?? []);
    if (
      !loopbackHosts.has(simulatorOrigin.hostname.toLowerCase()) &&
      !trustedOrigins.has(simulatorOrigin.origin)
    ) {
      throw new AgentRuntimeError(
        "CONFIGURATION_ERROR",
        "Development side-effect execution requires a loopback Simulator origin",
      );
    }
  }
  const clock = options.clock ?? new SystemClock();
  const simulator = new SimulatorClient({ baseUrl: options.simulatorBaseUrl });
  const recoveryManager = new RecoveryManager();
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
    recoveryManager,
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
    ...(options.pendingActionRepository === undefined
      ? {}
      : { repository: options.pendingActionRepository }),
  });
  const reliableExecutor = new ReliableToolExecutor({
    registry,
    authorizationConsumer: confirmationService,
    clock,
    recoveryManager,
    reconciler: {
      async reconcile(input) {
        if (input.toolName !== "reserve_charging_slot") return { status: "UNKNOWN" };
        const argumentsRecord =
          typeof input.validatedArguments === "object" && input.validatedArguments !== null
            ? (input.validatedArguments as Readonly<Record<string, unknown>>)
            : {};
        const stationId = argumentsRecord.stationId;
        if (typeof stationId !== "string") return { status: "UNKNOWN" };
        const status = await simulator.getChargingStatus();
        const reservation = status.reservations.find(
          (candidate) => candidate.stationId === stationId && candidate.status === "active",
        );
        return reservation === undefined
          ? { status: "NOT_EXECUTED" }
          : { status: "EXECUTED", result: { reservation } };
      },
    },
    ...(options.executionEventSink === undefined ? {} : { eventSink: options.executionEventSink }),
    ...(options.circuitBreaker === undefined ? {} : { circuitBreaker: options.circuitBreaker }),
    ...(options.executionConcurrencyController === undefined
      ? {}
      : { concurrencyController: options.executionConcurrencyController }),
    ...(options.durableExecutionCoordinator === undefined
      ? {}
      : { durableCoordinator: options.durableExecutionCoordinator }),
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
    ...(options.conversationMemory === undefined
      ? {}
      : { conversationMemory: options.conversationMemory }),
    ...(options.sessionCoordinator === undefined
      ? {}
      : { sessionCoordinator: options.sessionCoordinator }),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.developmentExecutionOptIn === undefined
      ? {}
      : { developmentExecutionOptIn: options.developmentExecutionOptIn }),
    ...(options.sensitiveValues === undefined ? {} : { sensitiveValues: options.sensitiveValues }),
    ...(options.runtimeOverrides ?? {}),
  });
}

export function createPhase9ProductionDriveGuardRuntime(
  options: Omit<
    CreateProductionRuntimeOptions,
    | "pendingActionRepository"
    | "durableExecutionCoordinator"
    | "executionEventSink"
    | "conversationMemory"
    | "sessionCoordinator"
  >,
  bindings: Phase9DurableRuntimeBindings,
): ProductionDriveGuardRuntime {
  assertPhase9Bindings(bindings);
  return createProductionDriveGuardRuntime({
    ...options,
    pendingActionRepository: bindings.pendingActionRepository,
    durableExecutionCoordinator: bindings.durableExecutionCoordinator,
    executionEventSink: bindings.executionEventSink,
    conversationMemory: bindings.conversationMemory,
    sessionCoordinator: bindings.sessionCoordinator,
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

export function createLivePhase9ProductionDriveGuardRuntime(
  bindings: Phase9DurableRuntimeBindings,
  simulatorBaseUrl = process.env.SIMULATOR_BASE_URL ?? "http://127.0.0.1:3001",
): { readonly runtime: ProductionDriveGuardRuntime; readonly selection: DeepSeekPhase5Selection } {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new AgentRuntimeError(
      "CONFIGURATION_ERROR",
      "DEEPSEEK_API_KEY is required for the live Phase 9 runtime",
    );
  }
  const mode = parsePhase5RuntimeMode(process.env.PHASE_5_RUNTIME_MODE);
  const selection = createDeepSeekPhase5Selection();
  return {
    selection,
    runtime: createPhase9ProductionDriveGuardRuntime(
      {
        model: selection.model,
        streamFn: selection.models.streamSimple.bind(selection.models),
        simulatorBaseUrl,
        capabilities: DEFAULT_PHASE_5_CAPABILITIES,
        serviceAvailability: DEFAULT_PHASE_5_SERVICES,
        mode,
        developmentExecutionOptIn:
          mode === "development" && process.env.PHASE_5_DEVELOPMENT_OPT_IN === "NON_PRODUCTION",
        sensitiveValues: [apiKey],
      },
      bindings,
    ),
  };
}
