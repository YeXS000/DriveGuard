import type { ExecutionAuthorization, PendingAction } from "@driveguard/action-lifecycle";
import type { ContextSnapshot } from "@driveguard/domain";
import type { ExecutionAttempt, ExecutionRequest, ExecutionResult } from "@driveguard/executor";
import type {
  UrgentEventResultMetadata,
  UrgentEventSeverity,
  UrgentEventStatus,
  UrgentEventType,
} from "@driveguard/urgent-events";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const agentSessions = pgTable(
  "agent_sessions",
  {
    sessionId: text("session_id").primaryKey(),
    userId: text("user_id"),
    vehicleId: text("vehicle_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
    busyOwner: text("busy_owner"),
    busyExpiresAt: timestamp("busy_expires_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [index("agent_sessions_updated_at_idx").on(table.updatedAt)],
);

export const conversationMessages = pgTable(
  "conversation_messages",
  {
    messageId: text("message_id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.sessionId, { onDelete: "cascade" }),
    role: text("role").$type<"user" | "assistant">().notNull(),
    content: text("content").notNull(),
    sequence: integer("sequence").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    uniqueIndex("conversation_messages_session_sequence_uq").on(table.sessionId, table.sequence),
    index("conversation_messages_session_created_idx").on(table.sessionId, table.createdAt),
  ],
);

export const pendingActions = pgTable(
  "pending_actions",
  {
    actionId: text("action_id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.sessionId),
    runId: text("run_id").notNull(),
    traceId: text("trace_id").notNull(),
    toolName: text("tool_name").notNull(),
    state: text("state").notNull(),
    action: jsonb("action").$type<PendingAction>().notNull(),
    originalContext: jsonb("original_context").$type<ContextSnapshot>().notNull(),
    tokenHash: text("token_hash"),
    confirmationId: text("confirmation_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    index("pending_actions_session_state_idx").on(table.sessionId, table.state),
    index("pending_actions_expires_at_idx").on(table.expiresAt),
    index("pending_actions_trace_idx").on(table.traceId),
  ],
);

export const executionAuthorizations = pgTable(
  "execution_authorizations",
  {
    authorizationId: text("authorization_id").primaryKey(),
    actionId: text("action_id")
      .notNull()
      .references(() => pendingActions.actionId),
    authorization: jsonb("authorization").$type<ExecutionAuthorization>().notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true, mode: "date" }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("execution_authorizations_action_uq").on(table.actionId),
    index("execution_authorizations_expires_at_idx").on(table.expiresAt),
  ],
);

export const executionRecords = pgTable(
  "execution_records",
  {
    executionId: text("execution_id").primaryKey(),
    actionId: text("action_id").references(() => pendingActions.actionId),
    runId: text("run_id").notNull(),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.sessionId),
    traceId: text("trace_id").notNull(),
    toolName: text("tool_name").notNull(),
    state: text("state").notNull(),
    request: jsonb("request").$type<ExecutionRequest>().notNull(),
    record: jsonb("record").$type<import("@driveguard/executor").ExecutionRecord>().notNull(),
    result: jsonb("result").$type<ExecutionResult>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    check(
      "execution_records_request_binding_ck",
      sql`${table.request} ->> 'executionId' is not distinct from ${table.executionId}
          and ${table.request} ->> 'sessionId' is not distinct from ${table.sessionId}
          and ${table.request} ->> 'runId' is not distinct from ${table.runId}
          and ${table.request} ->> 'traceId' is not distinct from ${table.traceId}
          and ${table.request} ->> 'toolName' is not distinct from ${table.toolName}
          and ${table.request} ->> 'actionId' is not distinct from ${table.actionId}`,
    ),
    index("execution_records_session_created_idx").on(table.sessionId, table.createdAt),
    index("execution_records_action_idx").on(table.actionId),
    index("execution_records_trace_idx").on(table.traceId),
    index("execution_records_state_idx").on(table.state),
  ],
);

export const executionAttempts = pgTable(
  "execution_attempts",
  {
    executionId: text("execution_id")
      .notNull()
      .references(() => executionRecords.executionId, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    attemptRecord: jsonb("attempt_record").$type<ExecutionAttempt>().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("execution_attempts_execution_attempt_uq").on(table.executionId, table.attempt),
    index("execution_attempts_completed_idx").on(table.completedAt),
  ],
);

export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    idempotencyKey: text("idempotency_key").primaryKey(),
    fingerprint: text("fingerprint").notNull(),
    requestBinding: text("request_binding").notNull(),
    executionId: text("execution_id")
      .notNull()
      .references(() => executionRecords.executionId),
    status: text("status").$type<"IN_PROGRESS" | "COMPLETED" | "OUTCOME_UNKNOWN">().notNull(),
    result: jsonb("result").$type<ExecutionResult>(),
    ownerExpiresAt: timestamp("owner_expires_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    uniqueIndex("idempotency_records_execution_uq").on(table.executionId),
    index("idempotency_records_status_expiry_idx").on(table.status, table.ownerExpiresAt),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    auditId: text("audit_id").primaryKey(),
    eventType: text("event_type").notNull(),
    timestamp: timestamp("timestamp", { withTimezone: true, mode: "date" }).notNull(),
    runId: text("run_id").notNull(),
    sessionId: text("session_id").notNull(),
    traceId: text("trace_id").notNull(),
    actionId: text("action_id"),
    executionId: text("execution_id"),
    toolName: text("tool_name"),
    userId: text("user_id").notNull(),
    vehicleId: text("vehicle_id").notNull(),
    safeMetadata: jsonb("safe_metadata").$type<Readonly<Record<string, unknown>>>().notNull(),
  },
  (table) => [
    index("audit_events_action_time_idx").on(table.actionId, table.timestamp),
    index("audit_events_execution_time_idx").on(table.executionId, table.timestamp),
    index("audit_events_session_time_idx").on(table.sessionId, table.timestamp),
    index("audit_events_trace_time_idx").on(table.traceId, table.timestamp),
    index("audit_events_type_time_idx").on(table.eventType, table.timestamp),
  ],
);

export const urgentEvents = pgTable(
  "urgent_events",
  {
    eventId: text("event_id").primaryKey(),
    eventFingerprint: text("event_fingerprint").notNull(),
    eventType: text("event_type").$type<UrgentEventType | "UNKNOWN">().notNull(),
    vehicleId: text("vehicle_id").notNull(),
    severity: text("severity").$type<UrgentEventSeverity>().notNull(),
    status: text("status").$type<UrgentEventStatus>().notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }).notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
    correlationId: text("correlation_id").notNull(),
    processingOwner: text("processing_owner"),
    processingExpiresAt: timestamp("processing_expires_at", { withTimezone: true, mode: "date" }),
    attemptCount: integer("attempt_count").notNull(),
    result: jsonb("result").$type<UrgentEventResultMetadata>().notNull(),
  },
  (table) => [
    index("urgent_events_vehicle_received_idx").on(table.vehicleId, table.receivedAt),
    index("urgent_events_status_expiry_idx").on(table.status, table.processingExpiresAt),
    index("urgent_events_type_received_idx").on(table.eventType, table.receivedAt),
  ],
);

export const persistenceSchema = {
  agentSessions,
  conversationMessages,
  pendingActions,
  executionAuthorizations,
  executionRecords,
  executionAttempts,
  idempotencyRecords,
  auditEvents,
  urgentEvents,
};
