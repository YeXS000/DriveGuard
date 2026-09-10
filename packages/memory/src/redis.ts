import type {
  ConversationCache,
  ConversationMessage,
  IdempotencyCoordinator,
  SessionCoordinator,
} from "./types.js";

export const REDIS_NAMESPACE = "driveguard";
export const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1_000;
export const DEFAULT_LOCK_TTL_MS = 2 * 60 * 1_000;

export interface RedisCommands {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options: { readonly PX: number; readonly NX?: boolean },
  ): Promise<string | null>;
  del(key: string): Promise<number>;
  eval(
    script: string,
    options: { readonly keys: string[]; readonly arguments: string[] },
  ): Promise<unknown>;
}

function positiveTtl(ttlMs: number): number {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error("Redis TTL must be positive");
  return ttlMs;
}

async function bestEffortWithin<T>(operation: Promise<T>, ttlMs: number): Promise<T | undefined> {
  const timeoutMs = Math.max(1, Math.min(1_000, Math.floor(ttlMs / 4)));
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

function safeKeyPart(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
    throw new Error("Redis key identifier is invalid");
  }
  return value;
}

export function sessionKey(sessionId: string): string {
  return `${REDIS_NAMESPACE}:session:${safeKeyPart(sessionId)}`;
}

export function sessionLockKey(sessionId: string): string {
  return `${REDIS_NAMESPACE}:lock:${safeKeyPart(sessionId)}`;
}

export function idempotencyKey(key: string): string {
  return `${REDIS_NAMESPACE}:idempotency:${safeKeyPart(key)}`;
}

export class RedisConversationCache implements ConversationCache {
  readonly #client: RedisCommands;
  readonly #ttlMs: number;

  constructor(client: RedisCommands, ttlMs = DEFAULT_SESSION_TTL_MS) {
    this.#client = client;
    this.#ttlMs = positiveTtl(ttlMs);
  }

  async get(sessionId: string): Promise<readonly ConversationMessage[] | undefined> {
    const raw = await this.#client.get(sessionKey(sessionId));
    if (raw === null) return undefined;
    try {
      const value: unknown = JSON.parse(raw);
      if (!Array.isArray(value)) return undefined;
      if (!value.every((message) => isConversationMessage(message, sessionId))) return undefined;
      return Object.freeze(value.map((message) => Object.freeze(message)));
    } catch {
      return undefined;
    }
  }

  async set(sessionId: string, messages: readonly ConversationMessage[]): Promise<void> {
    await this.#client.set(sessionKey(sessionId), JSON.stringify(messages), { PX: this.#ttlMs });
  }

  async delete(sessionId: string): Promise<void> {
    await this.#client.del(sessionKey(sessionId));
  }
}

function isConversationMessage(value: unknown, sessionId: string): value is ConversationMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Readonly<Record<string, unknown>>;
  return (
    typeof message.messageId === "string" &&
    message.sessionId === sessionId &&
    (message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string" &&
    typeof message.createdAt === "string" &&
    Number.isFinite(Date.parse(message.createdAt)) &&
    Number.isSafeInteger(message.sequence) &&
    Number(message.sequence) >= 0
  );
}

const RELEASE_IF_OWNER = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0`;

export class RedisSessionCoordinator implements SessionCoordinator {
  readonly #client: RedisCommands;
  readonly #ttlMs: number;

  constructor(client: RedisCommands, ttlMs = DEFAULT_LOCK_TTL_MS) {
    this.#client = client;
    this.#ttlMs = positiveTtl(ttlMs);
  }

  get leaseDurationMs(): number {
    return this.#ttlMs;
  }

  async acquire(sessionId: string, ownerId: string): Promise<boolean> {
    const result = await this.#client.set(sessionLockKey(sessionId), safeKeyPart(ownerId), {
      PX: this.#ttlMs,
      NX: true,
    });
    return result === "OK";
  }

  async release(sessionId: string, ownerId: string): Promise<void> {
    await this.#client.eval(RELEASE_IF_OWNER, {
      keys: [sessionLockKey(sessionId)],
      arguments: [safeKeyPart(ownerId)],
    });
  }

  async renew(sessionId: string, ownerId: string): Promise<boolean> {
    const result = await this.#client.eval(
      `if redis.call("GET", KEYS[1]) == ARGV[1] then
         return redis.call("PEXPIRE", KEYS[1], ARGV[2])
       end
       return 0`,
      {
        keys: [sessionLockKey(sessionId)],
        arguments: [safeKeyPart(ownerId), String(this.#ttlMs)],
      },
    );
    return result === 1;
  }
}

/**
 * Redis lease used only to collapse duplicate work quickly. Callers must still
 * enforce the durable idempotency decision in PostgreSQL before side effects.
 */
export class RedisIdempotencyCoordinator implements IdempotencyCoordinator {
  readonly #client: RedisCommands;
  readonly #ttlMs: number;

  constructor(client: RedisCommands, ttlMs = DEFAULT_LOCK_TTL_MS) {
    this.#client = client;
    this.#ttlMs = positiveTtl(ttlMs);
  }

  async acquire(key: string, ownerId: string): Promise<boolean> {
    const result = await this.#client.set(idempotencyKey(key), safeKeyPart(ownerId), {
      PX: this.#ttlMs,
      NX: true,
    });
    return result === "OK";
  }

  async release(key: string, ownerId: string): Promise<void> {
    await this.#client.eval(RELEASE_IF_OWNER, {
      keys: [idempotencyKey(key)],
      arguments: [safeKeyPart(ownerId)],
    });
  }
}

export class FallbackSessionCoordinator implements SessionCoordinator {
  readonly #primary: SessionCoordinator;
  readonly #durableFallback: SessionCoordinator;

  constructor(primary: SessionCoordinator, durableFallback: SessionCoordinator) {
    this.#primary = primary;
    this.#durableFallback = durableFallback;
  }

  get leaseDurationMs(): number {
    return this.#durableFallback.leaseDurationMs;
  }

  async acquire(sessionId: string, ownerId: string): Promise<boolean> {
    const acquired = await this.#durableFallback.acquire(sessionId, ownerId);
    if (!acquired) return false;
    try {
      await bestEffortWithin(
        this.#primary.acquire(sessionId, ownerId),
        this.#durableFallback.leaseDurationMs,
      );
    } catch {
      // PostgreSQL is authoritative; Redis is only a fast coordination hint.
    }
    return true;
  }

  async renew(sessionId: string, ownerId: string): Promise<boolean> {
    const renewed = await this.#durableFallback.renew(sessionId, ownerId);
    if (!renewed) return false;
    try {
      await bestEffortWithin(
        this.#primary.renew(sessionId, ownerId),
        this.#durableFallback.leaseDurationMs,
      );
    } catch {
      // The durable lease remains authoritative.
    }
    return true;
  }

  async release(sessionId: string, ownerId: string): Promise<void> {
    try {
      await bestEffortWithin(
        this.#primary.release(sessionId, ownerId),
        this.#durableFallback.leaseDurationMs,
      );
    } catch {
      // Redis leases expire; PostgreSQL release remains authoritative.
    }
    await this.#durableFallback.release(sessionId, ownerId);
  }
}
