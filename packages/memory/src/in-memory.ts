import type {
  AgentSessionRecord,
  ConversationMessage,
  ConversationRepository,
  SessionCoordinator,
  SessionRepository,
} from "./types.js";

function cloneSession(record: AgentSessionRecord): AgentSessionRecord {
  return Object.freeze({ ...record });
}

function cloneMessage(message: ConversationMessage): ConversationMessage {
  return Object.freeze({ ...message });
}

export class InMemorySessionRepository implements SessionRepository {
  readonly #sessions = new Map<string, AgentSessionRecord>();

  get(sessionId: string): Promise<AgentSessionRecord | undefined> {
    const record = this.#sessions.get(sessionId);
    return Promise.resolve(record === undefined ? undefined : cloneSession(record));
  }

  upsert(record: AgentSessionRecord): Promise<AgentSessionRecord> {
    const existing = this.#sessions.get(record.sessionId);
    if (
      existing !== undefined &&
      ((existing.userId !== undefined &&
        record.userId !== undefined &&
        existing.userId !== record.userId) ||
        (existing.vehicleId !== undefined &&
          record.vehicleId !== undefined &&
          existing.vehicleId !== record.vehicleId))
    ) {
      return Promise.reject(new Error("Session identity mismatch"));
    }
    const stored = cloneSession(
      existing === undefined
        ? record
        : {
            ...record,
            createdAt: existing.createdAt,
            ...(existing.userId === undefined ? {} : { userId: existing.userId }),
            ...(existing.vehicleId === undefined ? {} : { vehicleId: existing.vehicleId }),
          },
    );
    this.#sessions.set(record.sessionId, stored);
    return Promise.resolve(cloneSession(stored));
  }

  bindIdentity(input: {
    readonly sessionId: string;
    readonly userId: string;
    readonly vehicleId: string;
    readonly updatedAt: AgentSessionRecord["updatedAt"];
  }): Promise<AgentSessionRecord> {
    const existing = this.#sessions.get(input.sessionId);
    if (
      existing !== undefined &&
      ((existing.userId !== undefined && existing.userId !== input.userId) ||
        (existing.vehicleId !== undefined && existing.vehicleId !== input.vehicleId))
    ) {
      return Promise.reject(new Error("Session identity mismatch"));
    }
    const stored = cloneSession({
      sessionId: input.sessionId,
      userId: input.userId,
      vehicleId: input.vehicleId,
      createdAt: existing?.createdAt ?? input.updatedAt,
      updatedAt: input.updatedAt,
    });
    this.#sessions.set(input.sessionId, stored);
    return Promise.resolve(cloneSession(stored));
  }
}

export class InMemoryConversationRepository implements ConversationRepository {
  readonly #messages = new Map<string, ConversationMessage[]>();
  readonly #queues = new Map<string, Promise<void>>();

  list(sessionId: string): Promise<readonly ConversationMessage[]> {
    return Promise.resolve(Object.freeze((this.#messages.get(sessionId) ?? []).map(cloneMessage)));
  }

  async appendTurn(input: {
    readonly session: AgentSessionRecord;
    readonly ownerId?: string;
    readonly user: Omit<ConversationMessage, "sequence">;
    readonly assistant: Omit<ConversationMessage, "sequence">;
  }): Promise<readonly [ConversationMessage, ConversationMessage]> {
    return this.#exclusive(input.session.sessionId, () => {
      const messages = this.#messages.get(input.session.sessionId) ?? [];
      const sequence = messages.length;
      const user = cloneMessage({ ...input.user, sequence });
      const assistant = cloneMessage({ ...input.assistant, sequence: sequence + 1 });
      messages.push(user, assistant);
      this.#messages.set(input.session.sessionId, messages);
      return Promise.resolve(Object.freeze([cloneMessage(user), cloneMessage(assistant)]));
    });
  }

  async #exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    this.#queues.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#queues.get(key) === queued) this.#queues.delete(key);
    }
  }
}

export class InMemorySessionCoordinator implements SessionCoordinator {
  readonly leaseDurationMs = 120_000;
  readonly #owners = new Map<string, string>();

  acquire(sessionId: string, ownerId: string): Promise<boolean> {
    if (this.#owners.has(sessionId)) return Promise.resolve(false);
    this.#owners.set(sessionId, ownerId);
    return Promise.resolve(true);
  }

  renew(sessionId: string, ownerId: string): Promise<boolean> {
    return Promise.resolve(this.#owners.get(sessionId) === ownerId);
  }

  release(sessionId: string, ownerId: string): Promise<void> {
    if (this.#owners.get(sessionId) === ownerId) this.#owners.delete(sessionId);
    return Promise.resolve();
  }
}
