import { buildApi } from "./app.js";
import { createInfrastructureProbes, readInfrastructureConfig } from "./dependencies.js";
import { createClient } from "redis";
import { createPhase9RuntimeBindings } from "@driveguard/persistence";
import { DriveGuardObservability } from "@driveguard/observability";

import { ProductionPhase10RuntimeFactory } from "./production.js";
import { DriveGuardApiService } from "./service.js";

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
  const dependencies = createInfrastructureProbes(config);
  const app = buildApi({
    dependencies,
    service,
    logger: false,
    observability,
    onClose: async () => {
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
