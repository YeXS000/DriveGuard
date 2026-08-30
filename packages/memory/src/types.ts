import type { UtcTimestamp } from "@driveguard/domain";

export type ConversationRole = "user" | "assistant";

export interface AgentSessionRecord {
  readonly sessionId: string;
  readonly userId?: string;
  readonly vehicleId?: string;
  readonly createdAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
}

export interface ConversationMessage {
  readonly messageId: string;
  readonly sessionId: string;
  readonly role: ConversationRole;
  readonly content: string;
  readonly createdAt: UtcTimestamp;
  readonly sequence: number;
}

export interface SessionRepository {
  get(sessionId: string): Promise<AgentSessionRecord | undefined>;
  upsert(record: AgentSessionRecord): Promise<AgentSessionRecord>;
  bindIdentity(input: {
    readonly sessionId: string;
    readonly userId: string;
    readonly vehicleId: string;
    readonly updatedAt: UtcTimestamp;
  }): Promise<AgentSessionRecord>;
}

export interface SessionIdentityBinding {
  readonly sessionId: string;
  readonly userId: string;
  readonly vehicleId: string;
  readonly updatedAt: UtcTimestamp;
}

export interface ConversationRepository {
  list(sessionId: string): Promise<readonly ConversationMessage[]>;
  appendTurn(input: {
    readonly session: AgentSessionRecord;
    readonly ownerId?: string;
    readonly user: Omit<ConversationMessage, "sequence">;
    readonly assistant: Omit<ConversationMessage, "sequence">;
  }): Promise<readonly [ConversationMessage, ConversationMessage]>;
}

export interface ConversationMemory {
  restore(input: SessionIdentityBinding): Promise<readonly ConversationMessage[]>;
  bindIdentity(input: SessionIdentityBinding): Promise<void>;
  appendTurn(input: {
    readonly sessionId: string;
    readonly ownerId?: string;
    readonly userMessageId: string;
    readonly userContent: string;
    readonly assistantMessageId: string;
    readonly assistantContent: string;
    readonly createdAt: UtcTimestamp;
  }): Promise<readonly [ConversationMessage, ConversationMessage]>;
}

export interface SessionCoordinator {
  readonly leaseDurationMs: number;
  acquire(sessionId: string, ownerId: string): Promise<boolean>;
  renew(sessionId: string, ownerId: string): Promise<boolean>;
  release(sessionId: string, ownerId: string): Promise<void>;
}

/** Availability-only fast coordination. PostgreSQL remains authoritative. */
export interface IdempotencyCoordinator {
  acquire(idempotencyKey: string, ownerId: string): Promise<boolean>;
  release(idempotencyKey: string, ownerId: string): Promise<void>;
}

export interface ConversationCache {
  get(sessionId: string): Promise<readonly ConversationMessage[] | undefined>;
  set(sessionId: string, messages: readonly ConversationMessage[]): Promise<void>;
  delete(sessionId: string): Promise<void>;
}
