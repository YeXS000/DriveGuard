import {
  FallbackSessionCoordinator,
  RedisConversationCache,
  RedisIdempotencyCoordinator,
  RedisSessionCoordinator,
  RepositoryConversationMemory,
  type RedisCommands,
} from "@driveguard/memory";
import type { PoolConfig } from "pg";

import { PostgresAuditRepository } from "./audit.js";
import { PostgresAuthorizationRepository } from "./authorization.js";
import { createPostgresDatabase, type PostgresDatabaseHandle } from "./database.js";
import { PostgresExecutionAttemptEventSink } from "./execution-events.js";
import {
  PostgresDurableExecutionCoordinator,
  PostgresExecutionRepository,
  PostgresIdempotencyRepository,
} from "./execution.js";
import { PostgresPendingActionRepository } from "./pending-action.js";
import {
  PostgresConversationRepository,
  PostgresSessionCoordinator,
  PostgresSessionRepository,
} from "./session.js";

export interface Phase9RuntimeBindings {
  readonly database: PostgresDatabaseHandle;
  readonly pendingActionRepository: PostgresPendingActionRepository;
  readonly authorizationRepository: PostgresAuthorizationRepository;
  readonly executionRepository: PostgresExecutionRepository;
  readonly idempotencyRepository: PostgresIdempotencyRepository;
  readonly auditRepository: PostgresAuditRepository;
  readonly durableExecutionCoordinator: PostgresDurableExecutionCoordinator;
  readonly executionEventSink: PostgresExecutionAttemptEventSink;
  readonly conversationMemory: RepositoryConversationMemory;
  readonly sessionCoordinator: FallbackSessionCoordinator;
  close(): Promise<void>;
}

/**
 * Phase 9 production composition root. The returned four Runtime dependencies
 * are passed directly to createProductionDriveGuardRuntime; PostgreSQL remains
 * authoritative and Redis is only a TTL-bound cache/coordination hint.
 */
export function createPhase9RuntimeBindings(options: {
  readonly postgres: PoolConfig;
  readonly redis: RedisCommands;
  readonly sessionLeaseMs?: number;
  readonly conversationCacheTtlMs?: number;
  readonly executionLeaseMs?: number;
}): Phase9RuntimeBindings {
  const database = createPostgresDatabase(options.postgres);
  const sessionLeaseMs = options.sessionLeaseMs ?? 120_000;
  const conversationCacheTtlMs = options.conversationCacheTtlMs ?? 30 * 60 * 1_000;
  const executionLeaseMs = options.executionLeaseMs ?? 30_000;
  const durableSession = new PostgresSessionCoordinator(database.db, sessionLeaseMs);
  const redisSession = new RedisSessionCoordinator(options.redis, sessionLeaseMs);
  const redisIdempotency = new RedisIdempotencyCoordinator(options.redis, executionLeaseMs);
  const bindings: Phase9RuntimeBindings = {
    database,
    pendingActionRepository: new PostgresPendingActionRepository(database.pool),
    authorizationRepository: new PostgresAuthorizationRepository(database.pool),
    executionRepository: new PostgresExecutionRepository(database.pool),
    idempotencyRepository: new PostgresIdempotencyRepository(database.pool),
    auditRepository: new PostgresAuditRepository(database.db),
    durableExecutionCoordinator: new PostgresDurableExecutionCoordinator(
      database.pool,
      executionLeaseMs,
      redisIdempotency,
      {
        coordinationTimeoutMs: Math.max(1, Math.min(1_000, Math.floor(executionLeaseMs / 4))),
        requireSessionLease: true,
      },
    ),
    executionEventSink: new PostgresExecutionAttemptEventSink(database.pool),
    conversationMemory: new RepositoryConversationMemory({
      sessions: new PostgresSessionRepository(database.db),
      conversation: new PostgresConversationRepository(database.db),
      cache: new RedisConversationCache(options.redis, conversationCacheTtlMs),
      cacheOperationTimeoutMs: Math.max(1, Math.min(1_000, Math.floor(conversationCacheTtlMs / 4))),
    }),
    sessionCoordinator: new FallbackSessionCoordinator(redisSession, durableSession),
    close: () => database.close(),
  };
  return Object.freeze(bindings);
}
