import { randomUUID } from "node:crypto";

import { toUtcTimestamp, timestampToEpochMs } from "@driveguard/domain";

import type {
  AgentSessionRecord,
  ConversationCache,
  ConversationMemory,
  ConversationMessage,
  ConversationRepository,
  SessionIdentityBinding,
  SessionRepository,
} from "./types.js";

const DEFAULT_CACHE_OPERATION_TIMEOUT_MS = 250;

async function cacheWithin<T>(operation: Promise<T>, timeoutMs: number): Promise<T | undefined> {
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

export function sanitizeConversationContent(value: string): string {
  return value
    .replace(/authorization\s*[:=]\s*[^\r\n]*/giu, "authorization=[REDACTED]")
    .replace(
      /(?:api[_-]?key|confirmation[_ -]?token|credential|cookie|token|secret|password)\s*[=:]\s*\S+/giu,
      "credential=[REDACTED]",
    )
    .replace(
      /(?:chain[_ -]?of[_ -]?thought|internal[_ -]?reasoning)\s*[=:]\s*[^\r\n]+/giu,
      "reasoning=[REDACTED]",
    );
}

export class RepositoryConversationMemory implements ConversationMemory {
  readonly #sessions: SessionRepository;
  readonly #conversation: ConversationRepository;
  readonly #cache: ConversationCache | undefined;
  readonly #cacheOperationTimeoutMs: number;

  constructor(options: {
    readonly sessions: SessionRepository;
    readonly conversation: ConversationRepository;
    readonly cache?: ConversationCache;
    readonly cacheOperationTimeoutMs?: number;
  }) {
    this.#sessions = options.sessions;
    this.#conversation = options.conversation;
    this.#cache = options.cache;
    this.#cacheOperationTimeoutMs =
      options.cacheOperationTimeoutMs ?? DEFAULT_CACHE_OPERATION_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#cacheOperationTimeoutMs) || this.#cacheOperationTimeoutMs < 1) {
      throw new Error("Conversation cache operation timeout is invalid");
    }
  }

  async restore(input: SessionIdentityBinding): Promise<readonly ConversationMessage[]> {
    await this.#sessions.bindIdentity(input);
    const { sessionId } = input;
    const messages = await this.#conversation.list(sessionId);
    try {
      const cached =
        this.#cache === undefined
          ? undefined
          : await cacheWithin(this.#cache.get(sessionId), this.#cacheOperationTimeoutMs);
      if (cached !== undefined && sameConversation(cached, messages)) return cached;
    } catch {
      // Redis/cache failure must not replace or weaken the durable path.
    }
    try {
      if (this.#cache !== undefined) {
        await cacheWithin(this.#cache.set(sessionId, messages), this.#cacheOperationTimeoutMs);
      }
    } catch {
      // PostgreSQL remains authoritative.
    }
    return messages;
  }

  async bindIdentity(input: {
    readonly sessionId: string;
    readonly userId: string;
    readonly vehicleId: string;
    readonly updatedAt: AgentSessionRecord["updatedAt"];
  }): Promise<void> {
    await this.#sessions.bindIdentity(input);
  }

  async appendTurn(input: {
    readonly sessionId: string;
    readonly ownerId?: string;
    readonly userMessageId: string;
    readonly userContent: string;
    readonly assistantMessageId: string;
    readonly assistantContent: string;
    readonly createdAt: AgentSessionRecord["updatedAt"];
  }): Promise<readonly [ConversationMessage, ConversationMessage]> {
    const existing = await this.#sessions.get(input.sessionId);
    const session = {
      sessionId: input.sessionId,
      ...(existing?.userId === undefined ? {} : { userId: existing.userId }),
      ...(existing?.vehicleId === undefined ? {} : { vehicleId: existing.vehicleId }),
      createdAt: existing?.createdAt ?? input.createdAt,
      updatedAt: input.createdAt,
    };
    const appended = await this.#conversation.appendTurn({
      session,
      ...(input.ownerId === undefined ? {} : { ownerId: input.ownerId }),
      user: {
        messageId: input.userMessageId || `message:${randomUUID()}`,
        sessionId: input.sessionId,
        role: "user",
        content: sanitizeConversationContent(input.userContent),
        createdAt: input.createdAt,
      },
      assistant: {
        messageId: input.assistantMessageId || `message:${randomUUID()}`,
        sessionId: input.sessionId,
        role: "assistant",
        content: sanitizeConversationContent(input.assistantContent),
        createdAt: toUtcTimestamp(timestampToEpochMs(input.createdAt) + 1),
      },
    });
    await this.#sessions.upsert(session);
    try {
      if (this.#cache !== undefined) {
        await cacheWithin(this.#cache.delete(input.sessionId), this.#cacheOperationTimeoutMs);
      }
    } catch {
      // A stale/missing cache is availability-only; the next restore uses PostgreSQL.
    }
    return appended;
  }
}

function sameConversation(
  cached: readonly ConversationMessage[],
  durable: readonly ConversationMessage[],
): boolean {
  return (
    cached.length === durable.length &&
    cached.every(
      (message, index) =>
        message.messageId === durable[index]?.messageId &&
        message.sessionId === durable[index]?.sessionId &&
        message.role === durable[index]?.role &&
        message.sequence === durable[index]?.sequence &&
        message.content === durable[index]?.content &&
        message.createdAt === durable[index]?.createdAt,
    )
  );
}
