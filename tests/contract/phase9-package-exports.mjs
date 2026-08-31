import * as memory from "../../dist/packages/memory/src/index.js";
import * as persistence from "../../dist/packages/persistence/src/index.js";

for (const name of [
  "RepositoryConversationMemory",
  "RedisConversationCache",
  "RedisSessionCoordinator",
  "RedisIdempotencyCoordinator",
  "FallbackSessionCoordinator",
]) {
  if (!(name in memory)) throw new Error(`Missing @driveguard/memory export: ${name}`);
}

for (const name of [
  "createPostgresDatabase",
  "migratePersistence",
  "PostgresSessionRepository",
  "PostgresConversationRepository",
  "PostgresPendingActionRepository",
  "PostgresAuthorizationRepository",
  "PostgresExecutionRepository",
  "PostgresIdempotencyRepository",
  "PostgresAuditRepository",
  "PostgresDurableExecutionCoordinator",
  "PostgresExecutionAttemptEventSink",
  "createPhase9RuntimeBindings",
]) {
  if (!(name in persistence)) throw new Error(`Missing @driveguard/persistence export: ${name}`);
}
