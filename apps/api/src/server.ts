import { buildApi } from "./app.js";
import { createInfrastructureProbes, readInfrastructureConfig } from "./dependencies.js";
import { createClient } from "redis";
import { createPhase9RuntimeBindings } from "@driveguard/persistence";
import { DriveGuardObservability } from "@driveguard/observability";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { SystemClock } from "@driveguard/shared";
import { CircuitBreaker, ExecutionConcurrencyController } from "@driveguard/executor";
import {
  UrgentEventConsumer,
  UrgentEventNotificationHub,
  UrgentEventProcessor,
  URGENT_NATS,
  createUrgentActionSystem,
} from "@driveguard/urgent-events";

import { ProductionPhase10RuntimeFactory } from "./production.js";
import { DriveGuardApiService } from "./service.js";
import { UrgentApiService } from "./urgent.js";
import { RequestAdmissionController } from "./admission-control.js";
import { assertProductionSecurityConfiguration } from "./production-security.js";
import { readRequestAuthentication } from "./authentication.js";
import { gracefulShutdown, GracefulShutdownTimeoutError } from "./shutdown.js";

function readApiPort(environment: NodeJS.ProcessEnv = process.env): number {
  const port = Number(environment.PORT ?? "3000");

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  return port;
}

function readBoundedInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const value = Number(environment[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

async function main(): Promise<void> {
  assertProductionSecurityConfiguration();
  const authentication = readRequestAuthentication();
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
  const redis = createClient({
    url: config.redisUrl,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 1_500,
      reconnectStrategy: (retries) => Math.min(50 * 2 ** Math.min(retries, 5), 1_000),
    },
  });
  redis.on("error", () => undefined);
  await redis.connect();
  const bindings = createPhase9RuntimeBindings({ postgres: config.postgres, redis });
  const clock = new SystemClock();
  const maxConcurrentRequests = readBoundedInteger(
    "DRIVEGUARD_MAX_CONCURRENT_REQUESTS",
    32,
    1,
    1_000,
  );
  const admissionController = new RequestAdmissionController({
    maxConcurrent: maxConcurrentRequests,
    maxQueue: readBoundedInteger("DRIVEGUARD_MAX_REQUEST_QUEUE", 64, 1, 10_000),
    queueTimeoutMs: readBoundedInteger("DRIVEGUARD_REQUEST_QUEUE_TIMEOUT_MS", 500, 1, 60_000),
    observer: (snapshot) => observability.observeAdmission(snapshot),
  });
  const executionConcurrencyController = new ExecutionConcurrencyController({
    maxReadConcurrency: readBoundedInteger("DRIVEGUARD_MAX_READ_EXECUTIONS", 4, 1, 128),
    maxWriteConcurrency: readBoundedInteger("DRIVEGUARD_MAX_WRITE_EXECUTIONS", 8, 1, 128),
    maxQueue: readBoundedInteger("DRIVEGUARD_MAX_EXECUTOR_QUEUE", 256, 1, 10_000),
    queueTimeoutMs: readBoundedInteger("DRIVEGUARD_EXECUTOR_QUEUE_TIMEOUT_MS", 5_000, 1, 120_000),
    observer: (snapshot) => observability.observeExecutionCapacity(snapshot),
  });
  const circuitBreaker = new CircuitBreaker({ clock });
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
    circuitBreaker,
    executionConcurrencyController,
    runtimeCacheLimit: maxConcurrentRequests,
    conversationHistoryLimit: readBoundedInteger(
      "DRIVEGUARD_CONVERSATION_HISTORY_LIMIT",
      40,
      1,
      1_000,
    ),
  });
  const service = new DriveGuardApiService({
    sessions: bindings.sessionRepository,
    conversation: bindings.conversationMemory,
    executions: bindings.executionRepository,
    runtimeFactory,
    agentTimeoutMs: readBoundedInteger("DRIVEGUARD_AGENT_TIMEOUT_MS", 15_000, 100, 300_000),
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
    circuitBreaker,
    executionConcurrencyController,
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
  const urgentManager = await jetstreamManager(urgentConnection);
  const app = buildApi({
    dependencies,
    service,
    logger: false,
    observability,
    urgentService,
    admissionController,
    authentication,
    resourceSampler: async () => {
      let natsPending = 0;
      let natsAckPending = 0;
      try {
        const info = await urgentManager.consumers.info(URGENT_NATS.stream, URGENT_NATS.durable);
        natsPending = info.num_pending;
        natsAckPending = info.num_ack_pending;
      } catch {
        // Dependency readiness remains authoritative when NATS is unavailable.
      }
      observability.observeInfrastructure({
        postgresTotal: bindings.database.pool.totalCount,
        postgresIdle: bindings.database.pool.idleCount,
        postgresWaiting: bindings.database.pool.waitingCount,
        redisReady: redis.isReady,
        natsPending,
        natsAckPending,
      });
      observability.observeRuntimeResources({
        activeRequests: service.activeRequestCount,
        ...runtimeFactory.resourceSnapshot(),
      });
    },
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
    try {
      await gracefulShutdown({
        app,
        admissionController,
        timeoutMs: readBoundedInteger("DRIVEGUARD_SHUTDOWN_TIMEOUT_MS", 30_000, 100, 300_000),
      });
    } catch (error) {
      service.cancelAll();
      app.server.closeAllConnections();
      await app.close();
      if (error instanceof GracefulShutdownTimeoutError) process.exitCode = 1;
      else throw error;
    }
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
