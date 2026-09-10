import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import * as schema from "./schema.js";

export type DriveGuardDatabase = NodePgDatabase<typeof schema>;

export interface PostgresDatabaseHandle {
  readonly pool: Pool;
  readonly db: DriveGuardDatabase;
  close(): Promise<void>;
}

export function guardPostgresPoolErrors(pool: Pool): void {
  // pg emits idle-client failures on the Pool and checked-out failures on the
  // Client. Both listeners are mandatory so a dependency disconnect is
  // handled by request/readiness failure paths instead of terminating Node.js.
  pool.on("error", () => undefined);
  pool.on("connect", (client) => client.on("error", () => undefined));
}

export function createPostgresDatabase(config?: PoolConfig): PostgresDatabaseHandle {
  const pool = new Pool(config);
  guardPostgresPoolErrors(pool);
  const db = drizzle({ client: pool, schema });
  return Object.freeze({
    pool,
    db,
    close: async () => pool.end(),
  });
}
