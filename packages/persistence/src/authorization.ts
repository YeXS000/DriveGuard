import type { ExecutionAuthorization } from "@driveguard/action-lifecycle";
import type { UtcTimestamp } from "@driveguard/domain";
import type { Pool, QueryResultRow } from "pg";

export interface StoredAuthorization {
  readonly authorization: ExecutionAuthorization;
  readonly consumedAt: UtcTimestamp | null;
}

export interface AuthorizationRepository {
  getById(authorizationId: string): Promise<StoredAuthorization | undefined>;
  getByActionId(actionId: string): Promise<StoredAuthorization | undefined>;
}

function cloneStoredAuthorization(record: StoredAuthorization): StoredAuthorization {
  return Object.freeze({
    authorization: structuredClone(record.authorization),
    consumedAt: record.consumedAt,
  });
}

export class InMemoryAuthorizationRepository implements AuthorizationRepository {
  readonly #byId = new Map<string, StoredAuthorization>();
  readonly #byAction = new Map<string, StoredAuthorization>();

  store(record: StoredAuthorization): void {
    const stored = cloneStoredAuthorization(record);
    this.#byId.set(stored.authorization.authorizationId, stored);
    this.#byAction.set(stored.authorization.actionId, stored);
  }

  getById(authorizationId: string): Promise<StoredAuthorization | undefined> {
    const record = this.#byId.get(authorizationId);
    return Promise.resolve(record === undefined ? undefined : cloneStoredAuthorization(record));
  }

  getByActionId(actionId: string): Promise<StoredAuthorization | undefined> {
    const record = this.#byAction.get(actionId);
    return Promise.resolve(record === undefined ? undefined : cloneStoredAuthorization(record));
  }
}

interface AuthorizationRow extends QueryResultRow {
  authorization: ExecutionAuthorization;
  consumed_at: Date | null;
}

export class PostgresAuthorizationRepository implements AuthorizationRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async getById(authorizationId: string): Promise<StoredAuthorization | undefined> {
    return this.#get("authorization_id", authorizationId);
  }

  async getByActionId(actionId: string): Promise<StoredAuthorization | undefined> {
    return this.#get("action_id", actionId);
  }

  async #get(
    column: "authorization_id" | "action_id",
    value: string,
  ): Promise<StoredAuthorization | undefined> {
    const result = await this.#pool.query<AuthorizationRow>(
      `select "authorization",consumed_at from execution_authorizations where ${column}=$1`,
      [value],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return cloneStoredAuthorization({
      authorization: row.authorization,
      consumedAt: row.consumed_at === null ? null : (row.consumed_at.toISOString() as UtcTimestamp),
    });
  }
}
