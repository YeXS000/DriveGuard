DO $$
BEGIN
  IF to_regclass('public.audit_events') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS audit_events_no_truncate ON audit_events;
    DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;
  END IF;
END
$$;
DROP FUNCTION IF EXISTS driveguard_reject_audit_mutation();
DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS idempotency_records;
DROP TABLE IF EXISTS execution_attempts;
DROP TABLE IF EXISTS execution_records;
DROP TABLE IF EXISTS execution_authorizations;
DROP TABLE IF EXISTS pending_actions;
DROP TABLE IF EXISTS conversation_messages;
DROP TABLE IF EXISTS agent_sessions;
DO $$
BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
    DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1788001200000;
  END IF;
END
$$;
