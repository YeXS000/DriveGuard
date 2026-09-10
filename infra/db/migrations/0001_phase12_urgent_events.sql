CREATE TABLE IF NOT EXISTS "urgent_events" (
  "event_id" text PRIMARY KEY,
  "event_fingerprint" text NOT NULL CHECK (length("event_fingerprint") = 64),
  "event_type" text NOT NULL,
  "vehicle_id" text NOT NULL,
  "severity" text NOT NULL CHECK ("severity" IN ('INFO','WARNING','HIGH','CRITICAL')),
  "status" text NOT NULL CHECK ("status" IN ('RECEIVED','PROCESSING','HANDLED','REJECTED','REPLAN_REQUIRED','FAILED')),
  "received_at" timestamptz NOT NULL,
  "processed_at" timestamptz,
  "correlation_id" text NOT NULL,
  "processing_owner" text,
  "processing_expires_at" timestamptz,
  "attempt_count" integer NOT NULL CHECK ("attempt_count" >= 0),
  "result" jsonb NOT NULL,
  CONSTRAINT "urgent_events_processing_ownership_ck" CHECK (
    ("status" = 'PROCESSING' AND "processing_owner" IS NOT NULL AND "processing_expires_at" IS NOT NULL)
    OR
    ("status" <> 'PROCESSING' AND "processing_owner" IS NULL AND "processing_expires_at" IS NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "urgent_events_vehicle_received_idx" ON "urgent_events" ("vehicle_id", "received_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "urgent_events_status_expiry_idx" ON "urgent_events" ("status", "processing_expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "urgent_events_type_received_idx" ON "urgent_events" ("event_type", "received_at");
