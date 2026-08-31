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

import { ApiError } from "./errors.js";
import type { Phase10RuntimeFactory, Phase10RuntimeFactoryInput } from "./service.js";

type RuntimeSelection = Readonly<{
  model: ReturnType<typeof fauxProvider>["models"][number];
  streamFn: ReturnType<typeof createModels>["streamSimple"];
  sensitiveValues: readonly string[];
}>;

function fauxSelection(prompt: string | undefined): RuntimeSelection {
  const faux = fauxProvider({
    provider: `driveguard-phase10-faux-${randomUUID()}`,
    api: `phase10-faux-${randomUUID()}`,
    tokensPerSecond: 2_000,
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const normalized = prompt?.toLowerCase() ?? "";
  if (/(reserve|charging|charge)/u.test(normalized)) {
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "reserve_charging_slot",
          { stationId: "station-pudong-001" },
          { id: `tool:${randomUUID()}` },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Confirmation is required before reserving the charging slot."),
    ]);
  } else if (/(vehicle|state|battery|soc)/u.test(normalized)) {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("get_vehicle_state", {}, { id: `tool:${randomUUID()}` }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("The current vehicle state has been retrieved safely."),
    ]);
  } else {
    faux.setResponses([fauxAssistantMessage("DriveGuard is ready for your request.")]);
  }
  return Object.freeze({
    model: faux.getModel(),
    streamFn: models.streamSimple.bind(models),
    sensitiveValues: Object.freeze([]),
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

  constructor(options: {
    readonly bindings: Phase9RuntimeBindings;
    readonly simulatorBaseUrl: string;
    readonly provider: string;
    readonly trustedSimulatorOrigins?: readonly string[];
    readonly observability?: DriveGuardObservability;
  }) {
    this.#bindings = options.bindings;
    this.#simulatorBaseUrl = options.simulatorBaseUrl;
    this.#provider = options.provider;
    this.#trustedSimulatorOrigins = Object.freeze([...(options.trustedSimulatorOrigins ?? [])]);
    this.#observability = options.observability;
  }

  create(input: Phase10RuntimeFactoryInput) {
    const selected = selection(this.#provider, input.prompt);
    const executionEventSink = combinedExecutionSink(
      this.#bindings.executionEventSink,
      input.executionEventSink,
      this.#observability?.executionEventSink,
    );
    const runtimeEventSink = combinedRuntimeSink(
      input.runtimeEventSink,
      this.#observability?.runtimeEventSink,
    );
    const actionLifecycleEventSink = combinedActionSink(
      input.actionLifecycleEventSink,
      this.#observability?.actionLifecycleEventSink,
    );
    const mode = parsePhase5RuntimeMode(process.env.PHASE_5_RUNTIME_MODE);
    return createPhase9ProductionDriveGuardRuntime(
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
        ...(actionLifecycleEventSink === undefined ? {} : { actionLifecycleEventSink }),
        runtimeOverrides:
          runtimeEventSink === undefined &&
          input.assistantTextDeltaSink === undefined &&
          this.#observability === undefined
            ? {}
            : {
                ...(runtimeEventSink === undefined ? {} : { eventSink: runtimeEventSink }),
                ...(input.assistantTextDeltaSink === undefined
                  ? {}
                  : { assistantTextDeltaSink: input.assistantTextDeltaSink }),
                ...(this.#observability === undefined
                  ? {}
                  : {
                      modelUsageSink: (
                        usage: Parameters<DriveGuardObservability["observeModelUsage"]>[0],
                      ) => this.#observability?.observeModelUsage(usage),
                    }),
              },
      },
      { ...this.#bindings, executionEventSink },
    );
  }
}
