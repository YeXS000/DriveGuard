import { randomUUID } from "node:crypto";

import type { UtcTimestamp } from "@driveguard/domain";
import { and, asc, eq } from "drizzle-orm";

import type { DriveGuardDatabase } from "./database.js";
import { auditEvents } from "./schema.js";

export const AUDIT_EVENT_TYPES = [
  "policy.decision",
  "pending_action.created",
  "confirmation.accepted",
  "confirmation.rejected",
  "context.revalidated",
  "authorization.issued",
  "authorization.consumed",
  "execution.started",
  "execution.retry",
  "execution.succeeded",
  "execution.failed",
  "execution.outcome_unknown",
  "idempotency.deduplicated",
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number] | (string & {});

export interface AuditEvent {
  readonly auditId: string;
  readonly eventType: AuditEventType;
  readonly timestamp: UtcTimestamp;
  readonly runId: string;
  readonly sessionId: string;
  readonly traceId: string;
  readonly actionId?: string;
  readonly executionId?: string;
  readonly toolName?: string;
  readonly userId: string;
  readonly vehicleId: string;
  readonly safeMetadata: Readonly<Record<string, unknown>>;
}

export interface AuditRepository {
  append(event: AuditEvent): Promise<void>;
  list(input: {
    readonly actionId?: string;
    readonly executionId?: string;
  }): Promise<readonly AuditEvent[]>;
}

const forbiddenMetadataKey =
  /(?:authorization|confirmation.?token|api.?key|access.?token|refresh.?token|credential|cookie|secret|password|chain.?of.?thought|reasoning|header)/iu;
const auditSubjectPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function assertSafeAuditMetadata(value: unknown, path = "safeMetadata"): void {
  if (typeof value === "string") {
    if (
      /(?:authorization\s*:\s*bearer|api[_-]?key\s*[=:]|confirmation.?token\s*[=:]|(?:access.?token|refresh.?token|credential|cookie|token|secret|password)\s*[=:]|chain.?of.?thought|internal.?reasoning)/iu.test(
        value,
      )
    ) {
      throw new Error(`${path} contains sensitive content`);
    }
    return;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeAuditMetadata(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object") throw new Error(`${path} is not JSON-safe`);
  for (const [key, item] of Object.entries(value)) {
    if (forbiddenMetadataKey.test(key)) throw new Error(`${path}.${key} is sensitive`);
    assertSafeAuditMetadata(item, `${path}.${key}`);
  }
}

function cloneAudit(event: AuditEvent): AuditEvent {
  if (!auditSubjectPattern.test(event.userId) || !auditSubjectPattern.test(event.vehicleId)) {
    throw new Error("Audit userId and vehicleId must be safe stable identifiers");
  }
  assertSafeAuditMetadata(event.safeMetadata);
  return Object.freeze({
    ...event,
    safeMetadata: Object.freeze(structuredClone(event.safeMetadata)),
  });
}

export function createAuditEvent(
  input: Omit<AuditEvent, "auditId"> & { readonly auditId?: string },
): AuditEvent {
  return cloneAudit({ ...input, auditId: input.auditId ?? `audit:${randomUUID()}` });
}

export class InMemoryAuditRepository implements AuditRepository {
  readonly #events: AuditEvent[] = [];
  readonly #ids = new Set<string>();

  async append(event: AuditEvent): Promise<void> {
    await Promise.resolve();
    if (this.#ids.has(event.auditId)) throw new Error("Duplicate auditId");
    const stored = cloneAudit(event);
    this.#ids.add(stored.auditId);
    this.#events.push(stored);
  }

  async list(input: {
    readonly actionId?: string;
    readonly executionId?: string;
  }): Promise<readonly AuditEvent[]> {
    await Promise.resolve();
    return Object.freeze(
      this.#events
        .filter(
          (event) =>
            (input.actionId === undefined || event.actionId === input.actionId) &&
            (input.executionId === undefined || event.executionId === input.executionId),
        )
        .map(cloneAudit),
    );
  }
}

export class PostgresAuditRepository implements AuditRepository {
  readonly #db: DriveGuardDatabase;

  constructor(db: DriveGuardDatabase) {
    this.#db = db;
  }

  async append(event: AuditEvent): Promise<void> {
    const safe = cloneAudit(event);
    await this.#db.insert(auditEvents).values({
      auditId: safe.auditId,
      eventType: safe.eventType,
      timestamp: new Date(safe.timestamp),
      runId: safe.runId,
      sessionId: safe.sessionId,
      traceId: safe.traceId,
      actionId: safe.actionId ?? null,
      executionId: safe.executionId ?? null,
      toolName: safe.toolName ?? null,
      userId: safe.userId,
      vehicleId: safe.vehicleId,
      safeMetadata: safe.safeMetadata,
    });
  }

  async list(input: {
    readonly actionId?: string;
    readonly executionId?: string;
  }): Promise<readonly AuditEvent[]> {
    const predicates = [
      ...(input.actionId === undefined ? [] : [eq(auditEvents.actionId, input.actionId)]),
      ...(input.executionId === undefined ? [] : [eq(auditEvents.executionId, input.executionId)]),
    ];
    const rows = await this.#db
      .select()
      .from(auditEvents)
      .where(predicates.length === 0 ? undefined : and(...predicates))
      .orderBy(asc(auditEvents.timestamp), asc(auditEvents.auditId));
    return Object.freeze(
      rows.map((row) =>
        cloneAudit({
          auditId: row.auditId,
          eventType: row.eventType,
          timestamp: row.timestamp.toISOString() as UtcTimestamp,
          runId: row.runId,
          sessionId: row.sessionId,
          traceId: row.traceId,
          ...(row.actionId === null ? {} : { actionId: row.actionId }),
          ...(row.executionId === null ? {} : { executionId: row.executionId }),
          ...(row.toolName === null ? {} : { toolName: row.toolName }),
          userId: row.userId,
          vehicleId: row.vehicleId,
          safeMetadata: row.safeMetadata,
        }),
      ),
    );
  }
}
