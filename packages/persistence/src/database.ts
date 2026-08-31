import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import * as schema from "./schema.js";

export type DriveGuardDatabase = NodePgDatabase<typeof schema>;

export interface PostgresDatabaseHandle {
  readonly pool: Pool;
  readonly db: DriveGuardDatabase;
  close(): Promise<void>;
}

export function createPostgresDatabase(config?: PoolConfig): PostgresDatabaseHandle {
  const pool = new Pool(config);
  const db = drizzle({ client: pool, schema });
  return Object.freeze({
    pool,
    db,
    close: async () => pool.end(),
  });
}
