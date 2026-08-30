import type { ExecutionEvent, ExecutionEventSink } from "@driveguard/executor";
import type { Pool } from "pg";

/** Persists attempt start before dispatch so a crash cannot erase possible side-effect evidence. */
export class PostgresExecutionAttemptEventSink implements ExecutionEventSink {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async emit(event: ExecutionEvent): Promise<void> {
    if (event.attempt < 1) return;
    if (event.eventType === "execution.attempt.started") {
      await this.#pool.query(
        `insert into execution_attempts
          (execution_id,attempt,attempt_record,started_at,completed_at)
         values ($1,$2,$3::jsonb,$4,null)
         on conflict (execution_id,attempt) do nothing`,
        [
          event.executionId,
          event.attempt,
          JSON.stringify({ attempt: event.attempt, startedAt: event.timestamp, state: "STARTED" }),
          event.timestamp,
        ],
      );
      return;
    }
    if (
      event.eventType === "execution.attempt.failed" ||
      event.eventType === "execution.succeeded" ||
      event.eventType === "execution.outcome_unknown"
    ) {
      const outcome =
        event.eventType === "execution.succeeded"
          ? "SUCCEEDED"
          : event.eventType === "execution.outcome_unknown"
            ? "OUTCOME_UNKNOWN"
            : "FAILED";
      await this.#pool.query(
        `update execution_attempts
         set attempt_record=attempt_record || $1::jsonb,completed_at=$2
         where execution_id=$3 and attempt=$4`,
        [
          JSON.stringify({
            attempt: event.attempt,
            completedAt: event.timestamp,
            outcome,
            ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
          }),
          event.timestamp,
          event.executionId,
          event.attempt,
        ],
      );
    }
  }
}
