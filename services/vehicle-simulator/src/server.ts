import { buildVehicleSimulator } from "./http.js";

function readPort(environment: NodeJS.ProcessEnv = process.env): number {
  const port = Number(environment.PORT ?? "3001");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

async function main(): Promise<void> {
  const app = buildVehicleSimulator({ logger: true });
  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await app.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await app.listen({ host: "0.0.0.0", port: readPort() });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown startup error";
  process.stderr.write(`Vehicle simulator failed to start: ${message}\n`);
  process.exitCode = 1;
});
