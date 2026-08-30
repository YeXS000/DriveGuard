import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import {
  ActionLifecycleError,
  assertPendingActionRecordIntegrity,
  transitionPendingAction,
  type ActionState,
  type ExecutionAuthorization,
  type PendingActionRecord,
  type PendingActionRepository,
} from "@driveguard/action-lifecycle";
import type { ContextSnapshot, UtcTimestamp } from "@driveguard/domain";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { assertSafeAuditMetadata } from "./audit.js";

interface PendingRow extends QueryResultRow {
  action: unknown;
  original_context: unknown;
  token_hash: string | null;
  confirmation_id: string | null;
  authorization: unknown;
  consumed_at: Date | null;
}

function cloneRecord(record: PendingActionRecord): PendingActionRecord {
  assertPendingActionRecordIntegrity(record);
  return Object.freeze({
    ...record,
    action: structuredClone(record.action),
    originalContext: structuredClone(record.originalContext),
    authorization: record.authorization === null ? null : structuredClone(record.authorization),
  });
}

function recordFromRow(row: PendingRow): PendingActionRecord {
  return cloneRecord({
    action: row.action as PendingActionRecord["action"],
    originalContext: row.original_context as ContextSnapshot,
    tokenHash: row.token_hash,
    confirmationId: row.confirmation_id,
    authorization: row.authorization as ExecutionAuthorization | null,
    authorizationConsumedAt:
      row.consumed_at === null ? null : (row.consumed_at.toISOString() as UtcTimestamp),
  });
}

async function appendAudit(
  client: PoolClient,
  record: PendingActionRecord,
  eventType: string,
  timestamp: UtcTimestamp,
  metadata: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  assertSafeAuditMetadata(metadata);
  await client.query(
    `insert into audit_events
      (audit_id,event_type,timestamp,run_id,session_id,trace_id,action_id,tool_name,user_id,vehicle_id,safe_metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
    [
      `audit:${randomUUID()}`,
      eventType,
      timestamp,
      record.action.runId,
      record.action.sessionId,
      record.action.traceId,
      record.action.actionId,
      record.action.toolName,
      record.action.userId,
      record.action.vehicleId,
      JSON.stringify(metadata),
    ],
  );
}

export class PostgresPendingActionRepository implements PendingActionRepository {
  readonly #pool: Pool;
  readonly #transaction = new AsyncLocalStorage<PoolClient>();
  readonly #exclusive = new AsyncLocalStorage<PoolClient>();

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async create(record: PendingActionRecord): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("begin");
      const confirmationTtlMs =
        Date.parse(record.action.expiresAt) - Date.parse(record.action.createdAt);
      if (!Number.isSafeInteger(confirmationTtlMs) || confirmationTtlMs < 1) {
        throw new ActionLifecycleError(
          "INVALID_COMMAND",
          "PendingAction confirmation TTL is invalid",
          record.action.actionId,
        );
      }
      const databaseTime = await client.query<{ readonly now: Date }>(
        "select clock_timestamp() as now",
      );
      const now = databaseTime.rows[0]?.now;
      if (now === undefined) throw new Error("PostgreSQL clock is unavailable");
      const createdAt = now.toISOString() as UtcTimestamp;
      const expiresAt = new Date(now.getTime() + confirmationTtlMs).toISOString() as UtcTimestamp;
      const authoritative = cloneRecord({
        ...record,
        action: {
          ...record.action,
          createdAt,
          updatedAt: createdAt,
          expiresAt,
          stateHistory: Object.freeze([
            Object.freeze({
              from: null,
              to: "AWAITING_CONFIRMATION" as const,
              transitionedAt: createdAt,
            }),
          ]),
        },
      });
      const session = await client.query(
        `insert into agent_sessions (session_id,user_id,vehicle_id,created_at,updated_at)
         values ($1,$2,$3,$4,$5)
         on conflict (session_id) do update
         set user_id=coalesce(agent_sessions.user_id,excluded.user_id),
             vehicle_id=coalesce(agent_sessions.vehicle_id,excluded.vehicle_id),
             updated_at=excluded.updated_at
         where (agent_sessions.user_id is null or agent_sessions.user_id=excluded.user_id)
           and (agent_sessions.vehicle_id is null or agent_sessions.vehicle_id=excluded.vehicle_id)
         returning session_id`,
        [
          authoritative.action.sessionId,
          authoritative.action.userId,
          authoritative.action.vehicleId,
          createdAt,
          createdAt,
        ],
      );
      if (session.rowCount !== 1) {
        throw new ActionLifecycleError(
          "INVALID_COMMAND",
          "PendingAction session identity mismatch",
          authoritative.action.actionId,
        );
      }
      await client.query(
        `insert into pending_actions
          (action_id,session_id,run_id,trace_id,tool_name,state,action,original_context,token_hash,
           confirmation_id,created_at,updated_at,expires_at)
         values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13)`,
        [
          authoritative.action.actionId,
          authoritative.action.sessionId,
          authoritative.action.runId,
          authoritative.action.traceId,
          authoritative.action.toolName,
          authoritative.action.state,
          JSON.stringify(authoritative.action),
          JSON.stringify(authoritative.originalContext),
          authoritative.tokenHash,
          authoritative.confirmationId,
          createdAt,
          createdAt,
          expiresAt,
        ],
      );
      await appendAudit(client, authoritative, "policy.decision", createdAt, {
        decision: authoritative.action.policyDecision.decision,
        ruleId: authoritative.action.policyRuleId,
      });
      await appendAudit(client, authoritative, "pending_action.created", createdAt, {
        state: authoritative.action.state,
        riskLevel: authoritative.action.riskLevel,
      });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "23505") {
        throw new ActionLifecycleError(
          "INVALID_COMMAND",
          "Duplicate actionId",
          record.action.actionId,
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async get(actionId: string): Promise<PendingActionRecord | undefined> {
    const client = this.#transaction.getStore() ?? this.#exclusive.getStore() ?? this.#pool;
    const result = await client.query<PendingRow>(
      `select p.action,p.original_context,p.token_hash,p.confirmation_id,
              a."authorization",a.consumed_at
       from pending_actions p
       left join execution_authorizations a on a.action_id = p.action_id
       where p.action_id = $1`,
      [actionId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : recordFromRow(row);
  }

  async runExclusive<T>(actionId: string, operation: () => Promise<T>): Promise<T> {
    if (this.#exclusive.getStore() !== undefined) return operation();
    const client = await this.#pool.connect();
    let locked = false;
    try {
      await client.query("select pg_advisory_lock(hashtext($1))", [actionId]);
      locked = true;
      return await this.#exclusive.run(client, operation);
    } finally {
      if (locked) await client.query("select pg_advisory_unlock(hashtext($1))", [actionId]);
      client.release();
    }
  }

  async transition(
    actionId: string,
    nextState: ActionState,
    transitionedAt: UtcTimestamp,
  ): Promise<PendingActionRecord> {
    return this.#atomic(actionId, async (client) => {
      const current = await this.#require(actionId);
      const action = transitionPendingAction(current.action, nextState, transitionedAt);
      const result = await client.query(
        `update pending_actions
         set state=$1, action=$2::jsonb, updated_at=$3
         where action_id=$4 and state=$5
         returning action_id`,
        [nextState, JSON.stringify(action), transitionedAt, actionId, current.action.state],
      );
      if (result.rowCount !== 1) {
        throw new ActionLifecycleError(
          "INVALID_TRANSITION",
          "PendingAction changed concurrently",
          actionId,
          current.action.state,
        );
      }
      const updated = cloneRecord({ ...current, action });
      if (nextState === "REJECTED" || nextState === "CANCELLED" || nextState === "EXPIRED") {
        await appendAudit(client, updated, "confirmation.rejected", transitionedAt, {
          state: nextState,
        });
      }
      if (nextState === "REPLAN_REQUIRED") {
        await appendAudit(client, updated, "context.revalidated", transitionedAt, {
          result: "REPLAN_REQUIRED",
        });
      }
      return updated;
    });
  }

  async acceptConfirmation(
    actionId: string,
    confirmationId: string,
    transitionedAt: UtcTimestamp,
  ): Promise<PendingActionRecord> {
    return this.#atomic(actionId, async (client) => {
      void transitionedAt;
      const current = await this.#require(actionId);
      if (current.action.state !== "AWAITING_CONFIRMATION") {
        throw new ActionLifecycleError(
          "INVALID_STATE",
          "Confirmation was already accepted",
          actionId,
          current.action.state,
        );
      }
      const databaseTime = await client.query<{ readonly now: Date; readonly expired: boolean }>(
        `select clock_timestamp() as now,expires_at <= clock_timestamp() as expired
         from pending_actions where action_id=$1`,
        [actionId],
      );
      const now = databaseTime.rows[0]?.now;
      if (now === undefined) throw new Error("PostgreSQL clock is unavailable");
      const authoritativeAt = now.toISOString() as UtcTimestamp;
      if (databaseTime.rows[0]?.expired === true) {
        const action = transitionPendingAction(current.action, "EXPIRED", authoritativeAt);
        await client.query(
          `update pending_actions set state='EXPIRED',action=$1::jsonb,updated_at=$2
           where action_id=$3 and state='AWAITING_CONFIRMATION'`,
          [JSON.stringify(action), authoritativeAt, actionId],
        );
        const expired = cloneRecord({ ...current, action });
        await appendAudit(client, expired, "confirmation.rejected", authoritativeAt, {
          state: "EXPIRED",
        });
        return expired;
      }
      const action = transitionPendingAction(current.action, "CONFIRMED", authoritativeAt);
      const result = await client.query(
        `update pending_actions
         set state='CONFIRMED',action=$1::jsonb,updated_at=$2,token_hash=null,confirmation_id=$3
         where action_id=$4 and state='AWAITING_CONFIRMATION'
           and token_hash is not null and confirmation_id is null
           and expires_at > clock_timestamp()`,
        [JSON.stringify(action), authoritativeAt, confirmationId, actionId],
      );
      if (result.rowCount !== 1) {
        const expiry = await client.query<{ readonly now: Date; readonly expired: boolean }>(
          `select clock_timestamp() as now,expires_at <= clock_timestamp() as expired
           from pending_actions where action_id=$1`,
          [actionId],
        );
        if (expiry.rows[0]?.expired === true && expiry.rows[0]?.now !== undefined) {
          const expiredAt = expiry.rows[0].now.toISOString() as UtcTimestamp;
          const expiredAction = transitionPendingAction(current.action, "EXPIRED", expiredAt);
          const expiredUpdate = await client.query(
            `update pending_actions set state='EXPIRED',action=$1::jsonb,updated_at=$2
             where action_id=$3 and state='AWAITING_CONFIRMATION'
               and expires_at <= clock_timestamp()`,
            [JSON.stringify(expiredAction), expiredAt, actionId],
          );
          if (expiredUpdate.rowCount === 1) {
            const expired = cloneRecord({ ...current, action: expiredAction });
            await appendAudit(client, expired, "confirmation.rejected", expiredAt, {
              state: "EXPIRED",
            });
            return expired;
          }
        }
        throw new ActionLifecycleError(
          "INVALID_STATE",
          "Confirmation was already accepted",
          actionId,
          current.action.state,
        );
      }
      const updated = cloneRecord({ ...current, action, tokenHash: null, confirmationId });
      await appendAudit(client, updated, "confirmation.accepted", authoritativeAt, {
        state: current.action.state,
      });
      return updated;
    });
  }

  async authorize(
    actionId: string,
    authorization: ExecutionAuthorization,
    transitionedAt: UtcTimestamp,
  ): Promise<PendingActionRecord> {
    return this.#atomic(actionId, async (client) => {
      void transitionedAt;
      const current = await this.#require(actionId);
      if (current.authorization !== null) {
        throw new ActionLifecycleError(
          "AUTHORIZATION_ALREADY_ISSUED",
          "Action already has an ExecutionAuthorization",
          actionId,
          current.action.state,
        );
      }
      const authorizationTtlMs =
        Date.parse(authorization.expiresAt) - Date.parse(authorization.issuedAt);
      if (!Number.isSafeInteger(authorizationTtlMs) || authorizationTtlMs < 1) {
        throw new ActionLifecycleError(
          "INVALID_COMMAND",
          "ExecutionAuthorization TTL is invalid",
          actionId,
          current.action.state,
        );
      }
      const databaseTime = await client.query<{ readonly now: Date }>(
        "select clock_timestamp() as now",
      );
      const now = databaseTime.rows[0]?.now;
      if (now === undefined) throw new Error("PostgreSQL clock is unavailable");
      const durableAuthorization = Object.freeze({
        ...authorization,
        issuedAt: now.toISOString() as UtcTimestamp,
        expiresAt: new Date(now.getTime() + authorizationTtlMs).toISOString() as UtcTimestamp,
      });
      const action = transitionPendingAction(
        current.action,
        "READY_FOR_EXECUTION",
        durableAuthorization.issuedAt,
      );
      await client.query(
        `insert into execution_authorizations
          (authorization_id,action_id,"authorization",issued_at,expires_at)
         values ($1,$2,$3::jsonb,$4,$5)`,
        [
          authorization.authorizationId,
          actionId,
          JSON.stringify(durableAuthorization),
          durableAuthorization.issuedAt,
          durableAuthorization.expiresAt,
        ],
      );
      const updatedPending = await client.query(
        `update pending_actions set state='READY_FOR_EXECUTION',action=$1::jsonb,updated_at=$2
         where action_id=$3 and state='CONFIRMED'`,
        [JSON.stringify(action), durableAuthorization.issuedAt, actionId],
      );
      if (updatedPending.rowCount !== 1) {
        throw new ActionLifecycleError(
          "INVALID_TRANSITION",
          "Authorization state transition failed",
          actionId,
          current.action.state,
        );
      }
      const updated = cloneRecord({ ...current, action, authorization: durableAuthorization });
      await appendAudit(client, updated, "context.revalidated", durableAuthorization.issuedAt, {
        result: "VALID",
      });
      await appendAudit(client, updated, "authorization.issued", durableAuthorization.issuedAt, {
        expiresAt: durableAuthorization.expiresAt,
      });
      return updated;
    });
  }

  async consumeAuthorization(
    actionId: string,
    consumedAt: UtcTimestamp,
  ): Promise<PendingActionRecord> {
    void consumedAt;
    return this.#atomic(actionId, async (client) => {
      const current = await this.#require(actionId);
      const result = await client.query(
        `update execution_authorizations
         set consumed_at=clock_timestamp()
         where action_id=$1 and consumed_at is null and expires_at > clock_timestamp()
         returning authorization_id,consumed_at`,
        [actionId],
      );
      if (result.rowCount !== 1) {
        const status = await client.query<{ readonly expired: boolean }>(
          `select expires_at <= clock_timestamp() as expired
           from execution_authorizations where action_id=$1`,
          [actionId],
        );
        if (status.rows[0]?.expired === true) {
          throw new ActionLifecycleError(
            "AUTHORIZATION_EXPIRED",
            "ExecutionAuthorization has expired",
            actionId,
            current.action.state,
          );
        }
        throw new ActionLifecycleError(
          "AUTHORIZATION_ALREADY_USED",
          "ExecutionAuthorization was already consumed",
          actionId,
          current.action.state,
        );
      }
      const consumedAt = (
        result.rows[0] as { readonly consumed_at: Date }
      ).consumed_at.toISOString() as UtcTimestamp;
      const updated = cloneRecord({ ...current, authorizationConsumedAt: consumedAt });
      await appendAudit(client, updated, "authorization.consumed", consumedAt);
      return updated;
    });
  }

  async #require(actionId: string): Promise<PendingActionRecord> {
    const record = await this.get(actionId);
    if (record === undefined) {
      throw new ActionLifecycleError("ACTION_NOT_FOUND", "PendingAction was not found", actionId);
    }
    return record;
  }

  async #atomic<T>(actionId: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const existing = this.#transaction.getStore();
    if (existing !== undefined) return operation(existing);
    return this.runExclusive(actionId, async () => {
      const exclusive = this.#exclusive.getStore();
      if (exclusive === undefined)
        throw new Error("PendingAction exclusive connection is unavailable");
      try {
        await exclusive.query("begin");
        const result = await this.#transaction.run(exclusive, () => operation(exclusive));
        await exclusive.query("commit");
        return result;
      } catch (error) {
        await exclusive.query("rollback");
        throw error;
      }
    });
  }
}
