import { and, asc, eq, gt, isNull, lt, max, or, sql } from "drizzle-orm";
import type {
  AgentSessionRecord,
  ConversationMessage,
  ConversationRepository,
  SessionCoordinator,
  SessionRepository,
} from "@driveguard/memory";
import type { UtcTimestamp } from "@driveguard/domain";

import type { DriveGuardDatabase } from "./database.js";
import { agentSessions, conversationMessages } from "./schema.js";

function utc(date: Date): UtcTimestamp {
  return date.toISOString() as UtcTimestamp;
}

function sessionRecord(row: typeof agentSessions.$inferSelect): AgentSessionRecord {
  return Object.freeze({
    sessionId: row.sessionId,
    ...(row.userId === null ? {} : { userId: row.userId }),
    ...(row.vehicleId === null ? {} : { vehicleId: row.vehicleId }),
    createdAt: utc(row.createdAt),
    updatedAt: utc(row.updatedAt),
  });
}

function messageRecord(row: typeof conversationMessages.$inferSelect): ConversationMessage {
  return Object.freeze({
    messageId: row.messageId,
    sessionId: row.sessionId,
    role: row.role,
    content: row.content,
    createdAt: utc(row.createdAt),
    sequence: row.sequence,
  });
}

export class PostgresSessionRepository implements SessionRepository {
  readonly #db: DriveGuardDatabase;

  constructor(db: DriveGuardDatabase) {
    this.#db = db;
  }

  async get(sessionId: string): Promise<AgentSessionRecord | undefined> {
    const [row] = await this.#db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.sessionId, sessionId))
      .limit(1);
    return row === undefined ? undefined : sessionRecord(row);
  }

  async upsert(record: AgentSessionRecord): Promise<AgentSessionRecord> {
    const [row] = await this.#db
      .insert(agentSessions)
      .values({
        sessionId: record.sessionId,
        userId: record.userId,
        vehicleId: record.vehicleId,
        createdAt: new Date(record.createdAt),
        updatedAt: new Date(record.updatedAt),
      })
      .onConflictDoUpdate({
        target: agentSessions.sessionId,
        set: { updatedAt: new Date(record.updatedAt) },
      })
      .returning();
    if (row === undefined) throw new Error("Session upsert failed");
    return sessionRecord(row);
  }

  async bindIdentity(input: {
    readonly sessionId: string;
    readonly userId: string;
    readonly vehicleId: string;
    readonly updatedAt: UtcTimestamp;
  }): Promise<AgentSessionRecord> {
    await this.#db
      .insert(agentSessions)
      .values({
        sessionId: input.sessionId,
        userId: input.userId,
        vehicleId: input.vehicleId,
        createdAt: new Date(input.updatedAt),
        updatedAt: new Date(input.updatedAt),
      })
      .onConflictDoNothing();
    const [row] = await this.#db
      .update(agentSessions)
      .set({
        userId: input.userId,
        vehicleId: input.vehicleId,
        updatedAt: new Date(input.updatedAt),
      })
      .where(
        and(
          eq(agentSessions.sessionId, input.sessionId),
          or(isNull(agentSessions.userId), eq(agentSessions.userId, input.userId)),
          or(isNull(agentSessions.vehicleId), eq(agentSessions.vehicleId, input.vehicleId)),
        ),
      )
      .returning();
    if (row === undefined) throw new Error("Session identity mismatch");
    return sessionRecord(row);
  }
}

export class PostgresConversationRepository implements ConversationRepository {
  readonly #db: DriveGuardDatabase;

  constructor(db: DriveGuardDatabase) {
    this.#db = db;
  }

  async list(sessionId: string): Promise<readonly ConversationMessage[]> {
    const rows = await this.#db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.sessionId, sessionId))
      .orderBy(asc(conversationMessages.sequence));
    return Object.freeze(rows.map(messageRecord));
  }

  async appendTurn(input: {
    readonly session: AgentSessionRecord;
    readonly ownerId?: string;
    readonly user: Omit<ConversationMessage, "sequence">;
    readonly assistant: Omit<ConversationMessage, "sequence">;
  }): Promise<readonly [ConversationMessage, ConversationMessage]> {
    return this.#db.transaction(async (tx) => {
      await tx
        .insert(agentSessions)
        .values({
          sessionId: input.session.sessionId,
          userId: input.session.userId,
          vehicleId: input.session.vehicleId,
          createdAt: new Date(input.session.createdAt),
          updatedAt: new Date(input.session.updatedAt),
        })
        .onConflictDoUpdate({
          target: agentSessions.sessionId,
          set: { updatedAt: new Date(input.session.updatedAt) },
        });
      if (input.ownerId === undefined) {
        await tx.execute(
          sql`select session_id from agent_sessions where session_id = ${input.session.sessionId} for update`,
        );
      } else {
        const lease = await tx
          .select({ sessionId: agentSessions.sessionId })
          .from(agentSessions)
          .where(
            and(
              eq(agentSessions.sessionId, input.session.sessionId),
              eq(agentSessions.busyOwner, input.ownerId),
              gt(agentSessions.busyExpiresAt, sql`clock_timestamp()`),
            ),
          )
          .for("update")
          .limit(1);
        if (lease.length !== 1) throw new Error("Durable session lease was lost before append");
      }
      const [last] = await tx
        .select({ sequence: max(conversationMessages.sequence) })
        .from(conversationMessages)
        .where(eq(conversationMessages.sessionId, input.session.sessionId));
      const next = (last?.sequence ?? -1) + 1;
      const rows = await tx
        .insert(conversationMessages)
        .values([
          { ...input.user, sequence: next, createdAt: new Date(input.user.createdAt) },
          {
            ...input.assistant,
            sequence: next + 1,
            createdAt: new Date(input.assistant.createdAt),
          },
        ])
        .returning();
      const ordered = rows.map(messageRecord).sort((left, right) => left.sequence - right.sequence);
      if (ordered.length !== 2 || ordered[0] === undefined || ordered[1] === undefined) {
        throw new Error("Conversation turn insert failed");
      }
      return Object.freeze([ordered[0], ordered[1]]);
    });
  }
}

export class PostgresSessionCoordinator implements SessionCoordinator {
  readonly #db: DriveGuardDatabase;
  readonly #ttlMs: number;

  constructor(db: DriveGuardDatabase, ttlMs = 120_000) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error("Session lease TTL is invalid");
    this.#db = db;
    this.#ttlMs = ttlMs;
  }

  get leaseDurationMs(): number {
    return this.#ttlMs;
  }

  async acquire(sessionId: string, ownerId: string): Promise<boolean> {
    const now = new Date();
    await this.#db
      .insert(agentSessions)
      .values({ sessionId, createdAt: now, updatedAt: now })
      .onConflictDoNothing();
    const rows = await this.#db
      .update(agentSessions)
      .set({
        busyOwner: ownerId,
        busyExpiresAt: sql`clock_timestamp() + (${this.#ttlMs} * interval '1 millisecond')`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(agentSessions.sessionId, sessionId),
          or(
            isNull(agentSessions.busyOwner),
            isNull(agentSessions.busyExpiresAt),
            lt(agentSessions.busyExpiresAt, sql`clock_timestamp()`),
          ),
        ),
      )
      .returning({ sessionId: agentSessions.sessionId });
    return rows.length === 1;
  }

  async release(sessionId: string, ownerId: string): Promise<void> {
    await this.#db
      .update(agentSessions)
      .set({ busyOwner: null, busyExpiresAt: null, updatedAt: new Date() })
      .where(and(eq(agentSessions.sessionId, sessionId), eq(agentSessions.busyOwner, ownerId)));
  }

  async renew(sessionId: string, ownerId: string): Promise<boolean> {
    const rows = await this.#db
      .update(agentSessions)
      .set({
        busyExpiresAt: sql`clock_timestamp() + (${this.#ttlMs} * interval '1 millisecond')`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(agentSessions.sessionId, sessionId),
          eq(agentSessions.busyOwner, ownerId),
          gt(agentSessions.busyExpiresAt, sql`clock_timestamp()`),
        ),
      )
      .returning({ sessionId: agentSessions.sessionId });
    return rows.length === 1;
  }
}
