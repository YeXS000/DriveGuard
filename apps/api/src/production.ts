import { randomUUID } from "node:crypto";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  createDeepSeekPhase5Selection,
  createPhase9ProductionDriveGuardRuntime,
  DEFAULT_PHASE_5_CAPABILITIES,
  DEFAULT_PHASE_5_SERVICES,
  parsePhase5RuntimeMode,
} from "@driveguard/agent-runtime";
import type { ExecutionEventSink } from "@driveguard/executor";
import type { UserId } from "@driveguard/domain";
import type { Phase9RuntimeBindings } from "@driveguard/persistence";
import type { DriveGuardObservability } from "@driveguard/observability";
import type { ActionLifecycleEventSink } from "@driveguard/action-lifecycle";
import type { RuntimeEventSink } from "@driveguard/agent-runtime";
import type { CircuitBreaker, ExecutionConcurrencyController } from "@driveguard/executor";

import { ApiError } from "./errors.js";
import type { Phase10RuntimeFactory, Phase10RuntimeFactoryInput } from "./service.js";

type RuntimeSelection = Readonly<{
  model: ReturnType<typeof fauxProvider>["models"][number];
  streamFn: ReturnType<typeof createModels>["streamSimple"];
  sensitiveValues: readonly string[];
  prepare?: (prompt: string | undefined) => void;
}>;

function fauxResponses(prompt: string | undefined) {
  const normalized = prompt?.toLowerCase() ?? "";
  if (normalized.includes("phase14:multi_tool")) {
    return [
      fauxAssistantMessage(
        [
          fauxToolCall("get_vehicle_state", {}, { id: `tool:${randomUUID()}` }),
          fauxToolCall("get_trip_state", {}, { id: `tool:${randomUUID()}` }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("The vehicle and trip state were retrieved safely."),
    ];
  }
  if (/(reserve|charging|charge|phase14:protected_action)/u.test(normalized)) {
    return [
      fauxAssistantMessage(
        fauxToolCall(
          "reserve_charging_slot",
          { stationId: "station-pudong-001" },
          { id: `tool:${randomUUID()}` },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Confirmation is required before reserving the charging slot."),
    ];
  }
  if (/(vehicle|state|battery|soc)/u.test(normalized)) {
    return [
      fauxAssistantMessage(fauxToolCall("get_vehicle_state", {}, { id: `tool:${randomUUID()}` }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("The current vehicle state has been retrieved safely."),
    ];
  }
  return [fauxAssistantMessage("DriveGuard is ready for your request.")];
}

function fauxSelection(prompt: string | undefined): RuntimeSelection {
  const faux = fauxProvider({
    provider: `driveguard-phase10-faux-${randomUUID()}`,
    api: `phase10-faux-${randomUUID()}`,
    tokensPerSecond: 2_000,
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const prepare = (nextPrompt: string | undefined) => faux.setResponses(fauxResponses(nextPrompt));
  prepare(prompt);
  return Object.freeze({
    model: faux.getModel(),
    streamFn: models.streamSimple.bind(models),
    sensitiveValues: Object.freeze([]),
    prepare,
  });
}

function selection(provider: string, prompt: string | undefined): RuntimeSelection {
  if (provider === "faux") return fauxSelection(prompt);
  if (provider !== "deepseek") {
    throw new ApiError("INTERNAL_ERROR", "LLM provider configuration is invalid", 500);
  }
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new ApiError("INTERNAL_ERROR", "DeepSeek runtime is not configured", 500);
  }
  const selected = createDeepSeekPhase5Selection();
  return Object.freeze({
    model: selected.model,
    streamFn: selected.models.streamSimple.bind(selected.models),
    sensitiveValues: Object.freeze([apiKey]),
  });
}

function combinedExecutionSink(
  durable: ExecutionEventSink,
  additional: ExecutionEventSink | undefined,
  observability: ExecutionEventSink | undefined,
): ExecutionEventSink {
  return {
    async emit(event): Promise<void> {
      await durable.emit(event);
      for (const observer of [additional, observability]) {
        try {
          await observer?.emit(event);
        } catch {
          // UI and observability delivery are best effort after durable safety audit commits.
        }
      }
    },
  };
}

function combinedRuntimeSink(
  primary: RuntimeEventSink | undefined,
  observability: RuntimeEventSink | undefined,
): RuntimeEventSink | undefined {
  if (primary === undefined && observability === undefined) return undefined;
  return {
    async emit(event): Promise<void> {
      await primary?.emit(event);
      try {
        await observability?.emit(event);
      } catch {
        // Observability must not change Runtime settlement.
      }
    },
  };
}

function combinedActionSink(
  primary: ActionLifecycleEventSink | undefined,
  observability: ActionLifecycleEventSink | undefined,
): ActionLifecycleEventSink | undefined {
  if (primary === undefined && observability === undefined) return undefined;
  return {
    async emit(event): Promise<void> {
      await primary?.emit(event);
      try {
        await observability?.emit(event);
      } catch {
        // Observability must not change confirmation state transitions.
      }
    },
  };
}

export class ProductionPhase10RuntimeFactory implements Phase10RuntimeFactory {
  readonly #bindings: Phase9RuntimeBindings;
  readonly #simulatorBaseUrl: string;
  readonly #provider: string;
  readonly #trustedSimulatorOrigins: readonly string[];
  readonly #observability: DriveGuardObservability | undefined;
  readonly #circuitBreaker: CircuitBreaker | undefined;
  readonly #executionConcurrencyController: ExecutionConcurrencyController | undefined;
  readonly #conversationHistoryLimit: number | undefined;
  readonly #runtimeCacheLimit: number;
  readonly #runtimeCache = new Map<
    string,
    {
      readonly runtime: ReturnType<typeof createPhase9ProductionDriveGuardRuntime>;
      readonly slot: { current: Phase10RuntimeFactoryInput };
      readonly prepare?: (prompt: string | undefined) => void;
      readonly identity: Phase10RuntimeFactoryInput["identity"];
    }
  >();

  constructor(options: {
    readonly bindings: Phase9RuntimeBindings;
    readonly simulatorBaseUrl: string;
    readonly provider: string;
    readonly trustedSimulatorOrigins?: readonly string[];
    readonly observability?: DriveGuardObservability;
    readonly circuitBreaker?: CircuitBreaker;
    readonly executionConcurrencyController?: ExecutionConcurrencyController;
    readonly conversationHistoryLimit?: number;
    readonly runtimeCacheLimit?: number;
  }) {
    this.#bindings = options.bindings;
    this.#simulatorBaseUrl = options.simulatorBaseUrl;
    this.#provider = options.provider;
    this.#trustedSimulatorOrigins = Object.freeze([...(options.trustedSimulatorOrigins ?? [])]);
    this.#observability = options.observability;
    this.#circuitBreaker = options.circuitBreaker;
    this.#executionConcurrencyController = options.executionConcurrencyController;
    this.#conversationHistoryLimit = options.conversationHistoryLimit;
    this.#runtimeCacheLimit = options.runtimeCacheLimit ?? 32;
  }

  create(input: Phase10RuntimeFactoryInput) {
    const cacheKey = input.sessionId;
    const cached = cacheKey === undefined ? undefined : this.#runtimeCache.get(cacheKey);
    if (cacheKey !== undefined && cached !== undefined) {
      if (
        cached.identity.userId !== input.identity.userId ||
        cached.identity.vehicleId !== input.identity.vehicleId
      ) {
        throw new ApiError("INTERNAL_ERROR", "Session identity boundary failed safely", 500);
      }
      cached.slot.current = input;
      cached.prepare?.(input.prompt);
      this.#runtimeCache.delete(cacheKey);
      this.#runtimeCache.set(cacheKey, cached);
      return cached.runtime;
    }
    const selected = selection(this.#provider, input.prompt);
    const slot = { current: input };
    const executionEventSink = combinedExecutionSink(
      this.#bindings.executionEventSink,
      { emit: (event) => slot.current.executionEventSink?.emit(event) },
      this.#observability?.executionEventSink,
    );
    const runtimeEventSink = combinedRuntimeSink(
      { emit: (event) => slot.current.runtimeEventSink?.emit(event) },
      this.#observability?.runtimeEventSink,
    );
    const actionLifecycleEventSink = combinedActionSink(
      { emit: (event) => slot.current.actionLifecycleEventSink?.emit(event) },
      this.#observability?.actionLifecycleEventSink,
    );
    const mode = parsePhase5RuntimeMode(process.env.PHASE_5_RUNTIME_MODE);
    const runtime = createPhase9ProductionDriveGuardRuntime(
      {
        model: selected.model,
        streamFn: selected.streamFn,
        simulatorBaseUrl: this.#simulatorBaseUrl,
        capabilities: DEFAULT_PHASE_5_CAPABILITIES,
        serviceAvailability: DEFAULT_PHASE_5_SERVICES,
        user: { userId: input.identity.userId as UserId, role: "driver" },
        mode,
        developmentExecutionOptIn:
          mode === "development" && process.env.PHASE_5_DEVELOPMENT_OPT_IN === "NON_PRODUCTION",
        developmentTrustedSimulatorOrigins: this.#trustedSimulatorOrigins,
        sensitiveValues: selected.sensitiveValues,
        ...(this.#circuitBreaker === undefined ? {} : { circuitBreaker: this.#circuitBreaker }),
        ...(this.#executionConcurrencyController === undefined
          ? {}
          : { executionConcurrencyController: this.#executionConcurrencyController }),
        ...(actionLifecycleEventSink === undefined ? {} : { actionLifecycleEventSink }),
        runtimeOverrides:
          runtimeEventSink === undefined &&
          input.assistantTextDeltaSink === undefined &&
          this.#observability === undefined &&
          this.#conversationHistoryLimit === undefined
            ? {}
            : {
                ...(runtimeEventSink === undefined ? {} : { eventSink: runtimeEventSink }),
                assistantTextDeltaSink: (event) => slot.current.assistantTextDeltaSink?.(event),
                ...(this.#observability === undefined
                  ? {}
                  : {
                      modelUsageSink: (
                        usage: Parameters<DriveGuardObservability["observeModelUsage"]>[0],
                      ) => this.#observability?.observeModelUsage(usage),
                    }),
                ...(this.#conversationHistoryLimit === undefined
                  ? {}
                  : { conversationHistoryLimit: this.#conversationHistoryLimit }),
              },
      },
      { ...this.#bindings, executionEventSink },
    );
    if (cacheKey !== undefined) {
      this.#runtimeCache.set(cacheKey, {
        runtime,
        slot,
        ...(selected.prepare === undefined ? {} : { prepare: selected.prepare }),
        identity: Object.freeze({ ...input.identity }),
      });
      while (this.#runtimeCache.size > this.#runtimeCacheLimit) {
        const oldest = this.#runtimeCache.keys().next().value;
        if (oldest === undefined) break;
        this.#runtimeCache.delete(oldest);
      }
    }
    return runtime;
  }
}
