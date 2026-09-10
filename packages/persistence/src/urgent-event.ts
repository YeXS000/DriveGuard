import { createHash } from "node:crypto";

import type { UtcTimestamp } from "@driveguard/domain";
import {
  urgentEventFingerprint,
  type UrgentEventClaim,
  type UrgentEventRecord,
  type UrgentEventRepository,
  type UrgentEventResultMetadata,
  type UrgentEventSeverity,
  type UrgentEventStatus,
  type UrgentEventType,
} from "@driveguard/urgent-events";
import type { Pool } from "pg";

interface UrgentEventRow {
  readonly eventId: string;
  readonly eventFingerprint: string;
  readonly eventType: UrgentEventType | "UNKNOWN";
  readonly vehicleId: string;
  readonly severity: UrgentEventSeverity;
  readonly status: UrgentEventStatus;
  readonly receivedAt: Date;
  readonly processedAt: Date | null;
  readonly correlationId: string;
  readonly processingOwner: string | null;
  readonly processingExpiresAt: Date | null;
  readonly attemptCount: number;
  readonly result: UrgentEventResultMetadata;
}

const selection = `
  event_id as "eventId", event_fingerprint as "eventFingerprint",
  event_type as "eventType", vehicle_id as "vehicleId",
  severity, status, received_at as "receivedAt", processed_at as "processedAt",
  correlation_id as "correlationId", processing_owner as "processingOwner",
  processing_expires_at as "processingExpiresAt", attempt_count as "attemptCount", result
`;

function utc(value: Date): UtcTimestamp {
  return value.toISOString() as UtcTimestamp;
}

function record(row: UrgentEventRow): UrgentEventRecord {
  return Object.freeze({
    eventId: row.eventId,
    eventFingerprint: row.eventFingerprint,
    eventType: row.eventType,
    vehicleId: row.vehicleId,
    severity: row.severity,
    status: row.status,
    receivedAt: utc(row.receivedAt),
    processedAt: row.processedAt === null ? null : utc(row.processedAt),
    correlationId: row.correlationId,
    processingOwner: row.processingOwner,
    processingExpiresAt: row.processingExpiresAt === null ? null : utc(row.processingExpiresAt),
    attemptCount: row.attemptCount,
    result: Object.freeze(structuredClone(row.result)),
  });
}

export class PostgresUrgentEventRepository implements UrgentEventRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async claim(input: Parameters<UrgentEventRepository["claim"]>[0]): Promise<UrgentEventClaim> {
    const fingerprint = urgentEventFingerprint(input.event);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `insert into urgent_events (
           event_id,event_fingerprint,event_type,vehicle_id,severity,status,received_at,processed_at,
           correlation_id,processing_owner,processing_expires_at,attempt_count,result
         ) values ($1,$2,$3,$4,$5,'RECEIVED',$6,null,$7,null,null,0,$8::jsonb)
         on conflict (event_id) do nothing`,
        [
          input.event.eventId,
          fingerprint,
          input.event.eventType,
          input.event.vehicleId,
          input.severity,
          new Date(input.event.receivedAt),
          input.event.correlationId,
          JSON.stringify({ safeSummary: "Urgent event received." }),
        ],
      );
      const claimed = await client.query<UrgentEventRow>(
        `update urgent_events
            set status='PROCESSING', processing_owner=$2, processing_expires_at=$3,
                processed_at=null, attempt_count=attempt_count+1,
                result=$4::jsonb
          where event_id=$1
            and event_fingerprint=$6
            and (
              status in ('RECEIVED','FAILED')
              or (status='PROCESSING' and processing_expires_at <= $5)
            )
        returning ${selection}`,
        [
          input.event.eventId,
          input.ownerId,
          new Date(Date.parse(input.now) + input.leaseMs),
          JSON.stringify({ safeSummary: "Urgent event processing is in progress." }),
          new Date(input.now),
          fingerprint,
        ],
      );
      if (claimed.rows[0] !== undefined) {
        await client.query("COMMIT");
        return Object.freeze({ kind: "CLAIMED", record: record(claimed.rows[0]) });
      }
      const existing = await client.query<UrgentEventRow>(
        `select ${selection} from urgent_events where event_id=$1`,
        [input.event.eventId],
      );
      await client.query("COMMIT");
      if (existing.rows[0] === undefined) throw new Error("Urgent event claim disappeared");
      if (existing.rows[0].eventFingerprint !== fingerprint) {
        return Object.freeze({ kind: "CONFLICT", record: record(existing.rows[0]) });
      }
      return Object.freeze({ kind: "DUPLICATE", record: record(existing.rows[0]) });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async complete(
    input: Parameters<UrgentEventRepository["complete"]>[0],
  ): Promise<UrgentEventRecord> {
    const completed = await this.#pool.query<UrgentEventRow>(
      `update urgent_events
          set status=$3, processed_at=$4, processing_owner=null, processing_expires_at=null,
              result=$5::jsonb
        where event_id=$1 and status='PROCESSING' and processing_owner=$2
      returning ${selection}`,
      [
        input.eventId,
        input.ownerId,
        input.status,
        new Date(input.processedAt),
        JSON.stringify(input.result),
      ],
    );
    if (completed.rows[0] === undefined) {
      throw new Error("Urgent event completion lost durable ownership");
    }
    return record(completed.rows[0]);
  }

  async rejectInvalid(
    input: Parameters<UrgentEventRepository["rejectInvalid"]>[0],
  ): Promise<UrgentEventRecord> {
    const rejected = await this.#pool.query<UrgentEventRow>(
      `insert into urgent_events (
         event_id,event_fingerprint,event_type,vehicle_id,severity,status,received_at,processed_at,
         correlation_id,processing_owner,processing_expires_at,attempt_count,result
       ) values ($1,$2,'UNKNOWN',$3,'WARNING','REJECTED',$4,$5,$6,null,null,1,$7::jsonb)
       on conflict (event_id) do nothing
       returning ${selection}`,
      [
        input.eventId,
        createHash("sha256")
          .update(
            JSON.stringify({
              eventId: input.eventId,
              eventType: input.eventType,
              vehicleId: input.vehicleId,
              receivedAt: input.receivedAt,
              correlationId: input.correlationId,
            }),
            "utf8",
          )
          .digest("hex"),
        input.vehicleId,
        new Date(input.receivedAt),
        new Date(input.processedAt),
        input.correlationId,
        JSON.stringify({
          safeSummary: "Urgent event failed validation and was not executed.",
          resultCode: input.resultCode,
        }),
      ],
    );
    if (rejected.rows[0] !== undefined) return record(rejected.rows[0]);
    const existing = await this.get(input.eventId);
    if (existing === undefined) throw new Error("Rejected urgent event disappeared");
    return existing;
  }

  async get(eventId: string): Promise<UrgentEventRecord | undefined> {
    const result = await this.#pool.query<UrgentEventRow>(
      `select ${selection} from urgent_events where event_id=$1`,
      [eventId],
    );
    return result.rows[0] === undefined ? undefined : record(result.rows[0]);
  }

  async listByVehicle(vehicleId: string, limit = 50): Promise<readonly UrgentEventRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Urgent event list limit is invalid");
    }
    const result = await this.#pool.query<UrgentEventRow>(
      `select ${selection} from urgent_events
        where vehicle_id=$1 order by received_at desc, event_id desc limit $2`,
      [vehicleId, limit],
    );
    return Object.freeze(result.rows.map(record));
  }
}
