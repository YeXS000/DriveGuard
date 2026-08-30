import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import type { Pool } from "pg";

import type { DriveGuardDatabase } from "./database.js";

export async function migratePersistence(
  db: DriveGuardDatabase,
  migrationsFolder = "infra/db/migrations",
): Promise<void> {
  await migrate(db, { migrationsFolder });
  // Keep canonical request identity bound to its relational execution row, including null action IDs.
  await db.execute(
    sql.raw(
      `ALTER TABLE execution_records DROP CONSTRAINT IF EXISTS execution_records_request_binding_ck`,
    ),
  );
  await db.execute(
    sql.raw(`ALTER TABLE execution_records ADD CONSTRAINT execution_records_request_binding_ck CHECK (
      request->>'executionId' IS NOT DISTINCT FROM execution_id
      AND request->>'sessionId' IS NOT DISTINCT FROM session_id
      AND request->>'runId' IS NOT DISTINCT FROM run_id
      AND request->>'traceId' IS NOT DISTINCT FROM trace_id
      AND request->>'toolName' IS NOT DISTINCT FROM tool_name
      AND request->>'actionId' IS NOT DISTINCT FROM action_id
    )`),
  );
  // Reassert the append-only boundary if an operator reruns migrations after schema drift.
  await db.execute(
    sql.raw(`CREATE OR REPLACE FUNCTION driveguard_reject_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$ LANGUAGE plpgsql`),
  );
  await db.execute(sql.raw("DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events"));
  await db.execute(
    sql.raw(`CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION driveguard_reject_audit_mutation()`),
  );
  await db.execute(sql.raw("DROP TRIGGER IF EXISTS audit_events_no_truncate ON audit_events"));
  await db.execute(
    sql.raw(`CREATE TRIGGER audit_events_no_truncate
BEFORE TRUNCATE ON audit_events
FOR EACH STATEMENT EXECUTE FUNCTION driveguard_reject_audit_mutation()`),
  );
}

export async function configureRuntimeDatabaseRole(
  pool: Pool,
  roleName: string,
  password: string,
): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(roleName)) {
    throw new Error("POSTGRES_APP_USER is invalid");
  }
  if (password.length < 12) throw new Error("POSTGRES_APP_PASSWORD is too short");
  const identifier = `"${roleName}"`;
  const existing = await pool.query<{
    readonly hasRoleMembership: boolean;
    readonly isCurrentUser: boolean;
    readonly ownsPhase9Relation: boolean;
    readonly ownsSecurityBoundary: boolean;
    readonly rolbypassrls: boolean;
    readonly rolcreatedb: boolean;
    readonly rolcreaterole: boolean;
    readonly rolreplication: boolean;
    readonly rolsuper: boolean;
  }>(
    `select r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
            r.rolname=current_user as "isCurrentUser",
            exists (select 1 from pg_auth_members m where m.member=r.oid)
              as "hasRoleMembership",
            exists (
              select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
              where c.relowner=r.oid and n.nspname='public'
                and c.relname in (
                  'agent_sessions','conversation_messages','pending_actions',
                  'execution_authorizations','execution_records','execution_attempts',
                  'idempotency_records','audit_events'
                )
            ) as "ownsPhase9Relation",
            exists (
              select 1 from pg_namespace n
              where n.nspname='public' and n.nspowner=r.oid
            ) or exists (
              select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='driveguard_reject_audit_mutation'
                and p.proowner=r.oid
            ) as "ownsSecurityBoundary"
       from pg_roles r where r.rolname=$1`,
    [roleName],
  );
  const role = existing.rows[0];
  if (
    role?.isCurrentUser === true ||
    role?.hasRoleMembership === true ||
    role?.ownsPhase9Relation === true ||
    role?.ownsSecurityBoundary === true ||
    role?.rolsuper === true ||
    role?.rolcreatedb === true ||
    role?.rolcreaterole === true ||
    role?.rolreplication === true ||
    role?.rolbypassrls === true
  ) {
    throw new Error("POSTGRES_APP_USER must be a separate unprivileged non-owner role");
  }
  if (existing.rowCount === 0) {
    await pool.query(
      `create role ${identifier} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls`,
    );
  }
  const passwordStatement = await pool.query<{ readonly statement: string }>(
    `select format(
       'alter role %I with login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password %L',
       $1::text,$2::text
     ) as statement`,
    [roleName, password],
  );
  const statement = passwordStatement.rows[0]?.statement;
  if (statement === undefined) throw new Error("Runtime database role password could not be set");
  await pool.query(statement);
  await pool.query(`grant usage on schema public to ${identifier}`);
  await pool.query(
    `revoke all privileges on
       agent_sessions,conversation_messages,pending_actions,execution_authorizations,
       execution_records,execution_attempts,idempotency_records
     from ${identifier}`,
  );
  await pool.query(
    `grant select,insert,update on
       agent_sessions,conversation_messages,pending_actions,execution_authorizations,
       execution_records,execution_attempts,idempotency_records
     to ${identifier}`,
  );
  await pool.query(`grant delete on execution_records to ${identifier}`);
  await pool.query(`revoke all privileges on audit_events from ${identifier}`);
  await pool.query(`grant select,insert on audit_events to ${identifier}`);
}
