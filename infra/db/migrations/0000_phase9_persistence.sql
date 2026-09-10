CREATE TABLE IF NOT EXISTS "agent_sessions" (
  "session_id" text PRIMARY KEY,
  "user_id" text,
  "vehicle_id" text,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  "busy_owner" text,
  "busy_expires_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_sessions_updated_at_idx" ON "agent_sessions" ("updated_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversation_messages" (
  "message_id" text PRIMARY KEY,
  "session_id" text NOT NULL REFERENCES "agent_sessions"("session_id") ON DELETE CASCADE,
  "role" text NOT NULL CHECK ("role" IN ('user', 'assistant')),
  "content" text NOT NULL,
  "sequence" integer NOT NULL CHECK ("sequence" >= 0),
  "created_at" timestamptz NOT NULL,
  CONSTRAINT "conversation_messages_session_sequence_uq" UNIQUE ("session_id", "sequence")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_messages_session_created_idx" ON "conversation_messages" ("session_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pending_actions" (
  "action_id" text PRIMARY KEY,
  "session_id" text NOT NULL REFERENCES "agent_sessions"("session_id"),
  "run_id" text NOT NULL,
  "trace_id" text NOT NULL,
  "tool_name" text NOT NULL,
  "state" text NOT NULL CHECK ("state" IN ('AWAITING_CONFIRMATION','CONFIRMED','READY_FOR_EXECUTION','CANCELLED','EXPIRED','REPLAN_REQUIRED','REJECTED')),
  "action" jsonb NOT NULL,
  "original_context" jsonb NOT NULL,
  "token_hash" text,
  "confirmation_id" text,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_actions_session_state_idx" ON "pending_actions" ("session_id", "state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_actions_expires_at_idx" ON "pending_actions" ("expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_actions_trace_idx" ON "pending_actions" ("trace_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "execution_authorizations" (
  "authorization_id" text PRIMARY KEY,
  "action_id" text NOT NULL UNIQUE REFERENCES "pending_actions"("action_id"),
  "authorization" jsonb NOT NULL,
  "issued_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_authorizations_expires_at_idx" ON "execution_authorizations" ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "execution_records" (
  "execution_id" text PRIMARY KEY,
  "action_id" text REFERENCES "pending_actions"("action_id"),
  "run_id" text NOT NULL,
  "session_id" text NOT NULL REFERENCES "agent_sessions"("session_id"),
  "trace_id" text NOT NULL,
  "tool_name" text NOT NULL,
  "state" text NOT NULL CHECK ("state" IN ('CREATED','RUNNING','SUCCEEDED','FAILED','RETRY_EXHAUSTED','OUTCOME_UNKNOWN','REJECTED')),
  "request" jsonb NOT NULL,
  "record" jsonb NOT NULL,
  "result" jsonb,
  "created_at" timestamptz NOT NULL,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "execution_records_request_binding_ck" CHECK (
    "request"->>'executionId' IS NOT DISTINCT FROM "execution_id"
    AND "request"->>'sessionId' IS NOT DISTINCT FROM "session_id"
    AND "request"->>'runId' IS NOT DISTINCT FROM "run_id"
    AND "request"->>'traceId' IS NOT DISTINCT FROM "trace_id"
    AND "request"->>'toolName' IS NOT DISTINCT FROM "tool_name"
    AND "request"->>'actionId' IS NOT DISTINCT FROM "action_id"
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_records_session_created_idx" ON "execution_records" ("session_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_records_action_idx" ON "execution_records" ("action_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_records_trace_idx" ON "execution_records" ("trace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_records_state_idx" ON "execution_records" ("state");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "execution_attempts" (
  "execution_id" text NOT NULL REFERENCES "execution_records"("execution_id") ON DELETE CASCADE,
  "attempt" integer NOT NULL CHECK ("attempt" > 0),
  "attempt_record" jsonb NOT NULL,
  "started_at" timestamptz NOT NULL,
  "completed_at" timestamptz,
  CONSTRAINT "execution_attempts_execution_attempt_uq" UNIQUE ("execution_id", "attempt")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_attempts_completed_idx" ON "execution_attempts" ("completed_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "idempotency_records" (
  "idempotency_key" text PRIMARY KEY,
  "fingerprint" text NOT NULL,
  "request_binding" text NOT NULL,
  "execution_id" text NOT NULL UNIQUE REFERENCES "execution_records"("execution_id"),
  "status" text NOT NULL CHECK ("status" IN ('IN_PROGRESS','COMPLETED','OUTCOME_UNKNOWN')),
  "result" jsonb,
  "owner_expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idempotency_records_status_expiry_idx" ON "idempotency_records" ("status", "owner_expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_events" (
  "audit_id" text PRIMARY KEY,
  "event_type" text NOT NULL,
  "timestamp" timestamptz NOT NULL,
  "run_id" text NOT NULL,
  "session_id" text NOT NULL,
  "trace_id" text NOT NULL,
  "action_id" text,
  "execution_id" text,
  "tool_name" text,
  "user_id" text NOT NULL,
  "vehicle_id" text NOT NULL,
  "safe_metadata" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_events" ALTER COLUMN "vehicle_id" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_action_time_idx" ON "audit_events" ("action_id", "timestamp");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_execution_time_idx" ON "audit_events" ("execution_id", "timestamp");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_session_time_idx" ON "audit_events" ("session_id", "timestamp");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_trace_time_idx" ON "audit_events" ("trace_id", "timestamp");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_type_time_idx" ON "audit_events" ("event_type", "timestamp");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION driveguard_reject_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION driveguard_reject_audit_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_events_no_truncate ON audit_events;
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate
BEFORE TRUNCATE ON audit_events
FOR EACH STATEMENT EXECUTE FUNCTION driveguard_reject_audit_mutation();
