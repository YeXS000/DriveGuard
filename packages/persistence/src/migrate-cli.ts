import { createPostgresDatabase } from "./database.js";
import { configureRuntimeDatabaseRole, migratePersistence } from "./migrations.js";

const database = createPostgresDatabase();
try {
  await migratePersistence(database.db);
  const runtimeUser = process.env.POSTGRES_APP_USER;
  const runtimePassword = process.env.POSTGRES_APP_PASSWORD;
  if (runtimeUser === undefined || runtimePassword === undefined) {
    throw new Error("POSTGRES_APP_USER and POSTGRES_APP_PASSWORD are required for migrations");
  }
  await configureRuntimeDatabaseRole(database.pool, runtimeUser, runtimePassword);
  process.stdout.write("DriveGuard persistence migration complete\n");
} finally {
  await database.close();
}
