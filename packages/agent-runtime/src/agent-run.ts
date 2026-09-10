import type { ContextSnapshotId, UtcTimestamp } from "@driveguard/domain";
import type { Clock } from "@driveguard/shared";

import { AgentRuntimeError } from "./runtime-errors.js";

export const AGENT_RUN_STATUSES = [
  "RUN_CREATED",
  "CONTEXT_LOADING",
  "CAPABILITY_RESOLUTION",
  "MODEL_RUNNING",
  "TOOL_REQUESTED",
  "TOOL_PROCESSING",
  "MODEL_RESUMED",
  "RUN_SUCCEEDED",
  "RUN_FAILED",
  "RUN_CANCELLED",
] as const;

export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];
export type TerminalAgentRunStatus = "RUN_SUCCEEDED" | "RUN_FAILED" | "RUN_CANCELLED";

const TERMINAL_STATUSES = new Set<AgentRunStatus>(["RUN_SUCCEEDED", "RUN_FAILED", "RUN_CANCELLED"]);

const LEGAL_TRANSITIONS = {
  RUN_CREATED: ["CONTEXT_LOADING", "RUN_CANCELLED", "RUN_FAILED"],
  CONTEXT_LOADING: ["CAPABILITY_RESOLUTION", "RUN_CANCELLED", "RUN_FAILED"],
  CAPABILITY_RESOLUTION: ["MODEL_RUNNING", "RUN_CANCELLED", "RUN_FAILED"],
  MODEL_RUNNING: ["TOOL_REQUESTED", "RUN_SUCCEEDED", "RUN_CANCELLED", "RUN_FAILED"],
  TOOL_REQUESTED: ["TOOL_PROCESSING", "RUN_CANCELLED", "RUN_FAILED"],
  TOOL_PROCESSING: ["MODEL_RESUMED", "RUN_CANCELLED", "RUN_FAILED"],
  MODEL_RESUMED: [
    "MODEL_RUNNING",
    "TOOL_REQUESTED",
    "RUN_SUCCEEDED",
    "RUN_CANCELLED",
    "RUN_FAILED",
  ],
  RUN_SUCCEEDED: [],
  RUN_FAILED: [],
  RUN_CANCELLED: [],
} as const satisfies Readonly<Record<AgentRunStatus, readonly AgentRunStatus[]>>;

export interface AgentRunIdentity {
  readonly runId: string;
  readonly sessionId: string;
  readonly traceId: string;
  readonly createdAt: UtcTimestamp;
}

export interface AgentRunSnapshot extends AgentRunIdentity {
  readonly contextSnapshotId?: ContextSnapshotId;
  readonly status: AgentRunStatus;
  readonly statusHistory: readonly AgentRunStatus[];
}

export class AgentRun {
  readonly runId: string;
  readonly sessionId: string;
  readonly traceId: string;
  readonly createdAt: UtcTimestamp;
  readonly #clock: Clock;
  #contextSnapshotId: ContextSnapshotId | undefined;
  #status: AgentRunStatus = "RUN_CREATED";
  readonly #history: AgentRunStatus[] = ["RUN_CREATED"];

  constructor(identity: AgentRunIdentity, clock: Clock) {
    this.runId = identity.runId;
    this.sessionId = identity.sessionId;
    this.traceId = identity.traceId;
    this.createdAt = identity.createdAt;
    this.#clock = clock;
  }

  get status(): AgentRunStatus {
    return this.#status;
  }

  get contextSnapshotId(): ContextSnapshotId | undefined {
    return this.#contextSnapshotId;
  }

  get isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this.#status);
  }

  attachContext(snapshotId: ContextSnapshotId): void {
    if (this.#contextSnapshotId !== undefined && this.#contextSnapshotId !== snapshotId) {
      throw new AgentRuntimeError("INTERNAL_ERROR", "AgentRun context snapshot is immutable");
    }
    this.#contextSnapshotId = snapshotId;
  }

  canTransition(next: AgentRunStatus): boolean {
    return (LEGAL_TRANSITIONS[this.#status] as readonly AgentRunStatus[]).includes(next);
  }

  transition(next: AgentRunStatus): void {
    void this.#clock.nowMs();
    if (!this.canTransition(next)) {
      throw new AgentRuntimeError(
        "INTERNAL_ERROR",
        `Illegal AgentRun transition: ${this.#status} -> ${next}`,
      );
    }
    this.#status = next;
    this.#history.push(next);
  }

  snapshot(): AgentRunSnapshot {
    return Object.freeze({
      runId: this.runId,
      sessionId: this.sessionId,
      traceId: this.traceId,
      createdAt: this.createdAt,
      ...(this.#contextSnapshotId === undefined
        ? {}
        : { contextSnapshotId: this.#contextSnapshotId }),
      status: this.#status,
      statusHistory: Object.freeze([...this.#history]),
    });
  }
}

export function legalAgentRunTransitions(): Readonly<
  Record<AgentRunStatus, readonly AgentRunStatus[]>
> {
  return LEGAL_TRANSITIONS;
}
