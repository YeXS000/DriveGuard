import { buildApi } from "./app.js";
import { createInfrastructureProbes, readInfrastructureConfig } from "./dependencies.js";
import { createClient } from "redis";
import { createPhase9RuntimeBindings } from "@driveguard/persistence";
import { DriveGuardObservability } from "@driveguard/observability";
import { connect } from "@nats-io/transport-node";
import { SystemClock } from "@driveguard/shared";
import {
  UrgentEventConsumer,
  UrgentEventNotificationHub,
  UrgentEventProcessor,
  createUrgentActionSystem,
} from "@driveguard/urgent-events";

import { ProductionPhase10RuntimeFactory } from "./production.js";
import { DriveGuardApiService } from "./service.js";
import { UrgentApiService } from "./urgent.js";

function readApiPort(environment: NodeJS.ProcessEnv = process.env): number {
  const port = Number(environment.PORT ?? "3000");

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  return port;
}

async function main(): Promise<void> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const observability = new DriveGuardObservability({
    service: "driveguard-api",
    logLevel: process.env.LOG_LEVEL ?? "info",
    sensitiveValues: apiKey === undefined || apiKey.length === 0 ? [] : [apiKey],
    ...(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT === undefined
      ? {}
      : { otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT }),
    registerGlobalTracing: true,
  });
  const config = readInfrastructureConfig();
  const redis = createClient({ url: config.redisUrl });
  redis.on("error", () => undefined);
  await redis.connect();
  const bindings = createPhase9RuntimeBindings({ postgres: config.postgres, redis });
  const simulatorBaseUrl = process.env.SIMULATOR_BASE_URL ?? "http://127.0.0.1:3001";
  const runtimeFactory = new ProductionPhase10RuntimeFactory({
    bindings,
    simulatorBaseUrl,
    provider: process.env.DRIVEGUARD_LLM_PROVIDER ?? "deepseek",
    trustedSimulatorOrigins: (process.env.DRIVEGUARD_DEVELOPMENT_SIMULATOR_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
    observability,
  });
  const service = new DriveGuardApiService({
    sessions: bindings.sessionRepository,
    conversation: bindings.conversationMemory,
    executions: bindings.executionRepository,
    runtimeFactory,
  });
  const urgentUserId = process.env.URGENT_EVENT_USER_ID ?? "phase5-driver";
  const urgentConfirmationSecret = process.env.URGENT_CONFIRMATION_SECRET;
  if (urgentConfirmationSecret === undefined || urgentConfirmationSecret.length < 32) {
    throw new Error("URGENT_CONFIRMATION_SECRET must contain at least 32 characters");
  }
  const urgentConnection = await connect({
    servers: config.natsUrl,
    name: "driveguard-phase12-urgent-consumer",
  });
  const clock = new SystemClock();
  const executionEventSink = {
    emit: async (event: Parameters<typeof bindings.executionEventSink.emit>[0]) => {
      await bindings.executionEventSink.emit(event);
      await observability.executionEventSink.emit(event);
    },
  };
  const urgentActionSystem = createUrgentActionSystem({
    simulatorBaseUrl,
    userId: urgentUserId,
    confirmationSecret: urgentConfirmationSecret,
    pendingActionRepository: bindings.pendingActionRepository,
    durableExecutionCoordinator: bindings.durableExecutionCoordinator,
    executionEventSink,
    sessionRepository: bindings.sessionRepository,
    sessionCoordinator: bindings.sessionCoordinator,
    executionRecovery: {
      get: async (executionId) => {
        const envelope = await bindings.executionRepository.getEnvelope(executionId);
        return envelope === undefined
          ? undefined
          : { request: envelope.request, result: envelope.result };
      },
    },
    actionLifecycleEventSink: observability.actionLifecycleEventSink,
    observer: observability.urgentEventObserver,
    clock,
  });
  const urgentHub = new UrgentEventNotificationHub();
  const urgentProcessor = new UrgentEventProcessor({
    repository: bindings.urgentEventRepository,
    contextLoader: urgentActionSystem.contextLoader,
    dispatcher: urgentActionSystem.dispatcher,
    clock,
    userId: urgentUserId,
    notificationSink: urgentHub,
    observer: observability.urgentEventObserver,
  });
  const urgentConsumer = new UrgentEventConsumer({
    connection: urgentConnection,
    processor: urgentProcessor,
  });
  await urgentConsumer.start();
  const urgentService = new UrgentApiService({
    repository: bindings.urgentEventRepository,
    hub: urgentHub,
    userId: urgentUserId,
  });
  const dependencies = createInfrastructureProbes(config);
  const app = buildApi({
    dependencies,
    service,
    logger: false,
    observability,
    urgentService,
    onClose: async () => {
      await urgentConsumer.stop();
      if (!urgentConnection.isClosed()) await urgentConnection.drain();
      await bindings.close();
      if (redis.isOpen) await redis.quit();
      await observability.shutdown();
    },
  });
  let closing = false;

  const shutdown = async (): Promise<void> => {
    if (closing) {
      return;
    }

    closing = true;
    await app.close();
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });

  await app.listen({ host: "0.0.0.0", port: readApiPort() });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown startup error";
  process.stderr.write(`DriveGuard API failed to start: ${message}\n`);
  process.exitCode = 1;
});
