import { readFile } from "node:fs/promises";

import {
  FallbackSessionCoordinator,
  InMemoryConversationRepository,
  InMemorySessionCoordinator,
  InMemorySessionRepository,
  RedisConversationCache,
  RedisIdempotencyCoordinator,
  RedisSessionCoordinator,
  RepositoryConversationMemory,
  sanitizeConversationContent,
  idempotencyKey,
  sessionKey,
  sessionLockKey,
  type RedisCommands,
  type SessionCoordinator,
} from "@driveguard/memory";
import {
  AUDIT_EVENT_TYPES,
  InMemoryAuthorizationRepository,
  InMemoryAuditRepository,
  InMemoryExecutionRepository,
  InMemoryIdempotencyRepository,
  PostgresExecutionAttemptEventSink,
  PostgresPendingActionRepository,
  agentSessions,
  auditEvents,
  conversationMessages,
  configureRuntimeDatabaseRole,
  createAuditEvent,
  createPhase9RuntimeBindings,
  executionAttempts,
  executionAuthorizations,
  executionRecords,
  idempotencyRecords,
  pendingActions,
} from "@driveguard/persistence";
import { toUtcTimestamp } from "@driveguard/domain";
import {
  assertPendingActionRecordIntegrity,
  transitionPendingAction,
  type ExecutionAuthorization,
} from "@driveguard/action-lifecycle";
import type { ExecutionRecord, ExecutionResult } from "@driveguard/executor";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import { createPhase7Harness } from "../fixtures/phase7-lifecycle.js";

const NOW = toUtcTimestamp(Date.parse("2026-08-29T12:00:00.000Z"));
const AUDIT_SUBJECT = { userId: "user:audit", vehicleId: "vehicle:audit" } as const;

function memoryIdentity(sessionId: string) {
  return {
    sessionId,
    userId: "user:memory-test",
    vehicleId: "vehicle:memory-test",
    updatedAt: NOW,
  } as const;
}

class FakeRedis implements RedisCommands {
  readonly values = new Map<string, string>();
  readonly ttls = new Map<string, number>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }

  set(
    key: string,
    value: string,
    options: { readonly PX: number; readonly NX?: boolean },
  ): Promise<string | null> {
    if (options.NX === true && this.values.has(key)) return Promise.resolve(null);
    this.values.set(key, value);
    this.ttls.set(key, options.PX);
    return Promise.resolve("OK");
  }

  del(key: string): Promise<number> {
    return Promise.resolve(this.values.delete(key) ? 1 : 0);
  }

  eval(
    _script: string,
    options: { readonly keys: string[]; readonly arguments: string[] },
  ): Promise<unknown> {
    const key = options.keys[0];
    const owner = options.arguments[0];
    if (key !== undefined && owner !== undefined && this.values.get(key) === owner) {
      if (_script.includes("PEXPIRE")) {
        this.ttls.set(key, Number(options.arguments[1]));
        return Promise.resolve(1);
      }
      this.values.delete(key);
      return Promise.resolve(1);
    }
    return Promise.resolve(0);
  }
}

describe("Phase 9 in-memory repository and conversation semantics", () => {
  it("binds a durable session to one user and vehicle identity", async () => {
    const sessions = new InMemorySessionRepository();
    const memory = new RepositoryConversationMemory({
      sessions,
      conversation: new InMemoryConversationRepository(),
    });
    const identity = {
      sessionId: "session:identity",
      userId: "user:identity",
      vehicleId: "vehicle:identity",
      updatedAt: NOW,
    };
    await expect(memory.bindIdentity(identity)).resolves.toBeUndefined();
    await expect(memory.bindIdentity(identity)).resolves.toBeUndefined();
    await expect(memory.bindIdentity({ ...identity, userId: "user:other" })).rejects.toThrow(
      /identity mismatch/u,
    );
    await expect(sessions.get(identity.sessionId)).resolves.toMatchObject(identity);
  });

  it("rejects transcript restore before reading when the requested identity mismatches", async () => {
    const sessions = new InMemorySessionRepository();
    await sessions.bindIdentity({
      sessionId: "session:private",
      userId: "user:owner",
      vehicleId: "vehicle:owner",
      updatedAt: NOW,
    });
    const list = vi.fn(() => Promise.resolve([]));
    const memory = new RepositoryConversationMemory({
      sessions,
      conversation: { list, appendTurn: vi.fn() },
    });
    await expect(
      memory.restore({
        sessionId: "session:private",
        userId: "user:other",
        vehicleId: "vehicle:owner",
        updatedAt: NOW,
      }),
    ).rejects.toThrow(/identity mismatch/u);
    expect(list).not.toHaveBeenCalled();
  });

  it("returns empty state, preserves session creation time, and isolates returned values", async () => {
    const sessions = new InMemorySessionRepository();
    const conversation = new InMemoryConversationRepository();
    await expect(sessions.get("session:missing")).resolves.toBeUndefined();
    await expect(conversation.list("session:missing")).resolves.toEqual([]);
    const created = await sessions.upsert({
      sessionId: "session:stable",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const later = toUtcTimestamp(Date.parse(NOW) + 100);
    const updated = await sessions.upsert({
      sessionId: "session:stable",
      createdAt: later,
      updatedAt: later,
    });
    expect(updated).toMatchObject({ createdAt: created.createdAt, updatedAt: later });
    await sessions.bindIdentity({
      sessionId: "session:stable",
      userId: "user:stable",
      vehicleId: "vehicle:stable",
      updatedAt: later,
    });
    await expect(
      sessions.upsert({
        sessionId: "session:stable",
        userId: "user:stable",
        vehicleId: "vehicle:other",
        createdAt: later,
        updatedAt: later,
      }),
    ).rejects.toThrow(/identity mismatch/u);
  });

  it("restores a committed conversation with stable sequence after recreating memory", async () => {
    const sessions = new InMemorySessionRepository();
    const conversation = new InMemoryConversationRepository();
    const first = new RepositoryConversationMemory({ sessions, conversation });
    await first.appendTurn({
      sessionId: "session:memory",
      userMessageId: "message:user:1",
      userContent: "SOC was 70",
      assistantMessageId: "message:assistant:1",
      assistantContent: "Recorded conversation only",
      createdAt: NOW,
    });
    const restored = await new RepositoryConversationMemory({ sessions, conversation }).restore(
      memoryIdentity("session:memory"),
    );
    expect(restored.map(({ role, content, sequence }) => ({ role, content, sequence }))).toEqual([
      { role: "user", content: "SOC was 70", sequence: 0 },
      { role: "assistant", content: "Recorded conversation only", sequence: 1 },
    ]);
  });

  it("assigns gap-free unique sequences under concurrent turn appends", async () => {
    const sessions = new InMemorySessionRepository();
    const conversation = new InMemoryConversationRepository();
    const memory = new RepositoryConversationMemory({ sessions, conversation });
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        memory.appendTurn({
          sessionId: "session:concurrent",
          userMessageId: `message:user:${index}`,
          userContent: `user-${index}`,
          assistantMessageId: `message:assistant:${index}`,
          assistantContent: `assistant-${index}`,
          createdAt: NOW,
        }),
      ),
    );
    const messages = await memory.restore(memoryIdentity("session:concurrent"));
    expect(messages).toHaveLength(200);
    expect(messages.map((message) => message.sequence)).toEqual(
      Array.from({ length: 200 }, (_, index) => index),
    );
  });

  it("keeps failed cache reads and writes availability-only", async () => {
    const sessions = new InMemorySessionRepository();
    const conversation = new InMemoryConversationRepository();
    const memory = new RepositoryConversationMemory({
      sessions,
      conversation,
      cache: {
        get: () => Promise.reject(new Error("redis down")),
        set: () => Promise.reject(new Error("redis down")),
        delete: () => Promise.reject(new Error("redis down")),
      },
    });
    await expect(
      memory.appendTurn({
        sessionId: "session:fallback",
        userMessageId: "message:user:fallback",
        userContent: "hello",
        assistantMessageId: "message:assistant:fallback",
        assistantContent: "world",
        createdAt: NOW,
      }),
    ).resolves.toHaveLength(2);
    await expect(memory.restore(memoryIdentity("session:fallback"))).resolves.toHaveLength(2);
  });

  it("uses cache hits, generated message IDs, and tolerates cache invalidation failure", async () => {
    const sessions = new InMemorySessionRepository();
    const conversation = new InMemoryConversationRepository();
    const cached = Object.freeze([]);
    const cache = {
      get: vi.fn(() => Promise.resolve(cached)),
      set: vi.fn(() => Promise.resolve()),
      delete: vi.fn(() => Promise.reject(new Error("redis down"))),
    };
    const memory = new RepositoryConversationMemory({ sessions, conversation, cache });
    await expect(memory.restore(memoryIdentity("session:cached"))).resolves.toBe(cached);
    expect(cache.set).not.toHaveBeenCalled();
    const appended = await memory.appendTurn({
      sessionId: "session:generated",
      userMessageId: "",
      userContent: "hello",
      assistantMessageId: "",
      assistantContent: "world",
      createdAt: NOW,
    });
    expect(appended[0].messageId).toMatch(/^message:/u);
    expect(appended[1].messageId).toMatch(/^message:/u);
  });

  it("never lets a stale cache hide the durable conversation", async () => {
    const sessions = new InMemorySessionRepository();
    const conversation = new InMemoryConversationRepository();
    const cache = {
      get: vi.fn(() =>
        Promise.resolve([
          {
            messageId: "message:stale",
            sessionId: "session:stale",
            role: "assistant" as const,
            content: "stale",
            createdAt: NOW,
            sequence: 0,
          },
        ]),
      ),
      set: vi.fn(() => Promise.resolve()),
      delete: vi.fn(() => Promise.resolve()),
    };
    const memory = new RepositoryConversationMemory({ sessions, conversation, cache });
    await expect(memory.restore(memoryIdentity("session:stale"))).resolves.toEqual([]);
    expect(cache.set).toHaveBeenCalledWith("session:stale", []);
  });

  it("rejects role-flipped cache content and redacts every Authorization form", async () => {
    const sessions = new InMemorySessionRepository();
    const conversation = new InMemoryConversationRepository();
    const durable = new RepositoryConversationMemory({ sessions, conversation });
    await durable.appendTurn({
      sessionId: "session:role-flip",
      userMessageId: "message:role:user",
      userContent: "hello",
      assistantMessageId: "message:role:assistant",
      assistantContent: "world",
      createdAt: NOW,
    });
    const messages = await conversation.list("session:role-flip");
    const cache = {
      get: vi.fn(() =>
        Promise.resolve(
          messages.map((message) => ({
            ...message,
            role: message.role === "user" ? ("assistant" as const) : ("user" as const),
          })),
        ),
      ),
      set: vi.fn(() => Promise.resolve()),
      delete: vi.fn(() => Promise.resolve()),
    };
    const restored = await new RepositoryConversationMemory({
      sessions,
      conversation,
      cache,
    }).restore(memoryIdentity("session:role-flip"));
    expect(restored.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(cache.set).toHaveBeenCalledWith("session:role-flip", messages);
    expect(
      sanitizeConversationContent(
        "Authorization: Basic abc\nAuthorization=opaque\nAuthorization: Digest xyz\ncredential=alpha-sensitive\ncookie=beta-sensitive",
      ),
    ).not.toMatch(/abc|opaque|xyz|alpha-sensitive|beta-sensitive/u);
  });

  it("serializes overlapping in-memory conversation writes and releases failed queues", async () => {
    const conversation = new InMemoryConversationRepository();
    const session = { sessionId: "session:queue", createdAt: NOW, updatedAt: NOW };
    const turn = (suffix: string) =>
      conversation.appendTurn({
        session,
        user: {
          messageId: `u:${suffix}`,
          sessionId: session.sessionId,
          role: "user",
          content: suffix,
          createdAt: NOW,
        },
        assistant: {
          messageId: `a:${suffix}`,
          sessionId: session.sessionId,
          role: "assistant",
          content: suffix,
          createdAt: NOW,
        },
      });
    await Promise.all([turn("1"), turn("2")]);
    expect((await conversation.list(session.sessionId)).map((message) => message.sequence)).toEqual(
      [0, 1, 2, 3],
    );
  });
});

describe("Phase 9 Redis namespace, TTL, lock, and durable fallback", () => {
  it("constructs production bindings with the documented default lease durations", async () => {
    const bindings = createPhase9RuntimeBindings({
      postgres: { connectionString: "postgresql://unused:unused@127.0.0.1:1/unused" },
      redis: new FakeRedis(),
    });
    expect(bindings.sessionCoordinator.leaseDurationMs).toBe(120_000);
    await bindings.close();
  });

  it.each([
    [sessionKey("session:1"), "driveguard:session:session:1"],
    [sessionLockKey("session:1"), "driveguard:lock:session:1"],
    [idempotencyKey("idem:1"), "driveguard:idempotency:idem:1"],
  ])("uses the single DriveGuard namespace for %s", (actual, expected) => {
    expect(actual).toBe(expected);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid temporary-key TTL %s",
    (ttl) => {
      expect(() => new RedisConversationCache(new FakeRedis(), ttl)).toThrow(/TTL/u);
      expect(() => new RedisSessionCoordinator(new FakeRedis(), ttl)).toThrow(/TTL/u);
      expect(() => new RedisIdempotencyCoordinator(new FakeRedis(), ttl)).toThrow(/TTL/u);
    },
  );

  it("writes conversation cache with TTL and never without expiry", async () => {
    const redis = new FakeRedis();
    const cache = new RedisConversationCache(redis, 5_000);
    await cache.set("session:cache", [
      {
        messageId: "message:1",
        sessionId: "session:cache",
        role: "user",
        content: "hello",
        createdAt: NOW,
        sequence: 0,
      },
    ]);
    expect(redis.ttls.get(sessionKey("session:cache"))).toBe(5_000);
    await expect(cache.get("session:cache")).resolves.toMatchObject([{ content: "hello" }]);
    await cache.delete("session:cache");
    await expect(cache.get("session:cache")).resolves.toBeUndefined();
  });

  it.each(["", " leading", "slash/value", "x".repeat(257)])(
    "rejects invalid Redis key identifier %j",
    (value) => {
      expect(() => sessionKey(value)).toThrow(/identifier/u);
    },
  );

  it("treats missing, non-array, and malformed conversation cache values as misses", async () => {
    const redis = new FakeRedis();
    const cache = new RedisConversationCache(redis);
    await expect(cache.get("session:absent")).resolves.toBeUndefined();
    redis.values.set(sessionKey("session:object"), "{}");
    await expect(cache.get("session:object")).resolves.toBeUndefined();
    redis.values.set(sessionKey("session:malformed"), "{");
    await expect(cache.get("session:malformed")).resolves.toBeUndefined();
    redis.values.set(sessionKey("session:invalid-message"), '[{"role":"tool"}]');
    await expect(cache.get("session:invalid-message")).resolves.toBeUndefined();
  });

  it("uses SET NX PX and owner-checked release for session coordination", async () => {
    const redis = new FakeRedis();
    const coordinator = new RedisSessionCoordinator(redis, 2_000);
    await expect(coordinator.acquire("session:lock", "run:1")).resolves.toBe(true);
    await expect(coordinator.acquire("session:lock", "run:2")).resolves.toBe(false);
    await expect(coordinator.renew("session:lock", "run:2")).resolves.toBe(false);
    await expect(coordinator.renew("session:lock", "run:1")).resolves.toBe(true);
    await coordinator.release("session:lock", "run:2");
    await expect(coordinator.acquire("session:lock", "run:3")).resolves.toBe(false);
    await coordinator.release("session:lock", "run:1");
    await expect(coordinator.acquire("session:lock", "run:3")).resolves.toBe(true);
    expect(redis.ttls.get(sessionLockKey("session:lock"))).toBe(2_000);
  });

  it("does not release an in-memory lease owned by another run", async () => {
    const coordinator = new InMemorySessionCoordinator();
    await expect(coordinator.acquire("session:owner", "run:owner")).resolves.toBe(true);
    await coordinator.release("session:owner", "run:other");
    await expect(coordinator.renew("session:owner", "run:owner")).resolves.toBe(true);
  });

  it("uses a TTL-bound owner lease for Redis idempotency coordination", async () => {
    const redis = new FakeRedis();
    const coordinator = new RedisIdempotencyCoordinator(redis, 3_000);
    await expect(coordinator.acquire("idem:coordination", "run:1")).resolves.toBe(true);
    await expect(coordinator.acquire("idem:coordination", "run:2")).resolves.toBe(false);
    await coordinator.release("idem:coordination", "run:2");
    await expect(coordinator.acquire("idem:coordination", "run:3")).resolves.toBe(false);
    await coordinator.release("idem:coordination", "run:1");
    await expect(coordinator.acquire("idem:coordination", "run:3")).resolves.toBe(true);
    expect(redis.ttls.get(idempotencyKey("idem:coordination"))).toBe(3_000);
  });

  it("falls back only when Redis throws and releases through the same durable path", async () => {
    const fallback = new InMemorySessionCoordinator();
    const release = vi.spyOn(fallback, "release");
    const failing: SessionCoordinator = {
      leaseDurationMs: 2_000,
      acquire: () => Promise.reject(new Error("redis unavailable")),
      renew: () => Promise.reject(new Error("redis unavailable")),
      release: () => Promise.reject(new Error("redis unavailable")),
    };
    const coordinator = new FallbackSessionCoordinator(failing, fallback);
    await expect(coordinator.acquire("session:durable", "run:durable")).resolves.toBe(true);
    await coordinator.release("session:durable", "run:durable");
    expect(release).toHaveBeenCalledWith("session:durable", "run:durable");
  });

  it("keeps PostgreSQL-style durable coordination authoritative when Redis denies or fails", async () => {
    const durable = new InMemorySessionCoordinator();
    const durableAcquire = vi.spyOn(durable, "acquire");
    const coordinator = new FallbackSessionCoordinator(
      {
        leaseDurationMs: 2_000,
        acquire: () => Promise.resolve(false),
        renew: () => Promise.reject(new Error("redis disappeared")),
        release: () => Promise.reject(new Error("redis disappeared")),
      },
      durable,
    );
    await expect(coordinator.acquire("session:primary", "run:primary")).resolves.toBe(true);
    expect(durableAcquire).toHaveBeenCalled();
    await expect(coordinator.acquire("session:primary", "run:second")).resolves.toBe(false);
    await expect(coordinator.renew("session:primary", "run:primary")).resolves.toBe(true);
    await expect(coordinator.release("session:primary", "run:primary")).resolves.toBeUndefined();
  });

  it("does not let a hanging Redis hint outlive the authoritative lease budget", async () => {
    const durableCore = new InMemorySessionCoordinator();
    const durable: SessionCoordinator = {
      leaseDurationMs: 40,
      acquire: (sessionId, ownerId) => durableCore.acquire(sessionId, ownerId),
      renew: (sessionId, ownerId) => durableCore.renew(sessionId, ownerId),
      release: (sessionId, ownerId) => durableCore.release(sessionId, ownerId),
    };
    const never = new Promise<boolean>(() => undefined);
    const coordinator = new FallbackSessionCoordinator(
      {
        leaseDurationMs: 40,
        acquire: () => never,
        renew: () => never,
        release: () => new Promise<void>(() => undefined),
      },
      durable,
    );
    const started = Date.now();
    await expect(coordinator.acquire("session:hanging", "run:hanging")).resolves.toBe(true);
    expect(Date.now() - started).toBeLessThan(40);
    await expect(coordinator.acquire("session:hanging", "run:contender")).resolves.toBe(false);
  });

  it("does not let a hanging conversation cache block the durable repository", async () => {
    const sessions = new InMemorySessionRepository();
    const conversation = new InMemoryConversationRepository();
    const never = new Promise<never>(() => undefined);
    const memory = new RepositoryConversationMemory({
      sessions,
      conversation,
      cacheOperationTimeoutMs: 10,
      cache: {
        get: () => never,
        set: () => never,
        delete: () => never,
      },
    });
    const started = Date.now();
    await expect(memory.restore(memoryIdentity("session:cache-hang"))).resolves.toEqual([]);
    await expect(
      memory.appendTurn({
        sessionId: "session:cache-hang",
        userMessageId: "message:cache:user",
        userContent: "hello",
        assistantMessageId: "message:cache:assistant",
        assistantContent: "world",
        createdAt: NOW,
      }),
    ).resolves.toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(100);
    expect(
      () =>
        new RepositoryConversationMemory({
          sessions,
          conversation,
          cacheOperationTimeoutMs: 0,
        }),
    ).toThrow(/timeout/u);
  });
});

describe("Phase 9 durable execution-attempt evidence", () => {
  it("persists started, failed, succeeded, and unknown attempt outcomes", async () => {
    const query = vi.fn((sql: unknown, parameters?: unknown) => {
      void sql;
      void parameters;
      return Promise.resolve({ rowCount: 1 });
    });
    const sink = new PostgresExecutionAttemptEventSink({ query } as never);
    const event = {
      executionId: "execution:event-coverage",
      runId: "run:event-coverage",
      sessionId: "session:event-coverage",
      traceId: "trace:event-coverage",
      toolName: "reserve_charging_slot",
      attempt: 1,
      timestamp: NOW,
    } as const;

    await sink.emit({ ...event, attempt: 0, eventType: "execution.started" });
    expect(query).not.toHaveBeenCalled();
    await sink.emit({ ...event, eventType: "execution.attempt.started" });
    await sink.emit({
      ...event,
      eventType: "execution.attempt.failed",
      errorCode: "DEPENDENCY_TIMEOUT",
    });
    await sink.emit({ ...event, eventType: "execution.succeeded" });
    await sink.emit({ ...event, eventType: "execution.outcome_unknown" });
    await sink.emit({ ...event, eventType: "execution.retry.scheduled" });

    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls.map((call) => JSON.stringify(call[1]))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("STARTED"),
        expect.stringContaining("FAILED"),
        expect.stringContaining("SUCCEEDED"),
        expect.stringContaining("OUTCOME_UNKNOWN"),
      ]),
    );
  });
});

describe("Phase 9 PostgreSQL confirmation clock boundaries", () => {
  it("rolls back when authorization cannot atomically advance the pending row", async () => {
    const harness = createPhase7Harness({ withEvents: false });
    const command = harness.command();
    const created = await harness.service.create(command);
    const confirmed = await harness.service.confirm({
      actionId: created.action.actionId,
      confirmationToken: created.trustedChallenge.confirmationToken,
      sessionId: created.action.sessionId,
      userId: created.action.userId,
    });
    const confirmedAction = transitionPendingAction(
      created.action,
      "CONFIRMED",
      created.action.updatedAt,
    );
    const query = vi.fn((statement: string) => {
      if (statement.includes("select p.action"))
        return Promise.resolve({
          rowCount: 1,
          rows: [
            {
              action: confirmedAction,
              original_context: command.contextSnapshot,
              token_hash: null,
              confirmation_id: "confirmation:test",
              authorization: null,
              consumed_at: null,
            },
          ],
        });
      if (statement.includes("clock_timestamp() as now"))
        return Promise.resolve({ rowCount: 1, rows: [{ now: new Date(NOW) }] });
      if (statement.includes("update pending_actions set state='READY_FOR_EXECUTION'"))
        return Promise.resolve({ rowCount: 0, rows: [] });
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    const repository = new PostgresPendingActionRepository({
      connect: () => Promise.resolve({ query, release: vi.fn() }),
    } as never);
    await expect(
      repository.authorize(created.action.actionId, confirmed.authorization!, NOW),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    expect(query).toHaveBeenCalledWith("rollback");
  });

  it("rejects a PendingAction whose durable original Context was substituted", async () => {
    const harness = createPhase7Harness({ withEvents: false });
    const command = harness.command();
    const created = await harness.service.create(command);
    expect(() =>
      assertPendingActionRecordIntegrity({
        action: created.action,
        originalContext: {
          ...command.contextSnapshot,
          snapshotId: "snapshot:substituted" as typeof command.contextSnapshot.snapshotId,
        },
        tokenHash: "a".repeat(64),
        confirmationId: null,
        authorization: null,
      }),
    ).toThrow(/original Context integrity/u);
  });

  it.each([
    ["zero", (createdAt: string) => createdAt],
    ["invalid", () => "invalid-timestamp"],
  ])("rejects a %s repository confirmation TTL before insertion", async (_name, expiresAt) => {
    const harness = createPhase7Harness({ withEvents: false });
    const command = harness.command();
    const created = await harness.service.create(command);
    const query = vi.fn(() => Promise.resolve({ rowCount: 1, rows: [] }));
    const release = vi.fn();
    const repository = new PostgresPendingActionRepository({
      connect: () => Promise.resolve({ query, release }),
    } as never);
    await expect(
      repository.create({
        action: {
          ...created.action,
          expiresAt: expiresAt(created.action.createdAt) as typeof created.action.expiresAt,
        },
        originalContext: command.contextSnapshot,
        tokenHash: "a".repeat(64),
        confirmationId: null,
        authorization: null,
      }),
    ).rejects.toMatchObject({ code: "INVALID_COMMAND" });
    expect(query).toHaveBeenCalledWith("rollback");
    expect(release).toHaveBeenCalledOnce();
  });

  it("atomically expires when the confirmation update crosses the database deadline", async () => {
    const harness = createPhase7Harness({ withEvents: false });
    const command = harness.command();
    const created = await harness.service.create(command);
    const row = {
      action: created.action,
      original_context: command.contextSnapshot,
      token_hash: "b".repeat(64),
      confirmation_id: null,
      authorization: null,
      consumed_at: null,
    };
    let expiryCheck = 0;
    const query = vi.fn((sql: string) => {
      if (sql.includes("select p.action")) return Promise.resolve({ rowCount: 1, rows: [row] });
      if (sql.includes("expires_at <= clock_timestamp() as expired")) {
        expiryCheck += 1;
        return Promise.resolve({
          rowCount: 1,
          rows: [{ now: new Date(), expired: expiryCheck > 1 }],
        });
      }
      if (sql.includes("set state='CONFIRMED'")) {
        return Promise.resolve({ rowCount: 0, rows: [] });
      }
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    const repository = new PostgresPendingActionRepository({
      connect: () => Promise.resolve({ query, release: vi.fn() }),
    } as never);
    await expect(
      repository.acceptConfirmation(
        created.action.actionId,
        "confirmation:deadline-race",
        created.action.updatedAt,
      ),
    ).resolves.toMatchObject({ action: { state: "EXPIRED" } });
    expect(expiryCheck).toBe(2);
  });
});

describe("Phase 9 append-only audit and safe metadata", () => {
  it.each(AUDIT_EVENT_TYPES)("appends and queries required event type %s", async (eventType) => {
    const repository = new InMemoryAuditRepository();
    const event = createAuditEvent({
      ...AUDIT_SUBJECT,
      eventType,
      timestamp: NOW,
      runId: "run:audit",
      sessionId: "session:audit",
      traceId: "trace:audit",
      actionId: "action:audit",
      safeMetadata: { status: "safe" },
    });
    await repository.append(event);
    await expect(repository.list({ actionId: "action:audit" })).resolves.toEqual([event]);
  });

  it.each([
    "authorization",
    "confirmationToken",
    "apiKey",
    "accessToken",
    "refreshToken",
    "credential",
    "cookie",
    "password",
    "chainOfThought",
    "reasoning",
    "AuthorizationHeader",
  ])("rejects sensitive audit metadata key %s", (key) => {
    expect(() =>
      createAuditEvent({
        ...AUDIT_SUBJECT,
        eventType: "test",
        timestamp: NOW,
        runId: "run:audit",
        sessionId: "session:audit",
        traceId: "trace:audit",
        safeMetadata: { [key]: "must-not-persist" },
      }),
    ).toThrow(/sensitive/u);
  });

  it("requires safe user and vehicle subjects for every audit event", () => {
    expect(() =>
      createAuditEvent({
        ...AUDIT_SUBJECT,
        userId: "",
        eventType: "test",
        timestamp: NOW,
        runId: "run:audit",
        sessionId: "session:audit",
        traceId: "trace:audit",
        safeMetadata: {},
      }),
    ).toThrow(/userId and vehicleId/u);
  });

  it("rejects duplicate audit IDs rather than updating an existing event", async () => {
    const repository = new InMemoryAuditRepository();
    const event = createAuditEvent({
      ...AUDIT_SUBJECT,
      auditId: "audit:stable",
      eventType: "test",
      timestamp: NOW,
      runId: "run:audit",
      sessionId: "session:audit",
      traceId: "trace:audit",
      safeMetadata: {},
    });
    await repository.append(event);
    await expect(repository.append(event)).rejects.toThrow(/Duplicate/u);
  });

  it("accepts recursively JSON-safe metadata and rejects non-JSON values", () => {
    expect(() =>
      createAuditEvent({
        ...AUDIT_SUBJECT,
        eventType: "test",
        timestamp: NOW,
        runId: "run:audit",
        sessionId: "session:audit",
        traceId: "trace:audit",
        safeMetadata: { nested: [null, "safe", 1, true, { status: "ok" }] },
      }),
    ).not.toThrow();
    for (const value of [undefined, () => undefined, Symbol("unsafe")]) {
      expect(() =>
        createAuditEvent({
          ...AUDIT_SUBJECT,
          eventType: "test",
          timestamp: NOW,
          runId: "run:audit",
          sessionId: "session:audit",
          traceId: "trace:audit",
          safeMetadata: { value },
        }),
      ).toThrow(/JSON-safe/u);
    }
  });

  it.each([
    "Authorization: Bearer top-secret",
    "api_key=top-secret",
    "confirmation_token=top-secret",
    "access_token=top-secret",
    "refresh_token=top-secret",
    "cookie=top-secret",
    "internal reasoning=hidden",
  ])("rejects sensitive audit metadata value %s", (value) => {
    expect(() =>
      createAuditEvent({
        ...AUDIT_SUBJECT,
        eventType: "test",
        timestamp: NOW,
        runId: "run:audit",
        sessionId: "session:audit",
        traceId: "trace:audit",
        safeMetadata: { message: value },
      }),
    ).toThrow(/sensitive/u);
  });

  it("filters in-memory audit independently by action and execution", async () => {
    const repository = new InMemoryAuditRepository();
    const event = createAuditEvent({
      ...AUDIT_SUBJECT,
      eventType: "execution.succeeded",
      timestamp: NOW,
      runId: "run:audit",
      sessionId: "session:audit",
      traceId: "trace:audit",
      actionId: "action:filter",
      executionId: "execution:filter",
      toolName: "get_vehicle_state",
      safeMetadata: {},
    });
    await repository.append(event);
    await expect(repository.list({})).resolves.toHaveLength(1);
    await expect(repository.list({ actionId: "action:other" })).resolves.toEqual([]);
    await expect(repository.list({ executionId: "execution:filter" })).resolves.toHaveLength(1);
    await expect(
      repository.list({ actionId: "action:filter", executionId: "execution:other" }),
    ).resolves.toEqual([]);
  });
});

describe("Phase 9 execution repository test doubles", () => {
  const executionRecord: ExecutionRecord = Object.freeze({
    executionId: "execution:in-memory",
    toolName: "get_vehicle_state",
    actionFingerprint: "a".repeat(64),
    idempotencyKey: "idem:in-memory",
    state: "SUCCEEDED",
    attempts: Object.freeze([]),
    stateHistory: Object.freeze([
      Object.freeze({ from: null, to: "CREATED" as const, transitionedAt: NOW }),
    ]),
    createdAt: NOW,
    updatedAt: NOW,
  });
  const executionResult: ExecutionResult = Object.freeze({
    executionId: executionRecord.executionId,
    toolName: executionRecord.toolName,
    status: "SUCCEEDED",
    attemptCount: 1,
    deduplicated: false,
    startedAt: NOW,
    completedAt: NOW,
    result: { ok: true },
  });

  it("provides isolated in-memory execution and idempotency repository implementations", async () => {
    const executions = new InMemoryExecutionRepository([
      { record: executionRecord, result: executionResult },
    ]);
    await expect(executions.get(executionRecord.executionId)).resolves.toEqual(executionRecord);
    await expect(executions.getResult(executionRecord.executionId)).resolves.toEqual(
      executionResult,
    );
    await expect(executions.get("execution:missing")).resolves.toBeUndefined();
    await expect(executions.getResult("execution:missing")).resolves.toBeUndefined();
    executions.set({ ...executionRecord, executionId: "execution:no-result" });
    await expect(executions.getResult("execution:no-result")).resolves.toBeUndefined();
    await expect(new InMemoryExecutionRepository().get("execution:empty")).resolves.toBeUndefined();

    const ownerExpiresAt = new Date(Date.parse(NOW) + 1_000);
    const idempotency = new InMemoryIdempotencyRepository([
      {
        idempotencyKey: executionRecord.idempotencyKey,
        fingerprint: executionRecord.actionFingerprint,
        requestBinding: "binding:in-memory",
        executionId: executionRecord.executionId,
        status: "COMPLETED",
        result: executionResult,
        ownerExpiresAt,
      },
    ]);
    await expect(idempotency.get(executionRecord.idempotencyKey)).resolves.toMatchObject({
      executionId: executionRecord.executionId,
      ownerExpiresAt,
    });
    await expect(idempotency.get("idem:missing")).resolves.toBeUndefined();
    await expect(new InMemoryIdempotencyRepository().get("idem:empty")).resolves.toBeUndefined();
  });
});

describe("Phase 9 authorization repository contract", () => {
  const authorization: ExecutionAuthorization = Object.freeze({
    authorizationId: "authorization:memory",
    actionId: "action:memory",
    actionFingerprint: "a".repeat(64),
    toolName: "reserve_charging_slot",
    riskLevel: "R2",
    confirmationId: "confirmation:memory",
    policyRuleId: "phase9-r2",
    contextSnapshotId: "snapshot:memory",
    contextVersion: 1,
    issuedAt: NOW,
    expiresAt: toUtcTimestamp(Date.parse(NOW) + 60_000),
  });

  it("provides isolated in-memory lookup by authorization and action IDs", async () => {
    const repository = new InMemoryAuthorizationRepository();
    await expect(repository.getById("authorization:missing")).resolves.toBeUndefined();
    await expect(repository.getByActionId("action:missing")).resolves.toBeUndefined();
    repository.store({ authorization, consumedAt: null });
    await expect(repository.getById(authorization.authorizationId)).resolves.toEqual({
      authorization,
      consumedAt: null,
    });
    await expect(repository.getByActionId(authorization.actionId)).resolves.toEqual({
      authorization,
      consumedAt: null,
    });
  });
});

describe("Phase 9 Drizzle schema and migration contract", () => {
  it("provisions a least-privilege runtime role and revokes audit mutation", async () => {
    const query = vi.fn((statement: string) => {
      if (statement.includes("from pg_roles r")) return Promise.resolve({ rowCount: 0, rows: [] });
      if (statement.startsWith("select format"))
        return Promise.resolve({
          rowCount: 1,
          rows: [{ statement: "alter role driveguard_app with login password 'redacted'" }],
        });
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    await configureRuntimeDatabaseRole({ query } as never, "driveguard_app", "runtime-password");
    expect(query).toHaveBeenCalledWith(
      'create role "driveguard_app" login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls',
    );
    expect(query.mock.calls.map(([statement]) => statement).join("\n")).toContain(
      "revoke all privileges on audit_events",
    );
    expect(query.mock.calls.map(([statement]) => statement).join("\n")).toContain(
      "grant delete on execution_records",
    );
  });

  it("rejects unsafe runtime database role configuration", async () => {
    await expect(
      configureRuntimeDatabaseRole({} as never, "driveguard-app", "runtime-password"),
    ).rejects.toThrow(/POSTGRES_APP_USER/u);
    await expect(
      configureRuntimeDatabaseRole({} as never, "driveguard_app", "short"),
    ).rejects.toThrow(/too short/u);
  });

  it("updates an existing runtime role and fails if PostgreSQL cannot format its password", async () => {
    const existingQuery = vi.fn((statement: string) => {
      if (statement.includes("from pg_roles r"))
        return Promise.resolve({
          rowCount: 1,
          rows: [
            {
              isCurrentUser: false,
              hasRoleMembership: false,
              ownsPhase9Relation: false,
              ownsSecurityBoundary: false,
              rolbypassrls: false,
              rolcreatedb: false,
              rolcreaterole: false,
              rolreplication: false,
              rolsuper: false,
            },
          ],
        });
      if (statement.startsWith("select format"))
        return Promise.resolve({
          rowCount: 1,
          rows: [{ statement: "alter role driveguard_app with login password 'redacted'" }],
        });
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    await configureRuntimeDatabaseRole(
      { query: existingQuery } as never,
      "driveguard_app",
      "runtime-password",
    );
    expect(existingQuery).not.toHaveBeenCalledWith('create role "driveguard_app" login');

    const missingStatement = vi.fn((statement: string) =>
      Promise.resolve(
        statement.includes("from pg_roles r")
          ? {
              rowCount: 1,
              rows: [
                {
                  isCurrentUser: false,
                  hasRoleMembership: false,
                  ownsPhase9Relation: false,
                  ownsSecurityBoundary: false,
                  rolbypassrls: false,
                  rolcreatedb: false,
                  rolcreaterole: false,
                  rolreplication: false,
                  rolsuper: false,
                },
              ],
            }
          : { rowCount: 0, rows: [] },
      ),
    );
    await expect(
      configureRuntimeDatabaseRole(
        { query: missingStatement } as never,
        "driveguard_app",
        "runtime-password",
      ),
    ).rejects.toThrow(/password could not be set/u);
  });

  it.each([
    { isCurrentUser: true },
    { hasRoleMembership: true },
    { ownsPhase9Relation: true },
    { ownsSecurityBoundary: true },
    { rolsuper: true },
    { rolcreatedb: true },
    { rolcreaterole: true },
    { rolreplication: true },
    { rolbypassrls: true },
  ])("rejects an elevated or owner runtime role %#", async (override) => {
    const query = vi.fn(() =>
      Promise.resolve({
        rowCount: 1,
        rows: [
          {
            isCurrentUser: false,
            hasRoleMembership: false,
            ownsPhase9Relation: false,
            ownsSecurityBoundary: false,
            rolbypassrls: false,
            rolcreatedb: false,
            rolcreaterole: false,
            rolreplication: false,
            rolsuper: false,
            ...override,
          },
        ],
      }),
    );
    await expect(
      configureRuntimeDatabaseRole({ query } as never, "driveguard_app", "runtime-password"),
    ).rejects.toThrow(/unprivileged non-owner/u);
    expect(query).toHaveBeenCalledTimes(1);
  });

  const tables = [
    ["agent_sessions", agentSessions],
    ["conversation_messages", conversationMessages],
    ["pending_actions", pendingActions],
    ["execution_authorizations", executionAuthorizations],
    ["execution_records", executionRecords],
    ["execution_attempts", executionAttempts],
    ["idempotency_records", idempotencyRecords],
    ["audit_events", auditEvents],
  ] as const;

  it.each(tables)("declares required Drizzle table %s", (name, table) => {
    expect(Reflect.get(table, Symbol.for("drizzle:Name"))).toBe(name);
    const config = getTableConfig(table);
    expect(config.name).toBe(name);
    expect(config.columns.length).toBeGreaterThan(0);
    expect(config.indexes.length).toBeGreaterThan(0);
  });

  it("contains repeatable constraints, foreign keys, and append-only audit enforcement", async () => {
    const migration = await readFile("infra/db/migrations/0000_phase9_persistence.sql", "utf8");
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "pending_actions"');
    expect(migration).toContain('REFERENCES "pending_actions"');
    expect(migration).not.toContain("DROP TABLE");
    expect(migration).toContain("CREATE TRIGGER audit_events_append_only");
    expect(migration).toContain("CREATE TRIGGER audit_events_no_truncate");
    expect(migration).not.toMatch(/DEEPSEEK_API_KEY|confirmation plaintext|Authorization header/iu);
  });

  it("provides reverse-order rollback for all Phase 9 tables", async () => {
    const rollback = await readFile("infra/db/rollback/0000_phase9_persistence.down.sql", "utf8");
    for (const [name] of [...tables].reverse())
      expect(rollback).toContain(`DROP TABLE IF EXISTS ${name}`);
  });
});
