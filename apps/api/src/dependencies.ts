import { jetstreamManager } from "@nats-io/jetstream";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import pg from "pg";
import { createClient } from "redis";

import type { DependencyProbe } from "./health.js";

const { Pool } = pg;

export interface InfrastructureConfig {
  readonly postgres: {
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly password: string;
    readonly database: string;
  };
  readonly redisUrl: string;
  readonly natsUrl: string;
}

function parsePort(value: string, variableName: string): number {
  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${variableName} must be an integer between 1 and 65535`);
  }

  return port;
}

function requiredValue(environment: NodeJS.ProcessEnv, variableName: string): string {
  const value = environment[variableName];

  if (value === undefined || value.length === 0) {
    throw new Error(`${variableName} is required`);
  }

  return value;
}

export function readInfrastructureConfig(
  environment: NodeJS.ProcessEnv = process.env,
): InfrastructureConfig {
  return {
    postgres: {
      host: environment.PGHOST ?? "127.0.0.1",
      port: parsePort(environment.PGPORT ?? "5432", "PGPORT"),
      user: environment.PGUSER ?? "driveguard",
      password: requiredValue(environment, "PGPASSWORD"),
      database: environment.PGDATABASE ?? "driveguard",
    },
    redisUrl: environment.REDIS_URL ?? "redis://127.0.0.1:6379",
    natsUrl: environment.NATS_URL ?? "nats://127.0.0.1:4222",
  };
}

export function createInfrastructureProbes(
  config: InfrastructureConfig,
): readonly DependencyProbe[] {
  const postgresPool = new Pool({
    ...config.postgres,
    connectionTimeoutMillis: 1_500,
    max: 2,
  });

  const redisClient = createClient({
    url: config.redisUrl,
    socket: {
      connectTimeout: 1_500,
      reconnectStrategy: false,
    },
  });
  redisClient.on("error", () => undefined);
  let redisConnection: ReturnType<typeof redisClient.connect> | undefined;

  async function ensureRedisConnection(): Promise<void> {
    if (redisClient.isReady) {
      return;
    }

    redisConnection ??= redisClient.connect().finally(() => {
      redisConnection = undefined;
    });
    await redisConnection;
  }

  let natsConnection: NatsConnection | undefined;
  let pendingNatsConnection: Promise<NatsConnection> | undefined;

  async function ensureNatsConnection(): Promise<NatsConnection> {
    if (natsConnection !== undefined && !natsConnection.isClosed()) {
      return natsConnection;
    }

    pendingNatsConnection ??= connect({
      servers: config.natsUrl,
      timeout: 1_500,
      maxReconnectAttempts: 0,
      name: "driveguard-phase0-readiness",
    }).finally(() => {
      pendingNatsConnection = undefined;
    });

    natsConnection = await pendingNatsConnection;
    return natsConnection;
  }

  return [
    {
      name: "postgres",
      check: async () => {
        await postgresPool.query("SELECT 1");
      },
      close: async () => {
        await postgresPool.end();
      },
    },
    {
      name: "redis",
      check: async () => {
        await ensureRedisConnection();
        await redisClient.ping();
      },
      close: async () => {
        if (redisClient.isOpen) {
          await redisClient.quit();
        }
      },
    },
    {
      name: "nats_jetstream",
      check: async () => {
        const connection = await ensureNatsConnection();
        await connection.flush();
        const manager = await jetstreamManager(connection);
        await manager.getAccountInfo();
      },
      close: async () => {
        if (natsConnection !== undefined && !natsConnection.isClosed()) {
          await natsConnection.drain();
        }
      },
    },
  ];
}
