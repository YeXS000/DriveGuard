import { buildApi } from "./app.js";
import { createInfrastructureProbes, readInfrastructureConfig } from "./dependencies.js";

function readApiPort(environment: NodeJS.ProcessEnv = process.env): number {
  const port = Number(environment.PORT ?? "3000");

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  return port;
}

async function main(): Promise<void> {
  const dependencies = createInfrastructureProbes(readInfrastructureConfig());
  const app = buildApi({ dependencies, logger: true });
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
