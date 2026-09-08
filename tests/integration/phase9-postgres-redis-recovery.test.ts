import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { readFile } from "node:fs/promises";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { createActionFingerprint } from "@driveguard/action-lifecycle";
import { toUtcTimestamp } from "@driveguard/domain";
import type { ExecutionRecord, ExecutionRequest, ExecutionResult } from "@driveguard/executor";
import {
  FallbackSessionCoordinator,
  RedisConversationCache,
  RedisIdempotencyCoordinator,
  RedisSessionCoordinator,
  RepositoryConversationMemory,
  sessionKey,
  sessionLockKey,
  type RedisCommands,
  type ConversationMemory,
} from "@driveguard/memory";
import {
  PostgresAuditRepository,
  PostgresAuthorizationRepository,
  PostgresConversationRepository,
  PostgresDurableExecutionCoordinator,
  PostgresExecutionAttemptEventSink,
  PostgresExecutionRepository,
  PostgresIdempotencyRepository,
  PostgresPendingActionRepository,
  PostgresSessionCoordinator,
  PostgresSessionRepository,
  createPhase9RuntimeBindings,
  createAuditEvent,
  createPostgresDatabase,
  migratePersistence,
} from "@driveguard/persistence";
import { buildVehicleSimulator } from "@driveguard/vehicle-simulator";
import { createClient } from "redis";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createPhase9ProductionDriveGuardRuntime,
  DEFAULT_PHASE_5_CAPABILITIES,
  DEFAULT_PHASE_5_SERVICES,
} from "../../packages/agent-runtime/src/index.js";
import { createPhase7Harness } from "../fixtures/phase7-lifecycle.js";

const DATABASE_URL = process.env.PHASE9_DATABASE_URL;
const REDIS_URL = process.env.PHASE9_REDIS_URL;
const REDIS_CONNECTION_URL = REDIS_URL ?? "redis://127.0.0.1:1";
const integration =
  DATABASE_URL === undefined || REDIS_URL === undefined ? describe.skip : describe;
const reliabilityMatrix = process.env.PHASE9_SKIP_RELIABILITY_MATRIX === "1" ? it.skip : it;
const BASE_TIME = "2026-08-29T12:00:00.000Z";

function memoryIdentity(
  sessionId: string,
  userId = "user:memory-test",
  vehicleId = "vehicle:memory-test",
) {
  return {
    sessionId,
    userId,
    vehicleId,
    updatedAt: toUtcTimestamp(Date.parse(BASE_TIME)),
  } as const;
}

function confirmationHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function policyDecision(toolName: string, riskLevel: "R0" | "R1" | "R2" | "R3") {
  return Object.freeze({
    decision:
      riskLevel === "R0" || riskLevel === "R1"
        ? ("ALLOW" as const)
        : ("REQUIRE_CONFIRMATION" as const),
    ruleId: `phase9-${riskLevel.toLowerCase()}`,
    reasonCode:
      riskLevel === "R0"
        ? ("R0_ALLOWED" as const)
        : riskLevel === "R1"
          ? ("R1_ALLOWED" as const)
          : riskLevel === "R2"
            ? ("R2_CONFIRMATION_REQUIRED" as const)
            : ("R3_CONFIRMATION_REQUIRED" as const),
    toolName,
    riskLevel,
    contextSnapshotId: "snapshot:phase9",
    contextVersion: 1,
    evaluatedAt: toUtcTimestamp(Date.parse(BASE_TIME)),
    evidence: {
      freshnessStatus: "FRESH" as const,
      conflictStatus: "NOT_EVALUATED" as const,
      contextChanged: false,
      requiredCapabilityAvailable: true,
      serviceAvailable: true,
    },
  });
}

function request(index: number, overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  const validatedArguments = overrides.validatedArguments ?? {};
  const sessionId = overrides.sessionId ?? "session:phase9:execution";
  const userId = overrides.userId ?? "user:phase9";
  const vehicleId = overrides.vehicleId ?? "vehicle:phase9";
  const contextSnapshotId = overrides.contextSnapshotId ?? "snapshot:phase9";
  const contextVersion = overrides.contextVersion ?? 1;
  const fingerprint =
    overrides.actionFingerprint ??
    createActionFingerprint({
      toolName: overrides.toolName ?? "get_vehicle_state",
      validatedArguments,
      sessionId,
      userId,
      vehicleId,
      contextSnapshotId,
      contextVersion,
    });
  return {
    executionId: `execution:phase9:${index}`,
    toolName: "get_vehicle_state",
    validatedArguments,
    actionFingerprint: fingerprint,
    runId: `run:phase9:${index}`,
    sessionId,
    userId,
    vehicleId,
    traceId: `trace:phase9:${index}`,
    riskLevel: "R0",
    policyDecision: policyDecision("get_vehicle_state", "R0"),
    contextSnapshotId,
    contextVersion,
    idempotencyKey: `idem:phase9:${index}`,
    createdAt: toUtcTimestamp(Date.parse(BASE_TIME)),
    ...overrides,
  };
}

function ownerOutcome(input: ExecutionRequest): {
  readonly result: ExecutionResult;
  readonly record: ExecutionRecord;
} {
  const startedAt = toUtcTimestamp(Date.parse(BASE_TIME) + 1);
  const completedAt = toUtcTimestamp(Date.parse(BASE_TIME) + 2);
  const result: ExecutionResult = Object.freeze({
    executionId: input.executionId,
    toolName: input.toolName,
    status: "SUCCEEDED",
    attemptCount: 1,
    deduplicated: false,
    startedAt,
    completedAt,
    result: Object.freeze({ ok: true }),
  });
  const record: ExecutionRecord = Object.freeze({
    executionId: input.executionId,
    toolName: input.toolName,
    actionFingerprint: input.actionFingerprint,
    idempotencyKey: input.idempotencyKey,
    state: "SUCCEEDED",
    attempts: Object.freeze([
      Object.freeze({
        attempt: 1,
        startedAt,
        completedAt,
        outcome: "SUCCEEDED" as const,
      }),
    ]),
    stateHistory: Object.freeze([
      Object.freeze({ from: null, to: "CREATED" as const, transitionedAt: startedAt }),
      Object.freeze({
        from: "CREATED" as const,
        to: "RUNNING" as const,
        transitionedAt: startedAt,
      }),
      Object.freeze({
        from: "RUNNING" as const,
        to: "SUCCEEDED" as const,
        transitionedAt: completedAt,
      }),
    ]),
    createdAt: startedAt,
    updatedAt: completedAt,
  });
  return { result, record };
}

integration("Phase 9 PostgreSQL + Redis integration and restart recovery", () => {
  const database = createPostgresDatabase({ connectionString: DATABASE_URL });
  const redis = createClient({ url: REDIS_CONNECTION_URL });
  let simulator: FastifyInstance;
  let simulatorBaseUrl: string;
  let providerSequence = 0;

  beforeAll(async () => {
    await migratePersistence(database.db);
    await migratePersistence(database.db);
    await redis.connect();
    simulator = buildVehicleSimulator();
    simulatorBaseUrl = await simulator.listen({ host: "127.0.0.1", port: 0 });
  });

  beforeEach(async () => {
    await database.pool.query(
      "set session_replication_role=replica; truncate table audit_events,idempotency_records,execution_attempts,execution_records,execution_authorizations,pending_actions,conversation_messages,agent_sessions restart identity cascade; set session_replication_role=origin",
    );
    await redis.flushDb();
  });

  afterAll(async () => {
    await simulator?.close();
    if (redis.isOpen) await redis.close();
    await database.close();
  });

  it("runs migration twice and exposes all eight required tables", async () => {
    const result = await database.pool.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname='public' and tablename <> '__drizzle_migrations' order by tablename",
    );
    expect(result.rows.map((row) => row.tablename)).toEqual([
      "agent_sessions",
      "audit_events",
      "conversation_messages",
      "execution_attempts",
      "execution_authorizations",
      "execution_records",
      "idempotency_records",
      "pending_actions",
    ]);
  });

  it("guards idle and checked-out PostgreSQL failures from terminating the process", async () => {
    expect(database.pool.listenerCount("error")).toBeGreaterThan(0);
    const client = await database.pool.connect();
    try {
      expect(client.listenerCount("error")).toBeGreaterThan(0);
    } finally {
      client.release();
    }
  });

  it.each([
    ["missing required request identity", {}],
    [
      "action ID present only in JSON",
      {
        executionId: "execution:invalid-binding",
        sessionId: "session:invalid-binding",
        runId: "run:invalid-binding",
        traceId: "trace:invalid-binding",
        toolName: "get_vehicle_state",
        actionId: "action:orphan",
      },
    ],
  ])("rejects execution rows with %s", async (_case, requestJson) => {
    await database.pool.query(
      `insert into agent_sessions (session_id,user_id,vehicle_id,created_at,updated_at)
       values ('session:invalid-binding','user:phase9','vehicle:phase9',clock_timestamp(),clock_timestamp())`,
    );
    await expect(
      database.pool.query(
        `insert into execution_records
          (execution_id,action_id,run_id,session_id,trace_id,tool_name,state,request,record,created_at,updated_at)
         values
          ('execution:invalid-binding',null,'run:invalid-binding','session:invalid-binding',
           'trace:invalid-binding','get_vehicle_state','CREATED',$1::jsonb,'{}'::jsonb,
           clock_timestamp(),clock_timestamp())`,
        [JSON.stringify(requestJson)],
      ),
    ).rejects.toMatchObject({ constraint: "execution_records_request_binding_ck" });
  });

  it("supports an operational up -> down -> up migration cycle", async () => {
    const rollback = await readFile("infra/db/rollback/0000_phase9_persistence.down.sql", "utf8");
    const client = await database.pool.connect();
    try {
      await client.query("begin");
      await client.query(rollback);
      await client.query(rollback);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    await migratePersistence(database.db);
    const result = await database.pool.query<{ count: string }>(
      `select count(*) from pg_tables where schemaname='public'
       and tablename in ('agent_sessions','conversation_messages','pending_actions','execution_authorizations','execution_records','execution_attempts','idempotency_records','audit_events')`,
    );
    expect(Number(result.rows[0]?.count)).toBe(8);
    await expect(
      database.pool.query(
        `select count(*) from pg_trigger
         where tgname='audit_events_append_only' and not tgisinternal`,
      ),
    ).resolves.toMatchObject({ rows: [{ count: "1" }] });
  });

  it("rolls back both messages when one append in a conversation transaction violates uniqueness", async () => {
    const sessions = new PostgresSessionRepository(database.db);
    const conversation = new PostgresConversationRepository(database.db);
    const memory = new RepositoryConversationMemory({ sessions, conversation });
    await memory.appendTurn({
      sessionId: "session:rollback",
      userMessageId: "message:duplicate",
      userContent: "first",
      assistantMessageId: "message:first-assistant",
      assistantContent: "first response",
      createdAt: toUtcTimestamp(Date.parse(BASE_TIME)),
    });
    await expect(
      memory.appendTurn({
        sessionId: "session:rollback",
        userMessageId: "message:duplicate",
        userContent: "must rollback",
        assistantMessageId: "message:rolled-back-assistant",
        assistantContent: "must rollback",
        createdAt: toUtcTimestamp(Date.parse(BASE_TIME) + 10),
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
    await expect(conversation.list("session:rollback")).resolves.toHaveLength(2);
  });

  it("restores committed conversation after repositories and memory are recreated", async () => {
    const first = new RepositoryConversationMemory({
      sessions: new PostgresSessionRepository(database.db),
      conversation: new PostgresConversationRepository(database.db),
    });
    await first.appendTurn({
      sessionId: "session:restart",
      userMessageId: "message:restart:user",
      userContent: "turn one",
      assistantMessageId: "message:restart:assistant",
      assistantContent: "turn one answer",
      createdAt: toUtcTimestamp(Date.parse(BASE_TIME)),
    });
    const restored = await new RepositoryConversationMemory({
      sessions: new PostgresSessionRepository(database.db),
      conversation: new PostgresConversationRepository(database.db),
    }).restore(memoryIdentity("session:restart"));
    expect(restored.map((message) => message.content)).toEqual(["turn one", "turn one answer"]);
  });

  it("prefers durable conversation over stale Redis and redacts sensitive content before PostgreSQL", async () => {
    const client = redis as unknown as RedisCommands;
    const cache = new RedisConversationCache(client, 30_000);
    await cache.set("session:stale", [
      {
        messageId: "message:stale",
        sessionId: "session:stale",
        role: "assistant",
        content: "old",
        createdAt: toUtcTimestamp(Date.parse(BASE_TIME)),
        sequence: 0,
      },
    ]);
    const memory = new RepositoryConversationMemory({
      sessions: new PostgresSessionRepository(database.db),
      conversation: new PostgresConversationRepository(database.db),
      cache,
    });
    await memory.appendTurn({
      sessionId: "session:stale",
      userMessageId: "message:secret:user",
      userContent:
        "Authorization: Basic user-secret\nAuthorization=opaque-secret\napi_key=plain-key credential=plain-credential",
      assistantMessageId: "message:secret:assistant",
      assistantContent:
        "confirmation_token=plain-token cookie=plain-cookie internal reasoning=hidden",
      createdAt: toUtcTimestamp(Date.parse(BASE_TIME) + 1),
    });
    const restored = await memory.restore(memoryIdentity("session:stale"));
    expect(restored).toHaveLength(2);
    const persisted = await database.pool.query<{ content: string }>(
      "select content from conversation_messages where session_id=$1 order by sequence",
      ["session:stale"],
    );
    const text = persisted.rows.map((row) => row.content).join(" ");
    expect(text).not.toMatch(
      /user-secret|opaque-secret|plain-key|plain-credential|plain-token|plain-cookie|hidden/u,
    );
    expect(text).toContain("[REDACTED]");
  });

  it("covers PostgreSQL session lookup, stable creation time, lease expiry, and owner-checked release", async () => {
    const repository = new PostgresSessionRepository(database.db);
    await expect(repository.get("session:missing")).resolves.toBeUndefined();
    const initial = {
      sessionId: "session:lease",
      createdAt: toUtcTimestamp(Date.parse(BASE_TIME)),
      updatedAt: toUtcTimestamp(Date.parse(BASE_TIME)),
    };
    await repository.upsert(initial);
    const updatedAt = toUtcTimestamp(Date.parse(BASE_TIME) + 1_000);
    await repository.upsert({ ...initial, createdAt: updatedAt, updatedAt });
    await expect(repository.get(initial.sessionId)).resolves.toMatchObject({
      createdAt: initial.createdAt,
      updatedAt,
    });
    const identity = {
      sessionId: initial.sessionId,
      userId: "user:lease",
      vehicleId: "vehicle:lease",
      updatedAt,
    };
    await expect(repository.bindIdentity(identity)).resolves.toMatchObject(identity);
    await expect(repository.bindIdentity(identity)).resolves.toMatchObject(identity);
    await expect(
      repository.bindIdentity({ ...identity, vehicleId: "vehicle:other" }),
    ).rejects.toThrow(/identity mismatch/u);

    const coordinator = new PostgresSessionCoordinator(database.db, 10);
    await expect(coordinator.acquire(initial.sessionId, "run:lease:1")).resolves.toBe(true);
    await expect(coordinator.acquire(initial.sessionId, "run:lease:2")).resolves.toBe(false);
    await coordinator.release(initial.sessionId, "run:wrong-owner");
    await expect(coordinator.acquire(initial.sessionId, "run:lease:2")).resolves.toBe(false);
    await delay(15);
    await expect(coordinator.acquire(initial.sessionId, "run:lease:2")).resolves.toBe(true);
    await coordinator.release(initial.sessionId, "run:lease:2");
    await expect(coordinator.acquire(initial.sessionId, "run:lease:3")).resolves.toBe(true);
    expect(() => new PostgresSessionCoordinator(database.db, 0)).toThrow(/TTL/u);
  });

  it("fences conversation commits by the authoritative PostgreSQL session owner", async () => {
    const coordinator = new PostgresSessionCoordinator(database.db, 1_000);
    await expect(coordinator.acquire("session:conversation-fence", "run:owner")).resolves.toBe(
      true,
    );
    const conversation = new PostgresConversationRepository(database.db);
    const memory = new RepositoryConversationMemory({
      sessions: new PostgresSessionRepository(database.db),
      conversation,
    });
    const turn = {
      sessionId: "session:conversation-fence",
      userMessageId: "message:fence:user",
      userContent: "hello",
      assistantMessageId: "message:fence:assistant",
      assistantContent: "world",
      createdAt: toUtcTimestamp(Date.now()),
    };
    await expect(memory.appendTurn({ ...turn, ownerId: "run:contender" })).rejects.toThrow(
      /session lease/u,
    );
    await expect(conversation.list(turn.sessionId)).resolves.toEqual([]);
    await expect(memory.appendTurn({ ...turn, ownerId: "run:owner" })).resolves.toHaveLength(2);
    await coordinator.release(turn.sessionId, "run:owner");
  });

  it("persists PendingAction, recovers it, and atomically allows one authorization consumption", async () => {
    const harness = createPhase7Harness({ withEvents: false });
    const command = harness.command();
    const created = await harness.service.create(command);
    const confirmed = await harness.service.confirm({
      actionId: created.action.actionId,
      confirmationToken: created.trustedChallenge.confirmationToken,
      sessionId: created.action.sessionId,
      userId: created.action.userId,
    });
    expect(confirmed.authorization).not.toBeNull();
    const first = new PostgresPendingActionRepository(database.pool);
    await first.create({
      action: Object.freeze({
        ...created.action,
        expiresAt: toUtcTimestamp(Date.now() + 60_000),
      }),
      originalContext: command.contextSnapshot,
      tokenHash: "d4f4d527cfd10f45f012923c979551b18f4723ace705f82a24f7a6d923980d7d",
      confirmationId: null,
      authorization: null,
    });
    const restarted = new PostgresPendingActionRepository(database.pool);
    expect((await restarted.get(created.action.actionId))?.action.state).toBe(
      "AWAITING_CONFIRMATION",
    );
    await restarted.acceptConfirmation(
      created.action.actionId,
      "confirmation:durable",
      confirmed.action.updatedAt,
    );
    await expect(
      restarted.acceptConfirmation(
        created.action.actionId,
        "confirmation:duplicate",
        confirmed.action.updatedAt,
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    const durableAuthorization = Object.freeze({
      ...confirmed.authorization!,
      issuedAt: toUtcTimestamp(Date.now()),
      expiresAt: toUtcTimestamp(Date.now() + 60_000),
    });
    await restarted.authorize(
      created.action.actionId,
      durableAuthorization,
      durableAuthorization.issuedAt,
    );
    await expect(
      restarted.authorize(
        created.action.actionId,
        durableAuthorization,
        durableAuthorization.issuedAt,
      ),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_ALREADY_ISSUED" });
    const authorizationRepository = new PostgresAuthorizationRepository(database.pool);
    await expect(authorizationRepository.getById("authorization:missing")).resolves.toBeUndefined();
    await expect(
      authorizationRepository.getById(durableAuthorization.authorizationId),
    ).resolves.toMatchObject({
      authorization: { authorizationId: durableAuthorization.authorizationId },
      consumedAt: null,
    });
    await expect(
      authorizationRepository.getByActionId(created.action.actionId),
    ).resolves.toMatchObject({
      authorization: { actionId: created.action.actionId },
    });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 100 }, () => {
        const repository = new PostgresPendingActionRepository(database.pool);
        return repository.consumeAuthorization(
          created.action.actionId,
          durableAuthorization.issuedAt,
        );
      }),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(99);
    const replayRepository = new PostgresPendingActionRepository(database.pool);
    await expect(
      replayRepository.consumeAuthorization(created.action.actionId, durableAuthorization.issuedAt),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_ALREADY_USED" });
    const consumed = await authorizationRepository.getByActionId(created.action.actionId);
    expect(typeof consumed?.consumedAt).toBe("string");

    const executionInput = request(30, {
      actionId: created.action.actionId,
      riskLevel: "R2",
      policyDecision: policyDecision("get_vehicle_state", "R2"),
    });
    const execution = new PostgresDurableExecutionCoordinator(database.pool);
    await execution.execute(executionInput, "binding:action-audit", () =>
      Promise.resolve(ownerOutcome(executionInput)),
    );
    await execution.execute(executionInput, "binding:action-audit", () =>
      Promise.resolve(ownerOutcome(executionInput)),
    );
    const requiredAudit = [
      "policy.decision",
      "pending_action.created",
      "confirmation.accepted",
      "context.revalidated",
      "authorization.issued",
      "authorization.consumed",
      "execution.started",
      "execution.succeeded",
      "idempotency.deduplicated",
    ];
    const actionAudit = await new PostgresAuditRepository(database.db).list({
      actionId: created.action.actionId,
    });
    const executionAudit = await new PostgresAuditRepository(database.db).list({
      executionId: executionInput.executionId,
    });
    expect(executionAudit).not.toHaveLength(0);
    expect(executionAudit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: executionInput.userId,
          vehicleId: executionInput.vehicleId,
        }),
      ]),
    );
    const present = new Set(actionAudit.map((event) => event.eventType));
    const completeness = requiredAudit.filter((eventType) => present.has(eventType)).length;
    process.stdout.write(
      `PHASE9_AUDIT_METRICS ${JSON.stringify({ required: requiredAudit.length, present: completeness, completeness: completeness / requiredAudit.length })}\n`,
    );
    expect(completeness).toBe(requiredAudit.length);
  });

  it("confirms an unexpired PendingAction through a recreated lifecycle service", async () => {
    const firstRepository = new PostgresPendingActionRepository(database.pool);
    const first = createPhase7Harness({ withEvents: false });
    const created = await first.service.create(first.command());
    await firstRepository.create({
      action: Object.freeze({
        ...created.action,
        expiresAt: toUtcTimestamp(Date.now() + 60_000),
      }),
      originalContext: first.command().contextSnapshot,
      tokenHash: confirmationHash(created.trustedChallenge.confirmationToken),
      confirmationId: null,
      authorization: null,
    });
    const restarted = createPhase7Harness({
      withEvents: false,
      repository: new PostgresPendingActionRepository(database.pool),
    });
    const confirmed = await restarted.service.confirm({
      actionId: created.action.actionId,
      confirmationToken: created.trustedChallenge.confirmationToken,
      sessionId: created.action.sessionId,
      userId: created.action.userId,
    });
    expect(confirmed.action.state).toBe("READY_FOR_EXECUTION");
    expect(confirmed.authorization?.actionId).toBe(created.action.actionId);
  });

  it("atomically accepts confirmation and recovers a crash boundary as REPLAN_REQUIRED", async () => {
    const repository = new PostgresPendingActionRepository(database.pool);
    const first = createPhase7Harness({ withEvents: false });
    const command = first.command();
    const created = await first.service.create(command);
    await repository.create({
      action: Object.freeze({
        ...created.action,
        expiresAt: toUtcTimestamp(Date.now() + 60_000),
      }),
      originalContext: command.contextSnapshot,
      tokenHash: confirmationHash(created.trustedChallenge.confirmationToken),
      confirmationId: null,
      authorization: null,
    });
    const accepted = await repository.acceptConfirmation(
      created.action.actionId,
      "confirmation:crash-boundary",
      created.action.updatedAt,
    );
    expect(accepted).toMatchObject({
      action: { state: "CONFIRMED" },
      tokenHash: null,
      confirmationId: "confirmation:crash-boundary",
    });
    const restarted = createPhase7Harness({
      withEvents: false,
      repository: new PostgresPendingActionRepository(database.pool),
    });
    const recovered = await restarted.service.confirm({
      actionId: created.action.actionId,
      confirmationToken: created.trustedChallenge.confirmationToken,
      sessionId: created.action.sessionId,
      userId: created.action.userId,
    });
    expect(recovered).toMatchObject({
      action: { state: "REPLAN_REQUIRED" },
      authorization: null,
      revalidation: { status: "REPLAN_REQUIRED" },
    });
  });

  it("commits EXPIRED before an expired confirmation error and preserves it after restart", async () => {
    const repository = new PostgresPendingActionRepository(database.pool);
    const first = createPhase7Harness({
      withEvents: false,
      repository,
      confirmationTtlMs: 1,
    });
    first.clock.valueMs = Date.now() + 24 * 60 * 60 * 1_000;
    const databaseCreationWindow = Date.now();
    const created = await first.service.create(first.command());
    expect(Date.parse(created.action.expiresAt)).toBeLessThan(databaseCreationWindow + 5_000);
    await delay(10);
    const restarted = createPhase7Harness({
      withEvents: false,
      repository: new PostgresPendingActionRepository(database.pool),
    });
    await expect(
      restarted.service.confirm({
        actionId: created.action.actionId,
        confirmationToken: created.trustedChallenge.confirmationToken,
        sessionId: created.action.sessionId,
        userId: created.action.userId,
      }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_EXPIRED" });
    await expect(
      new PostgresPendingActionRepository(database.pool).get(created.action.actionId),
    ).resolves.toMatchObject({ action: { state: "EXPIRED" } });
    const audit = await new PostgresAuditRepository(database.db).list({
      actionId: created.action.actionId,
    });
    expect(audit.map((event) => event.eventType)).toContain("confirmation.rejected");
  });

  it("rolls back duplicate pending actions and audits terminal and replan transitions", async () => {
    const harness = createPhase7Harness({ withEvents: false });
    const makeRecord = async () => {
      const command = harness.command();
      const created = await harness.service.create(command);
      return {
        record: {
          action: created.action,
          originalContext: command.contextSnapshot,
          tokenHash: "a".repeat(64),
          confirmationId: null,
          authorization: null,
        },
        at: toUtcTimestamp(Date.parse(BASE_TIME) + 10),
      };
    };
    const repository = new PostgresPendingActionRepository(database.pool);
    await expect(repository.get("action:missing")).resolves.toBeUndefined();
    for (const terminal of ["REJECTED", "CANCELLED", "EXPIRED"] as const) {
      const fixture = await makeRecord();
      await repository.create(fixture.record);
      await expect(repository.create(fixture.record)).rejects.toMatchObject({
        code: "INVALID_COMMAND",
      });
      await repository.transition(fixture.record.action.actionId, terminal, fixture.at);
    }
    const replan = await makeRecord();
    await repository.create(replan.record);
    await repository.transition(replan.record.action.actionId, "CONFIRMED", replan.at);
    await repository.transition(
      replan.record.action.actionId,
      "REPLAN_REQUIRED",
      toUtcTimestamp(Date.parse(replan.at) + 1),
    );
    await expect(
      repository.transition("action:missing", "REJECTED", replan.at),
    ).rejects.toMatchObject({ code: "ACTION_NOT_FOUND" });
    const eventTypes = (await new PostgresAuditRepository(database.db).list({})).map(
      (event) => event.eventType,
    );
    expect(eventTypes.filter((event) => event === "confirmation.rejected")).toHaveLength(3);
    expect(eventTypes).toContain("context.revalidated");
  });

  it("rejects repository-level authorization consumption at the database expiry boundary", async () => {
    const harness = createPhase7Harness({ withEvents: false });
    const command = harness.command();
    const created = await harness.service.create(command);
    const confirmed = await harness.service.confirm({
      actionId: created.action.actionId,
      confirmationToken: created.trustedChallenge.confirmationToken,
      sessionId: created.action.sessionId,
      userId: created.action.userId,
    });
    const repository = new PostgresPendingActionRepository(database.pool);
    await repository.create({
      action: Object.freeze({
        ...created.action,
        expiresAt: toUtcTimestamp(Date.now() + 60_000),
      }),
      originalContext: command.contextSnapshot,
      tokenHash: "c".repeat(64),
      confirmationId: null,
      authorization: null,
    });
    await repository.acceptConfirmation(
      created.action.actionId,
      "confirmation:expiry",
      confirmed.action.updatedAt,
    );
    const issuedAt = toUtcTimestamp(Date.now());
    await expect(
      repository.authorize(
        created.action.actionId,
        Object.freeze({
          ...confirmed.authorization!,
          issuedAt,
          expiresAt: issuedAt,
        }),
        issuedAt,
      ),
    ).rejects.toMatchObject({ code: "INVALID_COMMAND" });
    await repository.authorize(
      created.action.actionId,
      Object.freeze({
        ...confirmed.authorization!,
        issuedAt,
        expiresAt: toUtcTimestamp(Date.now() + 1),
      }),
      issuedAt,
    );
    await delay(10);
    await expect(
      repository.consumeAuthorization(created.action.actionId, confirmed.authorization!.expiresAt),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_EXPIRED" });
  });

  it("enforces append-only audit records at the database boundary", async () => {
    const repository = new PostgresAuditRepository(database.db);
    await repository.append(
      createAuditEvent({
        userId: "user:audit",
        vehicleId: "vehicle:audit",
        auditId: "audit:append-only",
        eventType: "policy.decision",
        timestamp: toUtcTimestamp(Date.parse(BASE_TIME)),
        runId: "run:audit",
        sessionId: "session:audit",
        traceId: "trace:audit",
        safeMetadata: { decision: "ALLOW" },
      }),
    );
    await expect(
      database.pool.query("update audit_events set event_type='tampered' where audit_id=$1", [
        "audit:append-only",
      ]),
    ).rejects.toThrow(/append-only/u);
    await expect(
      database.pool.query("delete from audit_events where audit_id=$1", ["audit:append-only"]),
    ).rejects.toThrow(/append-only/u);
    await expect(database.pool.query("truncate table audit_events")).rejects.toThrow(
      /append-only/u,
    );
  });

  it("queries PostgreSQL audit rows with optional action, execution, and tool mappings", async () => {
    const repository = new PostgresAuditRepository(database.db);
    const base = {
      timestamp: toUtcTimestamp(Date.parse(BASE_TIME)),
      runId: "run:audit-query",
      sessionId: "session:audit-query",
      traceId: "trace:audit-query",
      userId: "user:audit-query",
      vehicleId: "vehicle:audit-query",
      safeMetadata: { nested: ["safe"] },
    };
    await repository.append(
      createAuditEvent({ ...base, auditId: "audit:none", eventType: "test.none" }),
    );
    await repository.append(
      createAuditEvent({
        ...base,
        auditId: "audit:full",
        eventType: "test.full",
        actionId: "action:audit-query",
        executionId: "execution:audit-query",
        toolName: "get_vehicle_state",
        userId: "user:audit-query",
        vehicleId: "vehicle:audit-query",
      }),
    );
    await expect(repository.list({})).resolves.toHaveLength(2);
    await expect(repository.list({ actionId: "action:audit-query" })).resolves.toMatchObject([
      {
        auditId: "audit:full",
        actionId: "action:audit-query",
        executionId: "execution:audit-query",
        toolName: "get_vehicle_state",
        userId: "user:audit-query",
        vehicleId: "vehicle:audit-query",
      },
    ]);
    await expect(repository.list({ executionId: "execution:audit-query" })).resolves.toHaveLength(
      1,
    );
    await expect(
      repository.list({ actionId: "action:other", executionId: "execution:audit-query" }),
    ).resolves.toEqual([]);
  });

  it("uses real Redis TTLs and PostgreSQL fallback without weakening session single-use", async () => {
    const client = redis as unknown as RedisCommands;
    const cache = new RedisConversationCache(client, 5_000);
    await cache.set("session:redis", []);
    expect(await redis.pTTL(sessionKey("session:redis"))).toBeGreaterThan(0);
    expect(await redis.pTTL(sessionKey("session:redis"))).toBeLessThanOrEqual(5_000);

    const lock = new RedisSessionCoordinator(client, 5_000);
    await expect(lock.acquire("session:redis", "run:redis:1")).resolves.toBe(true);
    expect(await redis.pTTL(sessionLockKey("session:redis"))).toBeGreaterThan(0);
    await expect(lock.acquire("session:redis", "run:redis:2")).resolves.toBe(false);
    await lock.release("session:redis", "run:redis:1");

    const idempotency = new RedisIdempotencyCoordinator(client, 5_000);
    await expect(idempotency.acquire("idem:redis", "execution:redis:1")).resolves.toBe(true);
    expect(await redis.pTTL("driveguard:idempotency:idem:redis")).toBeGreaterThan(0);
    await idempotency.release("idem:redis", "execution:redis:1");

    const fallback = new FallbackSessionCoordinator(
      {
        leaseDurationMs: 5_000,
        acquire: () => Promise.reject(new Error("redis down")),
        renew: () => Promise.reject(new Error("redis down")),
        release: () => Promise.reject(new Error("redis down")),
      },
      new PostgresSessionCoordinator(database.db, 5_000),
    );
    await expect(fallback.acquire("session:pg-fallback", "run:fallback:1")).resolves.toBe(true);
    await expect(fallback.acquire("session:pg-fallback", "run:fallback:2")).resolves.toBe(false);
    await fallback.release("session:pg-fallback", "run:fallback:1");
    await expect(fallback.acquire("session:pg-fallback", "run:fallback:2")).resolves.toBe(true);

    const durable = new PostgresSessionCoordinator(database.db, 200);
    const normal = new FallbackSessionCoordinator(
      new RedisSessionCoordinator(client, 200),
      durable,
    );
    await expect(normal.acquire("session:split-brain", "run:owner")).resolves.toBe(true);
    const outage = new FallbackSessionCoordinator(
      {
        leaseDurationMs: 200,
        acquire: () => Promise.reject(new Error("partitioned redis")),
        renew: () => Promise.reject(new Error("partitioned redis")),
        release: () => Promise.reject(new Error("partitioned redis")),
      },
      durable,
    );
    await expect(outage.acquire("session:split-brain", "run:contender")).resolves.toBe(false);
    await delay(100);
    await expect(normal.renew("session:split-brain", "run:owner")).resolves.toBe(true);
    await delay(100);
    await expect(outage.acquire("session:split-brain", "run:contender")).resolves.toBe(false);
    await normal.release("session:split-brain", "run:owner");
  });

  it("keeps durable idempotency across coordinator recreation with one side effect", async () => {
    const input = request(1);
    let sideEffects = 0;
    const first = new PostgresDurableExecutionCoordinator(database.pool);
    const result = await first.execute(input, "binding:1", () => {
      sideEffects += 1;
      return Promise.resolve(ownerOutcome(input));
    });
    expect(result.status).toBe("SUCCEEDED");
    const restarted = new PostgresDurableExecutionCoordinator(database.pool);
    const replay = { ...input, executionId: "execution:phase9:replay" };
    const duplicate = await restarted.execute(replay, "binding:1", () => {
      sideEffects += 1;
      return Promise.resolve(ownerOutcome(replay));
    });
    expect(duplicate).toMatchObject({ status: "SUCCEEDED", deduplicated: true });
    expect(sideEffects).toBe(1);
    await expect(
      new PostgresExecutionRepository(database.pool).get(input.executionId),
    ).resolves.toMatchObject({
      state: "SUCCEEDED",
      attempts: [{ attempt: 1 }],
    });
    await expect(
      new PostgresExecutionRepository(database.pool).getResult(input.executionId),
    ).resolves.toMatchObject({ status: "SUCCEEDED" });
    await expect(
      new PostgresExecutionRepository(database.pool).get("execution:missing"),
    ).resolves.toBeUndefined();
    await expect(
      new PostgresExecutionRepository(database.pool).getResult("execution:missing"),
    ).resolves.toBeUndefined();
    await expect(
      new PostgresIdempotencyRepository(database.pool).get("idem:missing"),
    ).resolves.toBeUndefined();
    await expect(
      new PostgresIdempotencyRepository(database.pool).get(input.idempotencyKey),
    ).resolves.toMatchObject({
      status: "COMPLETED",
      executionId: input.executionId,
    });
    const audit = await new PostgresAuditRepository(database.db).list({
      executionId: input.executionId,
    });
    expect(audit.map((event) => event.eventType)).toContain("idempotency.deduplicated");
    await expect(
      new PostgresAuditRepository(database.db).list({ executionId: replay.executionId }),
    ).resolves.toEqual([]);
  });

  it("deduplicates local in-flight work and rejects changed local bindings", async () => {
    const input = request(20);
    let resolveOwner: ((value: ReturnType<typeof ownerOutcome>) => void) | undefined;
    let sideEffects = 0;
    const coordinator = new PostgresDurableExecutionCoordinator(database.pool);
    const first = coordinator.execute(input, "binding:local", () => {
      sideEffects += 1;
      return new Promise((resolve) => {
        resolveOwner = resolve;
      });
    });
    for (let attempt = 0; attempt < 20 && resolveOwner === undefined; attempt += 1) await delay(5);
    const duplicate = coordinator.execute(input, "binding:local", () =>
      Promise.resolve(ownerOutcome(input)),
    );
    const changed = await coordinator.execute(input, "binding:changed", () =>
      Promise.resolve(ownerOutcome(input)),
    );
    expect(changed).toMatchObject({ status: "REJECTED", error: { code: "IDEMPOTENCY_CONFLICT" } });
    resolveOwner?.(ownerOutcome(input));
    await expect(first).resolves.toMatchObject({ status: "SUCCEEDED", deduplicated: false });
    await expect(duplicate).resolves.toMatchObject({ status: "SUCCEEDED", deduplicated: true });
    expect(sideEffects).toBe(1);
  });

  it("persists owner failures and retry attempts with final audit events", async () => {
    const failedInput = request(21);
    const coordinator = new PostgresDurableExecutionCoordinator(database.pool);
    await expect(
      coordinator.execute(failedInput, "binding:failure", () =>
        Promise.reject(new Error("unsafe detail")),
      ),
    ).resolves.toMatchObject({
      status: "FAILED",
      error: { code: "INTERNAL_EXECUTION_ERROR" },
    });
    const retryInput = request(22);
    const outcome = ownerOutcome(retryInput);
    const secondAttempt = Object.freeze({
      attempt: 2,
      startedAt: toUtcTimestamp(Date.parse(BASE_TIME) + 3),
      completedAt: toUtcTimestamp(Date.parse(BASE_TIME) + 4),
      outcome: "SUCCEEDED" as const,
    });
    const retryResult = Object.freeze({ ...outcome.result, attemptCount: 2 });
    const retryRecord = Object.freeze({
      ...outcome.record,
      attempts: Object.freeze([...outcome.record.attempts, secondAttempt]),
    });
    await expect(
      coordinator.execute(retryInput, "binding:retry", () =>
        Promise.resolve({ result: retryResult, record: retryRecord }),
      ),
    ).resolves.toMatchObject({ status: "SUCCEEDED", attemptCount: 2 });
    const audit = await new PostgresAuditRepository(database.db).list({
      executionId: retryInput.executionId,
    });
    expect(audit.map((event) => event.eventType)).toContain("execution.retry");
    const failedAudit = await new PostgresAuditRepository(database.db).list({
      executionId: failedInput.executionId,
    });
    expect(failedAudit.map((event) => event.eventType)).toContain("execution.failed");
    expect(() => new PostgresDurableExecutionCoordinator(database.pool, 0)).toThrow(/lease/u);
  });

  it("rolls back failed acquisition and failed finalization transactions", async () => {
    const invalid = request(26, { sessionId: null as unknown as string });
    let sideEffects = 0;
    await expect(
      new PostgresDurableExecutionCoordinator(database.pool).execute(
        invalid,
        "binding:invalid",
        () => {
          sideEffects += 1;
          return Promise.resolve(ownerOutcome(invalid));
        },
      ),
    ).rejects.toBeDefined();
    expect(sideEffects).toBe(0);
    await expect(
      new PostgresExecutionRepository(database.pool).get(invalid.executionId),
    ).resolves.toBeUndefined();

    const invalidFinal = request(27);
    const outcome = ownerOutcome(invalidFinal);
    const invalidAttempt = Object.freeze({
      ...outcome.record.attempts[0]!,
      attempt: 0,
    });
    await expect(
      new PostgresDurableExecutionCoordinator(database.pool).execute(
        invalidFinal,
        "binding:invalid-final",
        () =>
          Promise.resolve({
            result: outcome.result,
            record: Object.freeze({
              ...outcome.record,
              attempts: Object.freeze([invalidAttempt]),
            }),
          }),
      ),
    ).rejects.toBeDefined();
    await expect(
      new PostgresExecutionRepository(database.pool).get(invalidFinal.executionId),
    ).resolves.toMatchObject({ state: "RUNNING" });
  });

  it("returns the durable final result when the COMMIT acknowledgement is lost", async () => {
    const input = request(90);
    let commits = 0;
    const pool = {
      query: database.pool.query.bind(database.pool),
      connect: async () => {
        const client = await database.pool.connect();
        return {
          query: async (statement: string, values?: unknown[]) => {
            const result = await client.query(statement, values);
            if (statement === "commit" && (commits += 1) === 2) {
              throw new Error("commit acknowledgement lost");
            }
            return result;
          },
          release: client.release.bind(client),
        };
      },
    } as unknown as Pool;
    let sideEffects = 0;
    await expect(
      new PostgresDurableExecutionCoordinator(pool).execute(input, "binding:commit-ack", () => {
        sideEffects += 1;
        return Promise.resolve(ownerOutcome(input));
      }),
    ).resolves.toMatchObject({ status: "SUCCEEDED" });
    expect(sideEffects).toBe(1);
    await expect(
      new PostgresExecutionRepository(database.pool).getResult(input.executionId),
    ).resolves.toMatchObject({ status: "SUCCEEDED" });
  });

  it("fails finalization if durable idempotency ownership changes", async () => {
    const input = request(28);
    let resolveOwner: ((value: ReturnType<typeof ownerOutcome>) => void) | undefined;
    const execution = new PostgresDurableExecutionCoordinator(database.pool).execute(
      input,
      "binding:lost-owner",
      () =>
        new Promise((resolve) => {
          resolveOwner = resolve;
        }),
    );
    for (let attempt = 0; attempt < 20 && resolveOwner === undefined; attempt += 1) await delay(5);
    await database.pool.query(
      "update idempotency_records set status='OUTCOME_UNKNOWN' where idempotency_key=$1",
      [input.idempotencyKey],
    );
    resolveOwner?.(ownerOutcome(input));
    await expect(execution).rejects.toThrow(/Idempotency finalization lost ownership/u);
    await expect(
      new PostgresExecutionRepository(database.pool).get(input.executionId),
    ).resolves.toMatchObject({ state: "RUNNING" });
  });

  it("persists an owner-reported OUTCOME_UNKNOWN without retry", async () => {
    const input = request(29);
    const outcome = ownerOutcome(input);
    const result: ExecutionResult = Object.freeze({
      ...outcome.result,
      status: "OUTCOME_UNKNOWN",
      error: {
        code: "OUTCOME_UNKNOWN",
        message: "Execution outcome could not be confirmed",
        retryable: false,
      },
    });
    const record: ExecutionRecord = Object.freeze({ ...outcome.record, state: "OUTCOME_UNKNOWN" });
    await expect(
      new PostgresDurableExecutionCoordinator(database.pool).execute(
        input,
        "binding:owner-unknown",
        () => Promise.resolve({ result, record }),
      ),
    ).resolves.toMatchObject({ status: "OUTCOME_UNKNOWN" });
    await expect(
      new PostgresIdempotencyRepository(database.pool).get(input.idempotencyKey),
    ).resolves.toMatchObject({ status: "OUTCOME_UNKNOWN" });
  });

  it("returns OUTCOME_UNKNOWN for a still-active owner without invoking a second owner", async () => {
    const input = request(23);
    let sideEffects = 0;
    const first = new PostgresDurableExecutionCoordinator(database.pool, 5_000);
    void first.execute(input, "binding:active", () => {
      sideEffects += 1;
      return new Promise<never>(() => undefined);
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (
        (await new PostgresIdempotencyRepository(database.pool).get(input.idempotencyKey)) !==
        undefined
      )
        break;
      await delay(5);
    }
    const second = new PostgresDurableExecutionCoordinator(database.pool, 5_000);
    await expect(
      second.execute(input, "binding:active", () => {
        sideEffects += 1;
        return Promise.resolve(ownerOutcome(input));
      }),
    ).resolves.toMatchObject({ status: "OUTCOME_UNKNOWN", deduplicated: true });
    expect(sideEffects).toBe(1);
  });

  it("renews a live execution lease so a slow successful owner is not terminalized unknown", async () => {
    const input = request(31);
    let sideEffects = 0;
    const first = new PostgresDurableExecutionCoordinator(database.pool, 400);
    const owner = first.execute(input, "binding:heartbeat", async () => {
      sideEffects += 1;
      await delay(700);
      return ownerOutcome(input);
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (
        (await new PostgresIdempotencyRepository(database.pool).get(input.idempotencyKey)) !==
        undefined
      )
        break;
      await delay(2);
    }
    await delay(500);
    const duplicate = await new PostgresDurableExecutionCoordinator(database.pool, 400).execute(
      { ...input, executionId: "execution:phase9:heartbeat-replay" },
      "binding:heartbeat",
      () => {
        sideEffects += 1;
        return Promise.resolve(ownerOutcome(input));
      },
    );
    expect(duplicate).toMatchObject({ status: "OUTCOME_UNKNOWN", deduplicated: true });
    await expect(owner).resolves.toMatchObject({ status: "SUCCEEDED" });
    expect(sideEffects).toBe(1);
    await expect(
      new PostgresExecutionRepository(database.pool).get(input.executionId),
    ).resolves.toMatchObject({ state: "SUCCEEDED" });
  });

  it("fences a live owner as OUTCOME_UNKNOWN when execution lease renewal is lost", async () => {
    const input = request(35);
    let ownerStarted = false;
    const execution = new PostgresDurableExecutionCoordinator(database.pool, 120).execute(
      input,
      "binding:heartbeat-lost",
      async () => {
        ownerStarted = true;
        await delay(300);
        return ownerOutcome(input);
      },
    );
    for (let attempt = 0; attempt < 20 && !ownerStarted; attempt += 1) await delay(5);
    await database.pool.query(
      `update idempotency_records set owner_expires_at=clock_timestamp() - interval '1 second'
       where idempotency_key=$1`,
      [input.idempotencyKey],
    );
    await expect(execution).resolves.toMatchObject({
      status: "OUTCOME_UNKNOWN",
      error: { code: "OUTCOME_UNKNOWN" },
    });
    await expect(
      new PostgresExecutionRepository(database.pool).get(input.executionId),
    ).resolves.toMatchObject({ state: "OUTCOME_UNKNOWN" });
  });

  it("rejects execution-ID reuse even when the idempotency key changes", async () => {
    const original = request(24);
    const coordinator = new PostgresDurableExecutionCoordinator(database.pool);
    await coordinator.execute(original, "binding:execution-id", () =>
      Promise.resolve(ownerOutcome(original)),
    );
    const reused = request(25, { executionId: original.executionId });
    await expect(
      coordinator.execute(reused, "binding:new", () => Promise.resolve(ownerOutcome(reused))),
    ).resolves.toMatchObject({
      status: "REJECTED",
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });
  });

  it("rejects same idempotency key with changed fingerprint before a second side effect", async () => {
    const original = request(2);
    let sideEffects = 0;
    const coordinator = new PostgresDurableExecutionCoordinator(database.pool);
    await coordinator.execute(original, "binding:2", () => {
      sideEffects += 1;
      return Promise.resolve(ownerOutcome(original));
    });
    const conflict = request(3, {
      idempotencyKey: original.idempotencyKey,
      actionFingerprint: "f".repeat(64),
    });
    const result = await coordinator.execute(conflict, "binding:2", () => {
      sideEffects += 1;
      return Promise.resolve(ownerOutcome(conflict));
    });
    expect(result).toMatchObject({ status: "REJECTED", error: { code: "IDEMPOTENCY_CONFLICT" } });
    expect(sideEffects).toBe(1);
  });

  it("marks an expired in-flight owner OUTCOME_UNKNOWN after restart and never retries it", async () => {
    const input = request(4);
    let sideEffects = 1;
    const startedAt = new Date(Date.now() - 1_000);
    const running = Object.freeze({
      ...ownerOutcome(input).record,
      state: "RUNNING" as const,
      attempts: Object.freeze([]),
      createdAt: startedAt.toISOString(),
      updatedAt: startedAt.toISOString(),
    });
    await database.pool.query(
      `insert into agent_sessions (session_id,user_id,vehicle_id,created_at,updated_at)
       values ($1,$2,$3,$4,$4)`,
      [input.sessionId, input.userId, input.vehicleId, startedAt],
    );
    await database.pool.query(
      `insert into execution_records
        (execution_id,run_id,session_id,trace_id,tool_name,state,request,record,created_at,started_at,updated_at)
       values ($1,$2,$3,$4,$5,'RUNNING',$6::jsonb,$7::jsonb,$8,$8,$8)`,
      [
        input.executionId,
        input.runId,
        input.sessionId,
        input.traceId,
        input.toolName,
        JSON.stringify(input),
        JSON.stringify(running),
        startedAt,
      ],
    );
    await database.pool.query(
      `insert into idempotency_records
        (idempotency_key,fingerprint,request_binding,execution_id,status,owner_expires_at,created_at,updated_at)
       values ($1,$2,$3,$4,'IN_PROGRESS',$5,$6,$6)`,
      [
        input.idempotencyKey,
        input.actionFingerprint,
        "binding:crash",
        input.executionId,
        new Date(Date.now() - 100),
        startedAt,
      ],
    );
    await new PostgresExecutionAttemptEventSink(database.pool).emit({
      eventType: "execution.attempt.started",
      executionId: input.executionId,
      runId: input.runId,
      sessionId: input.sessionId,
      traceId: input.traceId,
      toolName: input.toolName,
      attempt: 1,
      timestamp: startedAt.toISOString() as ExecutionResult["startedAt"],
    });
    const restarted = new PostgresDurableExecutionCoordinator(database.pool, 10);
    const recovered = await restarted.execute(input, "binding:crash", () => {
      sideEffects += 1;
      return Promise.resolve(ownerOutcome(input));
    });
    expect(recovered).toMatchObject({
      status: "OUTCOME_UNKNOWN",
      deduplicated: true,
      attemptCount: 1,
    });
    expect(sideEffects).toBe(1);
    await expect(
      new PostgresExecutionRepository(database.pool).get(input.executionId),
    ).resolves.toMatchObject({
      state: "OUTCOME_UNKNOWN",
      attempts: [{ attempt: 1, outcome: "OUTCOME_UNKNOWN" }],
    });
  });

  it("fails closed when PostgreSQL is unavailable before owner side effects", async () => {
    const unavailable = new Pool({
      connectionString: "postgresql://driveguard:unused@127.0.0.1:1/driveguard",
      connectionTimeoutMillis: 50,
    });
    let sideEffects = 0;
    const input = request(5);
    await expect(
      new PostgresDurableExecutionCoordinator(unavailable).execute(
        input,
        "binding:unavailable",
        () => {
          sideEffects += 1;
          return Promise.resolve(ownerOutcome(input));
        },
      ),
    ).rejects.toBeDefined();
    expect(sideEffects).toBe(0);
    await unavailable.end();
  });

  it("bounds hanging Redis idempotency hints and enforces the production session fence", async () => {
    const input = request(32);
    let sideEffects = 0;
    const never = new Promise<boolean>(() => undefined);
    const hangingAcquire = new PostgresDurableExecutionCoordinator(
      database.pool,
      1_000,
      {
        acquire: () => never,
        release: () => Promise.resolve(),
      },
      { coordinationTimeoutMs: 20 },
    );
    const started = Date.now();
    await expect(
      hangingAcquire.execute(input, "binding:hanging-acquire", () => {
        sideEffects += 1;
        return Promise.resolve(ownerOutcome(input));
      }),
    ).resolves.toMatchObject({ status: "SUCCEEDED" });
    expect(Date.now() - started).toBeLessThan(250);

    const releaseInput = request(33);
    const hangingRelease = new PostgresDurableExecutionCoordinator(
      database.pool,
      1_000,
      {
        acquire: () => Promise.resolve(true),
        release: () => new Promise<void>(() => undefined),
      },
      { coordinationTimeoutMs: 20 },
    );
    await expect(
      hangingRelease.execute(releaseInput, "binding:hanging-release", () => {
        sideEffects += 1;
        return Promise.resolve(ownerOutcome(releaseInput));
      }),
    ).resolves.toMatchObject({ status: "SUCCEEDED" });

    const fencedInput = request(34);
    const fenced = new PostgresDurableExecutionCoordinator(database.pool, 1_000, undefined, {
      requireSessionLease: true,
    });
    await expect(
      fenced.execute(fencedInput, "binding:fenced", () => {
        sideEffects += 1;
        return Promise.resolve(ownerOutcome(fencedInput));
      }),
    ).rejects.toThrow(/session lease/u);
    expect(sideEffects).toBe(2);
    expect(
      () =>
        new PostgresDurableExecutionCoordinator(database.pool, 1_000, undefined, {
          coordinationTimeoutMs: 0,
        }),
    ).toThrow(/coordination timeout/u);
  });

  it("cannot commit a successful execution after a successor owns the session", async () => {
    const input = request(36);
    const sessions = new PostgresSessionCoordinator(database.db, 1_000);
    await expect(sessions.acquire(input.sessionId, input.runId)).resolves.toBe(true);
    let ownerStarted = false;
    const execution = new PostgresDurableExecutionCoordinator(database.pool, 1_000, undefined, {
      requireSessionLease: true,
    }).execute(input, "binding:session-successor", async () => {
      ownerStarted = true;
      await delay(200);
      return ownerOutcome(input);
    });
    for (let attempt = 0; attempt < 20 && !ownerStarted; attempt += 1) await delay(5);
    await sessions.release(input.sessionId, input.runId);
    await expect(sessions.acquire(input.sessionId, "run:successor")).resolves.toBe(true);
    await expect(execution).resolves.toMatchObject({
      status: "OUTCOME_UNKNOWN",
      error: { code: "OUTCOME_UNKNOWN" },
    });
    await sessions.release(input.sessionId, "run:successor");
  });

  it("serializes durable acquisition for parallel tools in the same leased run", async () => {
    const sessionId = "session:phase9:parallel-tools";
    const runId = "run:phase9:parallel-tools";
    const sessions = new PostgresSessionCoordinator(database.db, 5_000);
    await expect(sessions.acquire(sessionId, runId)).resolves.toBe(true);

    const vehicle = request(37, { sessionId, runId });
    const trip = request(38, {
      sessionId,
      runId,
      toolName: "get_trip_state",
      policyDecision: policyDecision("get_trip_state", "R0"),
    });
    const coordinator = new PostgresDurableExecutionCoordinator(database.pool, 1_000, undefined, {
      requireSessionLease: true,
    });

    await expect(
      Promise.all([
        coordinator.execute(vehicle, "binding:parallel-vehicle", async () => {
          await delay(25);
          return ownerOutcome(vehicle);
        }),
        coordinator.execute(trip, "binding:parallel-trip", async () => {
          await delay(25);
          return ownerOutcome(trip);
        }),
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ status: "SUCCEEDED" }),
      expect.objectContaining({ status: "SUCCEEDED" }),
    ]);

    const persisted = await database.pool.query<{ readonly count: string }>(
      `select count(*) as count from execution_records
       where session_id=$1 and run_id=$2 and state='SUCCEEDED'`,
      [sessionId, runId],
    );
    expect(persisted.rows[0]?.count).toBe("2");
    await sessions.release(sessionId, runId);
  });

  reliabilityMatrix(
    "runs 10,000 real persistence/concurrency cases with zero unsafe outcomes",
    async () => {
      const groupCount = 50;
      const duplicatesPerGroup = 100;
      let sideEffects = 0;
      const results = await Promise.all(
        Array.from({ length: groupCount }, async (_, group) => {
          const input = request(10_000 + group);
          const coordinator = new PostgresDurableExecutionCoordinator(database.pool);
          const primary = await coordinator.execute(input, `binding:matrix:${group}`, async () => {
            sideEffects += 1;
            await delay(5);
            return ownerOutcome(input);
          });
          const duplicates = Array.from({ length: duplicatesPerGroup - 2 }, (_, replay) => {
            const duplicateInput = {
              ...input,
              executionId: `execution:matrix-duplicate:${group}:${replay}`,
            };
            return new PostgresDurableExecutionCoordinator(database.pool).execute(
              duplicateInput,
              `binding:matrix:${group}`,
              () => {
                sideEffects += 1;
                return Promise.resolve(ownerOutcome(duplicateInput));
              },
            );
          });
          const conflictInput = {
            ...input,
            executionId: `execution:matrix-conflict:${group}`,
            actionFingerprint: "f".repeat(64),
          };
          const conflict = new PostgresDurableExecutionCoordinator(database.pool).execute(
            conflictInput,
            `binding:matrix:${group}`,
            () => {
              sideEffects += 1;
              return Promise.resolve(ownerOutcome(conflictInput));
            },
          );
          const replayResults = await Promise.all([...duplicates, conflict]);
          return [primary, ...replayResults];
        }),
      );
      const flat = results.flat();

      const authorizationTemplate = createPhase7Harness({ withEvents: false });
      const templateCommand = authorizationTemplate.command();
      const templateCreated = await authorizationTemplate.service.create(templateCommand);
      const templateConfirmed = await authorizationTemplate.service.confirm({
        actionId: templateCreated.action.actionId,
        confirmationToken: templateCreated.trustedChallenge.confirmationToken,
        sessionId: templateCreated.action.sessionId,
        userId: templateCreated.action.userId,
      });
      const authorizationOutcomes = await Promise.all(
        Array.from({ length: groupCount }, async (_, group) => {
          const actionId = `action:matrix:${group}`;
          const repository = new PostgresPendingActionRepository(database.pool);
          const action = Object.freeze({
            ...templateCreated.action,
            actionId,
            runId: `run:authorization-matrix:${group}`,
            traceId: `trace:authorization-matrix:${group}`,
            expiresAt: toUtcTimestamp(Date.now() + 300_000),
          });
          await repository.create({
            action,
            originalContext: templateCommand.contextSnapshot,
            tokenHash: "b".repeat(64),
            confirmationId: null,
            authorization: null,
          });
          const transitionedAt = toUtcTimestamp(Date.parse(BASE_TIME) + group + 1);
          await repository.acceptConfirmation(
            actionId,
            `confirmation:matrix:${group}`,
            transitionedAt,
          );
          const authorizationIssuedAt = toUtcTimestamp(Date.now());
          await repository.authorize(
            actionId,
            Object.freeze({
              ...templateConfirmed.authorization!,
              authorizationId: `authorization:matrix:${group}`,
              actionId,
              confirmationId: `confirmation:matrix:${group}`,
              issuedAt: authorizationIssuedAt,
              expiresAt: toUtcTimestamp(Date.now() + 300_000),
            }),
            authorizationIssuedAt,
          );
          return Promise.allSettled(
            Array.from({ length: duplicatesPerGroup }, () =>
              new PostgresPendingActionRepository(database.pool).consumeAuthorization(
                actionId,
                authorizationIssuedAt,
              ),
            ),
          );
        }),
      );
      const duplicateSideEffect = sideEffects - groupCount;
      const authorizationFulfilled = authorizationOutcomes
        .flat()
        .filter((outcome) => outcome.status === "fulfilled").length;
      const authorizationReplaySuccess = authorizationFulfilled - groupCount;
      const idempotencyConflictBypass = flat.filter(
        (result) =>
          result.executionId.startsWith("execution:matrix-conflict:") &&
          (result.error?.code !== "IDEMPOTENCY_CONFLICT" || result.status !== "REJECTED"),
      ).length;
      const finalRecords = await database.pool.query<{ count: string }>(
        "select count(*) from execution_records where state='SUCCEEDED'",
      );
      const lostFinalExecutionRecord = groupCount - Number(finalRecords.rows[0]?.count ?? 0);
      const executionAuditMissingResult = await database.pool.query<{ count: string }>(
        `select count(*) from execution_records e
       where not exists (select 1 from audit_events a where a.execution_id=e.execution_id and a.event_type='execution.started')
          or not exists (select 1 from audit_events a where a.execution_id=e.execution_id and a.event_type='execution.succeeded')`,
      );
      const authorizationAuditMissingResult = await database.pool.query<{ count: string }>(
        `select count(*) from pending_actions p
       where not exists (select 1 from audit_events a where a.action_id=p.action_id and a.event_type='pending_action.created')
          or not exists (select 1 from audit_events a where a.action_id=p.action_id and a.event_type='confirmation.accepted')
          or not exists (select 1 from audit_events a where a.action_id=p.action_id and a.event_type='context.revalidated')
          or not exists (select 1 from audit_events a where a.action_id=p.action_id and a.event_type='authorization.issued')
          or not exists (select 1 from audit_events a where a.action_id=p.action_id and a.event_type='authorization.consumed')`,
      );
      const dedupAuditResult = await database.pool.query<{ count: string }>(
        "select count(*) from audit_events where event_type='idempotency.deduplicated'",
      );
      const expectedDedupAudit = groupCount * (duplicatesPerGroup - 2);
      const auditMissing =
        Number(executionAuditMissingResult.rows[0]?.count ?? 0) +
        Number(authorizationAuditMissingResult.rows[0]?.count ?? 0) +
        Math.max(0, expectedDedupAudit - Number(dedupAuditResult.rows[0]?.count ?? 0));
      const metrics = {
        cases: flat.length + authorizationOutcomes.flat().length,
        duplicateSideEffect,
        authorizationReplaySuccess,
        idempotencyConflictBypass,
        lostFinalExecutionRecord,
        auditMissing,
      };
      process.stdout.write(`PHASE9_RELIABILITY_METRICS ${JSON.stringify(metrics)}\n`);
      expect(metrics).toEqual({
        cases: 10_000,
        duplicateSideEffect: 0,
        authorizationReplaySuccess: 0,
        idempotencyConflictBypass: 0,
        lostFinalExecutionRecord: 0,
        auditMissing: 0,
      });
    },
    180_000,
  );

  it("renews the authoritative session lease during slow conversation restore", async () => {
    const bindings = createPhase9RuntimeBindings({
      postgres: { connectionString: DATABASE_URL },
      redis,
      sessionLeaseMs: 2_000,
      executionLeaseMs: 5_000,
    });
    const slowMemory: ConversationMemory = {
      restore: async (sessionId) => {
        await delay(3_000);
        return bindings.conversationMemory.restore(sessionId);
      },
      bindIdentity: (input) => bindings.conversationMemory.bindIdentity(input),
      appendTurn: (input) => bindings.conversationMemory.appendTurn(input),
    };
    const runtime = (name: string, conversationMemory: ConversationMemory) => {
      const faux = fauxProvider({ provider: name, api: `${name}-api` });
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([fauxAssistantMessage("lease-held")]);
      return createPhase9ProductionDriveGuardRuntime(
        {
          model: faux.getModel(),
          streamFn: models.streamSimple.bind(models),
          simulatorBaseUrl,
          capabilities: DEFAULT_PHASE_5_CAPABILITIES,
          serviceAvailability: DEFAULT_PHASE_5_SERVICES,
        },
        { ...bindings, conversationMemory },
      );
    };
    const owner = runtime("phase9-slow-restore-owner", slowMemory).run({
      sessionId: "session:slow-restore",
      prompt: "owner",
    });
    await delay(2_500);
    const contender = await runtime(
      "phase9-slow-restore-contender",
      bindings.conversationMemory,
    ).run({ sessionId: "session:slow-restore", prompt: "contender" });
    expect(contender).toMatchObject({ status: "failed", error: { code: "SESSION_BUSY" } });
    await expect(owner).resolves.toMatchObject({ status: "succeeded", response: "lease-held" });
    await bindings.close();
  });

  it("fails closed before Context/model work when the durable session lease is lost", async () => {
    const bindings = createPhase9RuntimeBindings({
      postgres: { connectionString: DATABASE_URL },
      redis,
      sessionLeaseMs: 1_000,
      executionLeaseMs: 5_000,
    });
    let appended = false;
    const slowMemory: ConversationMemory = {
      restore: async (sessionId) => {
        await delay(80);
        return bindings.conversationMemory.restore(sessionId);
      },
      bindIdentity: (input) => bindings.conversationMemory.bindIdentity(input),
      appendTurn: async (input) => {
        appended = true;
        return bindings.conversationMemory.appendTurn(input);
      },
    };
    const faux = fauxProvider({ provider: "phase9-lease-lost", api: "phase9-lease-lost-api" });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("must-not-run")]);
    const result = await createPhase9ProductionDriveGuardRuntime(
      {
        model: faux.getModel(),
        streamFn: models.streamSimple.bind(models),
        simulatorBaseUrl,
        capabilities: DEFAULT_PHASE_5_CAPABILITIES,
        serviceAvailability: DEFAULT_PHASE_5_SERVICES,
      },
      {
        ...bindings,
        conversationMemory: slowMemory,
        sessionCoordinator: {
          leaseDurationMs: 40,
          acquire: () => Promise.resolve(true),
          renew: () => Promise.resolve(false),
          release: () => Promise.resolve(),
        },
      },
    ).run({ sessionId: "session:lease-lost", prompt: "must fail closed" });
    expect(result).toMatchObject({ status: "failed", error: { code: "SESSION_BUSY" } });
    expect(result.context).toBeUndefined();
    expect(appended).toBe(false);
    await bindings.close();
  });

  it("does not let session release failure overwrite a durable R1 success", async () => {
    const bindings = createPhase9RuntimeBindings({
      postgres: { connectionString: DATABASE_URL },
      redis,
      sessionLeaseMs: 30_000,
      executionLeaseMs: 5_000,
    });
    await simulator.inject({
      method: "POST",
      url: "/simulator/reset",
      payload: { scenario: "active_navigation", seed: 31 },
    });
    const faux = fauxProvider({ provider: "phase9-r1-release", api: "phase9-r1-release-api" });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("set_media_volume", { volume: 42 }, { id: "phase9-r1-release-tool" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Volume updated."),
    ]);
    const durableSession = bindings.sessionCoordinator;
    const runtime = createPhase9ProductionDriveGuardRuntime(
      {
        model: faux.getModel(),
        streamFn: models.streamSimple.bind(models),
        simulatorBaseUrl,
        capabilities: DEFAULT_PHASE_5_CAPABILITIES,
        serviceAvailability: DEFAULT_PHASE_5_SERVICES,
        mode: "development",
        developmentExecutionOptIn: true,
      },
      {
        ...bindings,
        sessionCoordinator: {
          leaseDurationMs: durableSession.leaseDurationMs,
          acquire: (sessionId, ownerId) => durableSession.acquire(sessionId, ownerId),
          renew: (sessionId, ownerId) => durableSession.renew(sessionId, ownerId),
          release: async (sessionId, ownerId) => {
            await durableSession.release(sessionId, ownerId);
            throw new Error("injected release failure");
          },
        },
      },
    );
    await expect(
      runtime.run({ sessionId: "session:phase9-r1-release", prompt: "set volume" }),
    ).resolves.toMatchObject({ status: "succeeded", response: "Volume updated." });
    const state = await simulator.inject({ method: "GET", url: "/simulator/state" });
    expect(state.json<{ cabin: { mediaVolume: number } }>().cabin.mediaVolume).toBe(42);
    const audit = await new PostgresAuditRepository(database.db).list({});
    const succeeded = audit.find((event) => event.eventType === "execution.succeeded");
    expect(typeof succeeded?.userId).toBe("string");
    expect(typeof succeeded?.vehicleId).toBe("string");
    await bindings.close();
  });

  it("preserves a durable R1 success when the session lease is lost after commit", async () => {
    const bindings = createPhase9RuntimeBindings({
      postgres: { connectionString: DATABASE_URL },
      redis,
      sessionLeaseMs: 30_000,
      executionLeaseMs: 5_000,
    });
    await simulator.inject({
      method: "POST",
      url: "/simulator/reset",
      payload: { scenario: "active_navigation", seed: 32 },
    });
    const faux = fauxProvider({ provider: "phase9-r1-lease", api: "phase9-r1-lease-api" });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("set_media_volume", { volume: 97 }, { id: "phase9-r1-lease-tool" }),
        { stopReason: "toolUse" },
      ),
      async () => {
        await delay(120);
        return fauxAssistantMessage("Volume durably updated.");
      },
    ]);
    const durableSession = bindings.sessionCoordinator;
    const sessionId = "session:phase9-r1-post-commit-lease";
    const result = await createPhase9ProductionDriveGuardRuntime(
      {
        model: faux.getModel(),
        streamFn: models.streamSimple.bind(models),
        simulatorBaseUrl,
        capabilities: DEFAULT_PHASE_5_CAPABILITIES,
        serviceAvailability: DEFAULT_PHASE_5_SERVICES,
        mode: "development",
        developmentExecutionOptIn: true,
      },
      {
        ...bindings,
        sessionCoordinator: {
          leaseDurationMs: 40,
          acquire: (requestedSessionId, ownerId) =>
            durableSession.acquire(requestedSessionId, ownerId),
          renew: async () => {
            const state = await simulator.inject({ method: "GET", url: "/simulator/state" });
            if (state.json<{ cabin: { mediaVolume: number } }>().cabin.mediaVolume === 97) {
              return false;
            }
            return true;
          },
          release: (requestedSessionId, ownerId) =>
            durableSession.release(requestedSessionId, ownerId),
        },
      },
    ).run({ sessionId, prompt: "set volume" });
    expect(result).toMatchObject({ status: "succeeded", response: "Volume durably updated." });
    const state = await simulator.inject({ method: "GET", url: "/simulator/state" });
    expect(state.json<{ cabin: { mediaVolume: number } }>().cabin.mediaVolume).toBe(97);
    expect(
      await bindings.conversationMemory.restore(
        memoryIdentity(sessionId, "phase5-driver", "simulator-vehicle-001"),
      ),
    ).toEqual([]);
    const succeeded = (await new PostgresAuditRepository(database.db).list({})).filter(
      (event) => event.eventType === "execution.succeeded",
    );
    expect(succeeded).toHaveLength(1);
    await bindings.close();
  });

  it("fails before model use when a persisted session identity changes", async () => {
    const bindings = createPhase9RuntimeBindings({
      postgres: { connectionString: DATABASE_URL },
      redis,
      sessionLeaseMs: 30_000,
      executionLeaseMs: 5_000,
    });
    const sessionId = "session:phase9-identity-mismatch";
    await bindings.conversationMemory.bindIdentity({
      sessionId,
      userId: "user:other",
      vehicleId: "vehicle:other",
      updatedAt: toUtcTimestamp(Date.now()),
    });
    const faux = fauxProvider({ provider: "phase9-identity", api: "phase9-identity-api" });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("must not reach the model")]);
    const runtime = createPhase9ProductionDriveGuardRuntime(
      {
        model: faux.getModel(),
        streamFn: models.streamSimple.bind(models),
        simulatorBaseUrl,
        capabilities: DEFAULT_PHASE_5_CAPABILITIES,
        serviceAvailability: DEFAULT_PHASE_5_SERVICES,
      },
      bindings,
    );
    const result = await runtime.run({ sessionId, prompt: "private prior transcript?" });
    expect(result).toMatchObject({ status: "failed", error: { code: "INTERNAL_ERROR" } });
    expect(result.response).not.toContain("must not reach");
    await expect(
      bindings.conversationMemory.restore(memoryIdentity(sessionId, "user:other", "vehicle:other")),
    ).resolves.toEqual([]);
    await bindings.close();
  });

  it("executes an R2 confirmation through the fenced Phase 9 production composition", async () => {
    const bindings = createPhase9RuntimeBindings({
      postgres: { connectionString: DATABASE_URL },
      redis,
      sessionLeaseMs: 30_000,
      executionLeaseMs: 5_000,
    });
    await simulator.inject({
      method: "POST",
      url: "/simulator/reset",
      payload: { scenario: "active_navigation", seed: 19 },
    });
    const faux = fauxProvider({ provider: "phase9-r2-confirm", api: "phase9-r2-confirm-api" });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "reserve_charging_slot",
          { stationId: "station-pudong-001" },
          { id: "phase9-r2-tool" },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("I need your confirmation before proceeding."),
    ]);
    const runtime = createPhase9ProductionDriveGuardRuntime(
      {
        model: faux.getModel(),
        streamFn: models.streamSimple.bind(models),
        simulatorBaseUrl,
        capabilities: DEFAULT_PHASE_5_CAPABILITIES,
        serviceAvailability: DEFAULT_PHASE_5_SERVICES,
        mode: "development",
        developmentExecutionOptIn: true,
      },
      bindings,
    );
    const pending = await runtime.run({
      sessionId: "session:phase9-r2-confirm",
      prompt: "reserve charging",
    });
    expect(pending).toMatchObject({
      status: "failed",
      error: { code: "POLICY_CONFIRMATION_REQUIRED" },
    });
    const actionId = pending.confirmationRequired[0]?.actionId;
    expect(actionId).toBeDefined();
    const challenge = runtime.trustedConfirmationChallengeChannel.take(actionId ?? "missing");
    expect(challenge).toBeDefined();
    await expect(
      runtime.confirmAndExecute({
        actionId: actionId ?? "missing",
        confirmationToken: challenge?.confirmationToken ?? "missing",
        sessionId: challenge?.sessionId ?? "missing",
        userId: challenge?.userId ?? "missing",
      }),
    ).resolves.toMatchObject({ status: "SUCCEEDED", attemptCount: 1 });
    const state = await simulator.inject({ method: "GET", url: "/simulator/state" });
    expect(
      state.json<{ charging: { reservations: unknown[] } }>().charging.reservations,
    ).toHaveLength(1);
    await bindings.close();
  });

  it("resumes a READY action after the confirmation-to-execution crash boundary", async () => {
    const bindings = createPhase9RuntimeBindings({
      postgres: { connectionString: DATABASE_URL },
      redis,
      sessionLeaseMs: 30_000,
      executionLeaseMs: 5_000,
    });
    await simulator.inject({
      method: "POST",
      url: "/simulator/reset",
      payload: { scenario: "active_navigation", seed: 23 },
    });
    const faux = fauxProvider({ provider: "phase9-ready-recovery", api: "phase9-ready-api" });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "reserve_charging_slot",
          { stationId: "station-pudong-001" },
          { id: "phase9-ready-tool" },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("I need your confirmation before proceeding."),
    ]);
    const options = {
      model: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
      simulatorBaseUrl,
      capabilities: DEFAULT_PHASE_5_CAPABILITIES,
      serviceAvailability: DEFAULT_PHASE_5_SERVICES,
      mode: "development" as const,
      developmentExecutionOptIn: true,
    };
    const firstRuntime = createPhase9ProductionDriveGuardRuntime(options, bindings);
    const pending = await firstRuntime.run({
      sessionId: "session:phase9-ready-recovery",
      prompt: "reserve charging",
    });
    const actionId = pending.confirmationRequired[0]?.actionId ?? "missing";
    const challenge = firstRuntime.trustedConfirmationChallengeChannel.take(actionId);
    expect(challenge).toBeDefined();
    const command = {
      actionId,
      confirmationToken: challenge?.confirmationToken ?? "missing",
      sessionId: challenge?.sessionId ?? "missing",
      userId: challenge?.userId ?? "missing",
    };

    await expect(firstRuntime.confirmationService.confirm(command)).resolves.toMatchObject({
      action: { state: "READY_FOR_EXECUTION" },
      authorization: { actionId },
    });
    const restartedRuntime = createPhase9ProductionDriveGuardRuntime(options, bindings);
    await expect(restartedRuntime.confirmAndExecute(command)).resolves.toMatchObject({
      status: "SUCCEEDED",
      attemptCount: 1,
    });
    await expect(restartedRuntime.confirmAndExecute(command)).resolves.toMatchObject({
      status: "SUCCEEDED",
      deduplicated: true,
    });
    const state = await simulator.inject({ method: "GET", url: "/simulator/state" });
    expect(
      state.json<{ charging: { reservations: unknown[] } }>().charging.reservations,
    ).toHaveLength(1);
    await bindings.close();
  });

  it("restores conversation but reloads Simulator world state after runtime restart (SOC 70 -> 20)", async () => {
    const bindings = createPhase9RuntimeBindings({
      postgres: { connectionString: DATABASE_URL },
      redis,
      sessionLeaseMs: 30_000,
      executionLeaseMs: 5_000,
    });
    const memory = bindings.conversationMemory;
    const reset = await simulator.inject({
      method: "POST",
      url: "/simulator/reset",
      payload: { scenario: "active_navigation", seed: 9 },
    });
    expect(reset.statusCode).toBe(200);
    expect(
      (
        await simulator.inject({
          method: "POST",
          url: "/simulator/vehicle/soc",
          payload: { soc: 70 },
        })
      ).statusCode,
    ).toBe(200);

    const createRuntime = (responses: FauxResponseStep[]) => {
      providerSequence += 1;
      const faux = fauxProvider({
        provider: `phase9-faux-${providerSequence}`,
        api: `phase9-faux-api-${providerSequence}`,
      });
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses(responses);
      return createPhase9ProductionDriveGuardRuntime(
        {
          model: faux.getModel(),
          streamFn: models.streamSimple.bind(models),
          simulatorBaseUrl,
          capabilities: DEFAULT_PHASE_5_CAPABILITIES,
          serviceAvailability: DEFAULT_PHASE_5_SERVICES,
        },
        bindings,
      );
    };
    const toolStep = (id: string) =>
      fauxAssistantMessage(fauxToolCall("get_vehicle_state", {}, { id }), {
        stopReason: "toolUse",
      });
    const finalStep =
      (prefix: string): FauxResponseStep =>
      (context) =>
        fauxAssistantMessage(
          `${prefix}:${JSON.stringify(context.messages.findLast((message) => message.role === "toolResult")?.details)}`,
        );

    const firstRuntime = createRuntime([toolStep("phase9-soc-70"), finalStep("turn-1")]);
    const first = await firstRuntime.run({ sessionId: "session:soc-restart", prompt: "SOC?" });
    expect(first.response).toContain('"soc":70');
    expect(
      (
        await simulator.inject({
          method: "POST",
          url: "/simulator/vehicle/soc",
          payload: { soc: 20 },
        })
      ).statusCode,
    ).toBe(200);
    const restartedRuntime = createRuntime([toolStep("phase9-soc-20"), finalStep("turn-2")]);
    const second = await restartedRuntime.run({
      sessionId: "session:soc-restart",
      prompt: "SOC now?",
    });
    expect(second.response).toContain('"soc":20');
    expect(second.response).not.toContain('"soc":70');
    expect(
      (
        await memory.restore(
          memoryIdentity("session:soc-restart", "phase5-driver", "simulator-vehicle-001"),
        )
      ).map((message) => message.role),
    ).toEqual(["user", "assistant", "user", "assistant"]);
    await expect(
      database.pool.query<{ count: string }>(
        "select count(*) from execution_attempts where completed_at is not null",
      ),
    ).resolves.toMatchObject({ rows: [{ count: "2" }] });
    await bindings.close();
  });
});
