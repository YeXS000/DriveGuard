import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  safeExecutionError,
  type DurableExecutionCoordinator,
  type DurableExecutionOwnerResult,
  type ExecutionRecord,
  type ExecutionRequest,
  type ExecutionResult,
} from "@driveguard/executor";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { IdempotencyCoordinator } from "@driveguard/memory";

import { assertSafeAuditMetadata } from "./audit.js";

async function coordinationWithin<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface ExecutionRepository {
  get(executionId: string): Promise<ExecutionRecord | undefined>;
  getResult(executionId: string): Promise<ExecutionResult | undefined>;
}

export interface IdempotencyRecord {
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly requestBinding: string;
  readonly executionId: string;
  readonly status: "IN_PROGRESS" | "COMPLETED" | "OUTCOME_UNKNOWN";
  readonly result: ExecutionResult | null;
  readonly ownerExpiresAt: Date;
}

export interface IdempotencyRepository {
  get(idempotencyKey: string): Promise<IdempotencyRecord | undefined>;
}

export class InMemoryExecutionRepository implements ExecutionRepository {
  readonly #records = new Map<
    string,
    { readonly record: ExecutionRecord; readonly result?: ExecutionResult }
  >();

  constructor(
    values: readonly {
      readonly record: ExecutionRecord;
      readonly result?: ExecutionResult;
    }[] = [],
  ) {
    for (const value of values) this.set(value.record, value.result);
  }

  set(record: ExecutionRecord, result?: ExecutionResult): void {
    this.#records.set(record.executionId, {
      record: structuredClone(record),
      ...(result === undefined ? {} : { result: structuredClone(result) }),
    });
  }

  async get(executionId: string): Promise<ExecutionRecord | undefined> {
    await Promise.resolve();
    const record = this.#records.get(executionId)?.record;
    return record === undefined ? undefined : Object.freeze(structuredClone(record));
  }

  async getResult(executionId: string): Promise<ExecutionResult | undefined> {
    await Promise.resolve();
    const result = this.#records.get(executionId)?.result;
    return result === undefined ? undefined : Object.freeze(structuredClone(result));
  }
}

export class InMemoryIdempotencyRepository implements IdempotencyRepository {
  readonly #records = new Map<string, IdempotencyRecord>();

  constructor(values: readonly IdempotencyRecord[] = []) {
    for (const value of values) this.set(value);
  }

  set(record: IdempotencyRecord): void {
    this.#records.set(record.idempotencyKey, structuredClone(record));
  }

  async get(idempotencyKey: string): Promise<IdempotencyRecord | undefined> {
    await Promise.resolve();
    const record = this.#records.get(idempotencyKey);
    return record === undefined ? undefined : Object.freeze(structuredClone(record));
  }
}

interface IdempotencyRow extends QueryResultRow {
  idempotency_key: string;
  fingerprint: string;
  request_binding: string;
  execution_id: string;
  status: IdempotencyRecord["status"];
  result: ExecutionResult | null;
  owner_expires_at: Date;
}

interface ExecutionRow extends QueryResultRow {
  record: ExecutionRecord;
  result: ExecutionResult | null;
}

interface AttemptRow extends QueryResultRow {
  attempt_record: ExecutionRecord["attempts"][number];
}

function initialRecord(
  request: ExecutionRequest,
  at: ExecutionResult["startedAt"],
): ExecutionRecord {
  return Object.freeze({
    executionId: request.executionId,
    toolName: request.toolName,
    actionFingerprint: request.actionFingerprint,
    idempotencyKey: request.idempotencyKey,
    state: "CREATED",
    attempts: Object.freeze([]),
    stateHistory: Object.freeze([Object.freeze({ from: null, to: "CREATED", transitionedAt: at })]),
    createdAt: at,
    updatedAt: at,
  });
}

function runningRecord(record: ExecutionRecord, at: ExecutionResult["startedAt"]): ExecutionRecord {
  return Object.freeze({
    ...record,
    state: "RUNNING",
    updatedAt: at,
    stateHistory: Object.freeze([
      ...record.stateHistory,
      Object.freeze({ from: "CREATED" as const, to: "RUNNING" as const, transitionedAt: at }),
    ]),
  });
}

function unknownResult(
  request: ExecutionRequest,
  startedAt: ExecutionResult["startedAt"],
  attemptCount = 0,
  completedAt = new Date().toISOString() as ExecutionResult["completedAt"],
): ExecutionResult {
  return Object.freeze({
    executionId: request.executionId,
    toolName: request.toolName,
    status: "OUTCOME_UNKNOWN",
    attemptCount,
    deduplicated: true,
    startedAt,
    completedAt,
    error: safeExecutionError("OUTCOME_UNKNOWN"),
  });
}

function deduplicated(result: ExecutionResult): ExecutionResult {
  return Object.freeze({
    ...structuredClone(result),
    deduplicated: true,
  });
}

function conflictResult(request: ExecutionRequest): ExecutionResult {
  const at = new Date().toISOString() as ExecutionResult["completedAt"];
  return Object.freeze({
    executionId: request.executionId,
    toolName: request.toolName,
    status: "REJECTED",
    attemptCount: 0,
    deduplicated: false,
    startedAt: at,
    completedAt: at,
    error: safeExecutionError("IDEMPOTENCY_CONFLICT"),
  });
}

async function appendExecutionAudit(
  client: PoolClient,
  request: ExecutionRequest,
  eventType: string,
  timestamp: string,
  metadata: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  assertSafeAuditMetadata(metadata);
  await client.query(
    `insert into audit_events
      (audit_id,event_type,timestamp,run_id,session_id,trace_id,action_id,execution_id,tool_name,user_id,vehicle_id,safe_metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
    [
      `audit:${randomUUID()}`,
      eventType,
      timestamp,
      request.runId,
      request.sessionId,
      request.traceId,
      request.actionId ?? null,
      request.executionId,
      request.toolName,
      request.userId,
      request.vehicleId,
      JSON.stringify(metadata),
    ],
  );
}

async function databaseTimestamp(client: PoolClient): Promise<ExecutionResult["completedAt"]> {
  const result = await client.query<{ readonly now: Date }>("select clock_timestamp() as now");
  const now = result.rows[0]?.now;
  if (now === undefined) throw new Error("PostgreSQL clock is unavailable");
  return now.toISOString() as ExecutionResult["completedAt"];
}

export class PostgresExecutionRepository implements ExecutionRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async get(executionId: string): Promise<ExecutionRecord | undefined> {
    const result = await this.#pool.query<ExecutionRow>(
      "select record,result from execution_records where execution_id=$1",
      [executionId],
    );
    const record = result.rows[0]?.record;
    if (record === undefined) return undefined;
    const attempts = await this.#pool.query<AttemptRow>(
      `select attempt_record from execution_attempts
       where execution_id=$1 and completed_at is not null order by attempt`,
      [executionId],
    );
    return Object.freeze({
      ...structuredClone(record),
      attempts: Object.freeze(attempts.rows.map((row) => Object.freeze(row.attempt_record))),
    });
  }

  async getResult(executionId: string): Promise<ExecutionResult | undefined> {
    const result = await this.#pool.query<ExecutionRow>(
      "select record,result from execution_records where execution_id=$1",
      [executionId],
    );
    const value = result.rows[0]?.result;
    return value == null ? undefined : Object.freeze(structuredClone(value));
  }
}

export class PostgresIdempotencyRepository implements IdempotencyRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async get(idempotencyKey: string): Promise<IdempotencyRecord | undefined> {
    const result = await this.#pool.query<IdempotencyRow>(
      `select idempotency_key,fingerprint,request_binding,execution_id,status,result,owner_expires_at
       from idempotency_records where idempotency_key=$1`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : Object.freeze({
          idempotencyKey: row.idempotency_key,
          fingerprint: row.fingerprint,
          requestBinding: row.request_binding,
          executionId: row.execution_id,
          status: row.status,
          result: row.result,
          ownerExpiresAt: row.owner_expires_at,
        });
  }
}

interface LocalFlight {
  readonly fingerprint: string;
  readonly requestBinding: string;
  readonly promise: Promise<ExecutionResult>;
}

export class PostgresDurableExecutionCoordinator implements DurableExecutionCoordinator {
  readonly #pool: Pool;
  readonly #ownerLeaseMs: number;
  readonly #shortLivedCoordinator: IdempotencyCoordinator | undefined;
  readonly #coordinationTimeoutMs: number;
  readonly #requireSessionLease: boolean;
  readonly #inflight = new Map<string, LocalFlight>();

  constructor(
    pool: Pool,
    ownerLeaseMs = 30_000,
    shortLivedCoordinator?: IdempotencyCoordinator,
    options: {
      readonly coordinationTimeoutMs?: number;
      readonly requireSessionLease?: boolean;
    } = {},
  ) {
    if (!Number.isSafeInteger(ownerLeaseMs) || ownerLeaseMs < 1) {
      throw new Error("Execution owner lease is invalid");
    }
    this.#pool = pool;
    this.#ownerLeaseMs = ownerLeaseMs;
    this.#shortLivedCoordinator = shortLivedCoordinator;
    this.#coordinationTimeoutMs = options.coordinationTimeoutMs ?? 250;
    if (!Number.isSafeInteger(this.#coordinationTimeoutMs) || this.#coordinationTimeoutMs < 1) {
      throw new Error("Execution coordination timeout is invalid");
    }
    this.#requireSessionLease = options.requireSessionLease ?? false;
  }

  async execute(
    request: ExecutionRequest,
    requestBinding: string,
    owner: () => Promise<DurableExecutionOwnerResult>,
  ): Promise<ExecutionResult> {
    const coordinationOwner = `execution:${randomUUID()}`;
    let shortLivedLease = false;
    try {
      shortLivedLease =
        (this.#shortLivedCoordinator === undefined
          ? undefined
          : await coordinationWithin(
              this.#shortLivedCoordinator.acquire(request.idempotencyKey, coordinationOwner),
              this.#coordinationTimeoutMs,
            )) ?? false;
    } catch {
      // PostgreSQL remains authoritative when Redis coordination is unavailable.
    }
    try {
      const local = this.#inflight.get(request.idempotencyKey);
      if (local !== undefined) {
        if (
          local.fingerprint !== request.actionFingerprint ||
          local.requestBinding !== requestBinding
        ) {
          return conflictResult(request);
        }
        const result = await local.promise;
        await this.#auditDeduplication(request, result.executionId, { local: true });
        return deduplicated(result);
      }

      const acquired = await this.#acquire(request, requestBinding);
      if (acquired.kind === "CONFLICT") return conflictResult(request);
      if (acquired.kind === "DUPLICATE") return acquired.result;
      if (acquired.kind === "IN_PROGRESS") return acquired.result;

      const promise = this.#runOwner(request, owner);
      this.#inflight.set(request.idempotencyKey, {
        fingerprint: request.actionFingerprint,
        requestBinding,
        promise,
      });
      try {
        return await promise;
      } finally {
        const current = this.#inflight.get(request.idempotencyKey);
        if (current?.promise === promise) this.#inflight.delete(request.idempotencyKey);
      }
    } finally {
      if (shortLivedLease) {
        try {
          if (this.#shortLivedCoordinator !== undefined) {
            await coordinationWithin(
              this.#shortLivedCoordinator.release(request.idempotencyKey, coordinationOwner),
              this.#coordinationTimeoutMs,
            );
          }
        } catch {
          // Redis coordination is availability-only and TTL-bound.
        }
      }
    }
  }

  async #acquire(
    request: ExecutionRequest,
    requestBinding: string,
  ): Promise<
    | { readonly kind: "OWNER" }
    | { readonly kind: "CONFLICT" }
    | { readonly kind: "DUPLICATE" | "IN_PROGRESS"; readonly result: ExecutionResult }
  > {
    const client = await this.#pool.connect();
    try {
      await client.query("begin");
      if (this.#requireSessionLease) {
        const sessionLease = await client.query(
          `select session_id from agent_sessions
           where session_id=$1 and busy_owner=$2 and busy_expires_at > clock_timestamp()
           for share`,
          [request.sessionId, request.runId],
        );
        if (sessionLease.rowCount !== 1) {
          throw new Error("Durable session lease is not owned by this execution run");
        }
      }
      const databaseTime = await client.query<{ readonly now: Date }>(
        "select clock_timestamp() as now",
      );
      const now = databaseTime.rows[0]?.now;
      if (now === undefined) throw new Error("PostgreSQL clock is unavailable");
      const at = now.toISOString() as ExecutionResult["startedAt"];
      const created = initialRecord(request, at);
      const running = runningRecord(created, at);
      const session = await client.query(
        `insert into agent_sessions (session_id,user_id,vehicle_id,created_at,updated_at)
         values ($1,$2,$3,$4,$4)
         on conflict (session_id) do update
         set user_id=coalesce(agent_sessions.user_id,excluded.user_id),
             vehicle_id=coalesce(agent_sessions.vehicle_id,excluded.vehicle_id),
             updated_at=excluded.updated_at
         where (agent_sessions.user_id is null or agent_sessions.user_id=excluded.user_id)
           and (agent_sessions.vehicle_id is null or agent_sessions.vehicle_id=excluded.vehicle_id)
         returning session_id`,
        [request.sessionId, request.userId, request.vehicleId, at],
      );
      if (session.rowCount !== 1) throw new Error("Execution session identity mismatch");
      const executionInsert = await client.query(
        `insert into execution_records
          (execution_id,action_id,run_id,session_id,trace_id,tool_name,state,request,record,created_at,updated_at)
         values ($1,$2,$3,$4,$5,$6,'CREATED',$7::jsonb,$8::jsonb,$9,$9)
         on conflict (execution_id) do nothing returning execution_id`,
        [
          request.executionId,
          request.actionId ?? null,
          request.runId,
          request.sessionId,
          request.traceId,
          request.toolName,
          JSON.stringify(request),
          JSON.stringify(created),
          at,
        ],
      );
      let insertedExecution = executionInsert.rowCount === 1;
      let insertedIdempotency = false;
      if (insertedExecution) {
        const idempotencyInsert = await client.query(
          `insert into idempotency_records
            (idempotency_key,fingerprint,request_binding,execution_id,status,owner_expires_at,created_at,updated_at)
           values ($1,$2,$3,$4,'IN_PROGRESS',
                   clock_timestamp() + ($5 * interval '1 millisecond'),
                   clock_timestamp(),clock_timestamp())
           on conflict (idempotency_key) do nothing returning idempotency_key`,
          [
            request.idempotencyKey,
            request.actionFingerprint,
            requestBinding,
            request.executionId,
            this.#ownerLeaseMs,
          ],
        );
        insertedIdempotency = idempotencyInsert.rowCount === 1;
        if (!insertedIdempotency) {
          await client.query("delete from execution_records where execution_id=$1", [
            request.executionId,
          ]);
          insertedExecution = false;
        }
      }
      if (insertedExecution && insertedIdempotency) {
        await client.query(
          `update execution_records set state='RUNNING',record=$1::jsonb,started_at=$2,updated_at=$2
           where execution_id=$3 and state='CREATED'`,
          [JSON.stringify(running), at, request.executionId],
        );
        await appendExecutionAudit(client, request, "policy.decision", at, {
          decision: request.policyDecision.decision,
          ruleId: request.policyDecision.ruleId,
        });
        await appendExecutionAudit(client, request, "execution.started", at);
        await client.query("commit");
        return { kind: "OWNER" };
      }

      const existingResult = await client.query<IdempotencyRow>(
        `select idempotency_key,fingerprint,request_binding,execution_id,status,result,owner_expires_at
         from idempotency_records where idempotency_key=$1 for update`,
        [request.idempotencyKey],
      );
      const existing = existingResult.rows[0];
      if (
        existing === undefined ||
        existing.fingerprint !== request.actionFingerprint ||
        existing.request_binding !== requestBinding
      ) {
        await client.query("commit");
        return { kind: "CONFLICT" };
      }
      if (existing.result !== null && existing.status !== "IN_PROGRESS") {
        await appendExecutionAudit(
          client,
          { ...request, executionId: existing.execution_id },
          "idempotency.deduplicated",
          at,
          { originalExecutionId: existing.execution_id },
        );
        await client.query("commit");
        return { kind: "DUPLICATE", result: deduplicated(existing.result) };
      }

      const execution = await client.query<ExecutionRow & { created_at: Date }>(
        "select record,result,created_at from execution_records where execution_id=$1",
        [existing.execution_id],
      );
      const startedAt = execution.rows[0]?.created_at.toISOString() as
        ExecutionResult["startedAt"] | undefined;
      const persistedAttempts = await client.query<{ readonly count: string }>(
        "select count(*) from execution_attempts where execution_id=$1",
        [existing.execution_id],
      );
      const unknown = unknownResult(
        { ...request, executionId: existing.execution_id },
        startedAt ?? at,
        Number(persistedAttempts.rows[0]?.count ?? 0),
        at,
      );
      if (existing.owner_expires_at.getTime() <= now.getTime()) {
        const currentRecord = execution.rows[0]?.record ?? running;
        const unknownRecord: ExecutionRecord = Object.freeze({
          ...currentRecord,
          state: "OUTCOME_UNKNOWN",
          updatedAt: unknown.completedAt,
          stateHistory: Object.freeze([
            ...currentRecord.stateHistory,
            Object.freeze({
              from: currentRecord.state,
              to: "OUTCOME_UNKNOWN" as const,
              transitionedAt: unknown.completedAt,
            }),
          ]),
        });
        await client.query(
          `update execution_records
           set state='OUTCOME_UNKNOWN',record=$1::jsonb,result=$2::jsonb,completed_at=$3,updated_at=$3
           where execution_id=$4 and state='RUNNING'`,
          [
            JSON.stringify(unknownRecord),
            JSON.stringify(unknown),
            unknown.completedAt,
            existing.execution_id,
          ],
        );
        await client.query(
          `update idempotency_records
           set status='OUTCOME_UNKNOWN',result=$1::jsonb,updated_at=$2
           where idempotency_key=$3 and status='IN_PROGRESS'`,
          [JSON.stringify(unknown), unknown.completedAt, request.idempotencyKey],
        );
        await client.query(
          `update execution_attempts
           set attempt_record=attempt_record || $1::jsonb,completed_at=$2
           where execution_id=$3 and completed_at is null`,
          [
            JSON.stringify({
              completedAt: unknown.completedAt,
              outcome: "OUTCOME_UNKNOWN",
              errorCode: "OUTCOME_UNKNOWN",
            }),
            unknown.completedAt,
            existing.execution_id,
          ],
        );
        await appendExecutionAudit(
          client,
          { ...request, executionId: existing.execution_id },
          "execution.outcome_unknown",
          unknown.completedAt,
          {
            reason: "OWNER_LEASE_EXPIRED",
          },
        );
      }
      await appendExecutionAudit(
        client,
        { ...request, executionId: existing.execution_id },
        "idempotency.deduplicated",
        at,
        { originalExecutionId: existing.execution_id, inProgress: true },
      );
      await client.query("commit");
      return { kind: "IN_PROGRESS", result: unknown };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async #runOwner(
    request: ExecutionRequest,
    owner: () => Promise<DurableExecutionOwnerResult>,
  ): Promise<ExecutionResult> {
    const heartbeat = new AbortController();
    let leaseLost = false;
    const heartbeatTask = this.#heartbeat(request, heartbeat.signal, () => {
      leaseLost = true;
    });
    let ownerResult: DurableExecutionOwnerResult;
    try {
      ownerResult = await owner();
    } catch {
      const at = new Date().toISOString() as ExecutionResult["completedAt"];
      const result: ExecutionResult = Object.freeze({
        executionId: request.executionId,
        toolName: request.toolName,
        status: "FAILED",
        attemptCount: 0,
        deduplicated: false,
        startedAt: at,
        completedAt: at,
        error: safeExecutionError("INTERNAL_EXECUTION_ERROR"),
      });
      const record = runningRecord(initialRecord(request, at), at);
      ownerResult = {
        result,
        record: Object.freeze({
          ...record,
          state: "FAILED",
          updatedAt: at,
          stateHistory: Object.freeze([
            ...record.stateHistory,
            Object.freeze({ from: "RUNNING" as const, to: "FAILED" as const, transitionedAt: at }),
          ]),
        }),
      };
    } finally {
      heartbeat.abort();
      await heartbeatTask;
    }
    if (leaseLost) ownerResult = this.#unknownAfterLeaseLoss(request, ownerResult);
    try {
      const finalized = await this.#finalize(request, ownerResult);
      return finalized.result;
    } catch (error) {
      try {
        const durable = await new PostgresExecutionRepository(this.#pool).getResult(
          request.executionId,
        );
        if (durable !== undefined) return durable;
      } catch {
        // Preserve the original finalization failure when reconciliation is unavailable.
      }
      throw error;
    }
  }

  async #finalize(
    request: ExecutionRequest,
    owner: DurableExecutionOwnerResult,
  ): Promise<DurableExecutionOwnerResult> {
    const client = await this.#pool.connect();
    try {
      await client.query("begin");
      if (this.#requireSessionLease) {
        const sessionLease = await client.query(
          `select session_id from agent_sessions
           where session_id=$1 and busy_owner=$2 and busy_expires_at > clock_timestamp()
           for share`,
          [request.sessionId, request.runId],
        );
        if (sessionLease.rowCount !== 1 && owner.result.status !== "OUTCOME_UNKNOWN") {
          owner = this.#unknownAfterLeaseLoss(request, owner);
        }
      }
      const ownership = await client.query(
        `select idempotency_key from idempotency_records
         where idempotency_key=$1 and execution_id=$2 and status='IN_PROGRESS'
         for update`,
        [request.idempotencyKey, request.executionId],
      );
      if (ownership.rowCount !== 1) throw new Error("Idempotency finalization lost ownership");
      const updated = await client.query(
        `update execution_records
         set state=$1,record=$2::jsonb,result=$3::jsonb,completed_at=$4,updated_at=$4
         where execution_id=$5 and state='RUNNING'
         returning execution_id`,
        [
          owner.result.status,
          JSON.stringify(owner.record),
          JSON.stringify(owner.result),
          owner.result.completedAt,
          request.executionId,
        ],
      );
      if (updated.rowCount !== 1) throw new Error("Execution finalization lost ownership");
      for (const attempt of owner.record.attempts) {
        await client.query(
          `insert into execution_attempts
            (execution_id,attempt,attempt_record,started_at,completed_at)
           values ($1,$2,$3::jsonb,$4,$5)
           on conflict (execution_id,attempt) do update
           set attempt_record=excluded.attempt_record,
               started_at=excluded.started_at,
               completed_at=excluded.completed_at`,
          [
            request.executionId,
            attempt.attempt,
            JSON.stringify(attempt),
            attempt.startedAt,
            attempt.completedAt,
          ],
        );
        if (attempt.attempt > 1) {
          await appendExecutionAudit(client, request, "execution.retry", attempt.startedAt, {
            attempt: attempt.attempt,
          });
        }
      }
      const idempotencyStatus =
        owner.result.status === "OUTCOME_UNKNOWN" ? "OUTCOME_UNKNOWN" : "COMPLETED";
      const idempotencyUpdate = await client.query(
        `update idempotency_records
         set status=$1,result=$2::jsonb,updated_at=$3
         where idempotency_key=$4 and execution_id=$5 and status='IN_PROGRESS'
         returning idempotency_key`,
        [
          idempotencyStatus,
          JSON.stringify(owner.result),
          owner.result.completedAt,
          request.idempotencyKey,
          request.executionId,
        ],
      );
      if (idempotencyUpdate.rowCount !== 1)
        throw new Error("Idempotency finalization lost ownership");
      const eventType =
        owner.result.status === "SUCCEEDED"
          ? "execution.succeeded"
          : owner.result.status === "OUTCOME_UNKNOWN"
            ? "execution.outcome_unknown"
            : "execution.failed";
      const auditAt = await databaseTimestamp(client);
      await appendExecutionAudit(client, request, eventType, auditAt, {
        status: owner.result.status,
        attemptCount: owner.result.attemptCount,
      });
      await client.query("commit");
      return owner;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async #heartbeat(
    request: ExecutionRequest,
    signal: AbortSignal,
    onLost: () => void,
  ): Promise<void> {
    const intervalMs = Math.max(1, Math.floor(this.#ownerLeaseMs / 4));
    while (!signal.aborted) {
      try {
        await delay(intervalMs, undefined, { signal });
      } catch {
        return;
      }
      if (signal.aborted) return;
      const renewal = this.#pool
        .query(
          `update idempotency_records
           set owner_expires_at=clock_timestamp() + ($1 * interval '1 millisecond'),
               updated_at=clock_timestamp()
           where idempotency_key=$2 and execution_id=$3 and status='IN_PROGRESS'
             and owner_expires_at > clock_timestamp()`,
          [this.#ownerLeaseMs, request.idempotencyKey, request.executionId],
        )
        .then((result) => result.rowCount === 1)
        .catch(() => false);
      const renewed = await Promise.race([renewal, delay(intervalMs).then(() => false)]);
      if (!renewed) {
        onLost();
        return;
      }
    }
  }

  #unknownAfterLeaseLoss(
    request: ExecutionRequest,
    owner: DurableExecutionOwnerResult,
  ): DurableExecutionOwnerResult {
    const completedAt = new Date().toISOString() as ExecutionResult["completedAt"];
    const started = runningRecord(
      initialRecord(request, owner.result.startedAt),
      owner.result.startedAt,
    );
    const record: ExecutionRecord = Object.freeze({
      ...started,
      state: "OUTCOME_UNKNOWN",
      attempts: owner.record.attempts,
      updatedAt: completedAt,
      stateHistory: Object.freeze([
        ...started.stateHistory,
        Object.freeze({
          from: "RUNNING" as const,
          to: "OUTCOME_UNKNOWN" as const,
          transitionedAt: completedAt,
        }),
      ]),
    });
    return Object.freeze({
      record,
      result: Object.freeze({
        executionId: request.executionId,
        toolName: request.toolName,
        status: "OUTCOME_UNKNOWN",
        attemptCount: owner.record.attempts.length,
        deduplicated: false,
        startedAt: owner.result.startedAt,
        completedAt,
        error: safeExecutionError("OUTCOME_UNKNOWN"),
      }),
    });
  }

  async #auditDeduplication(
    request: ExecutionRequest,
    originalExecutionId: string,
    metadata: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await appendExecutionAudit(
        client,
        { ...request, executionId: originalExecutionId },
        "idempotency.deduplicated",
        await databaseTimestamp(client),
        { originalExecutionId, ...metadata },
      );
    } finally {
      client.release();
    }
  }
}
