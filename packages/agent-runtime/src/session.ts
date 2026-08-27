import {
  Agent,
  type AgentEvent,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { toUtcTimestamp, type UtcTimestamp } from "@driveguard/domain";
import type { Clock } from "@driveguard/shared";

import type { AgentRun } from "./agent-run.js";

export const PHASE_5_SYSTEM_PROMPT = `You are DriveGuard, a driving and cabin service orchestration assistant.
Use only the tools exposed for the current turn. Use tools for current vehicle, trip, weather, charging, or service data when needed.
Never invent a tool result or claim that an unavailable capability exists.
Never claim direct control of steering, throttle, braking, AEB, ESC, or another safety-critical actuator.
Phase 5 tool execution is a pre-Policy development boundary and is not a production authorization decision.`;

export interface AgentSessionSnapshot {
  readonly sessionId: string;
  readonly activeRunId?: string;
  readonly createdAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
  readonly messageCount: number;
  readonly userMessageCount: number;
  readonly toolNames: readonly string[];
}

export interface AgentSessionOptions {
  readonly sessionId: string;
  readonly model: Model<string>;
  readonly streamFn: StreamFn;
  readonly clock: Clock;
  readonly systemPrompt?: string;
}

export class AgentSession {
  readonly sessionId: string;
  readonly createdAt: UtcTimestamp;
  readonly #agent: Agent;
  readonly #clock: Clock;
  #updatedAt: UtcTimestamp;
  #activeRun: AgentRun | undefined;

  constructor(options: AgentSessionOptions) {
    this.sessionId = options.sessionId;
    this.#clock = options.clock;
    this.createdAt = toUtcTimestamp(this.#clock.nowMs());
    this.#updatedAt = this.createdAt;
    this.#agent = new Agent({
      initialState: {
        systemPrompt: options.systemPrompt ?? PHASE_5_SYSTEM_PROMPT,
        model: options.model,
        thinkingLevel: "off",
        tools: [],
        messages: [],
      },
      streamFn: options.streamFn,
      sessionId: options.sessionId,
      toolExecution: "parallel",
    });
  }

  get activeRun(): AgentRun | undefined {
    return this.#activeRun;
  }

  acquire(run: AgentRun): boolean {
    if (this.#activeRun !== undefined) return false;
    this.#activeRun = run;
    this.#touch();
    return true;
  }

  release(runId: string): void {
    if (this.#activeRun?.runId === runId) {
      this.#activeRun = undefined;
      this.#touch();
    }
  }

  setTools(tools: readonly AgentTool[]): void {
    this.#agent.state.tools = [...tools];
    this.#touch();
  }

  subscribe(
    listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void,
  ): () => void {
    return this.#agent.subscribe(listener);
  }

  prompt(prompt: string): Promise<void> {
    return this.#agent.prompt(prompt);
  }

  abort(): void {
    this.#agent.abort();
  }

  waitForIdle(): Promise<void> {
    return this.#agent.waitForIdle();
  }

  checkpoint(): number {
    return this.#agent.state.messages.length;
  }

  rollback(checkpoint: number): void {
    this.#agent.state.messages = this.#agent.state.messages.slice(0, checkpoint);
    this.#agent.clearAllQueues();
    this.#touch();
  }

  lastAssistantText(): string {
    const message = this.#agent.state.messages.findLast(
      (candidate) => candidate.role === "assistant",
    );
    if (message?.role !== "assistant") return "";
    return message.content
      .filter(
        (content): content is Extract<(typeof message.content)[number], { type: "text" }> =>
          content.type === "text",
      )
      .map((content) => content.text)
      .join("");
  }

  errorMessage(): string | undefined {
    return this.#agent.state.errorMessage;
  }

  snapshot(): AgentSessionSnapshot {
    return Object.freeze({
      sessionId: this.sessionId,
      ...(this.#activeRun === undefined ? {} : { activeRunId: this.#activeRun.runId }),
      createdAt: this.createdAt,
      updatedAt: this.#updatedAt,
      messageCount: this.#agent.state.messages.length,
      userMessageCount: this.#agent.state.messages.filter((message) => message.role === "user")
        .length,
      toolNames: Object.freeze(this.#agent.state.tools.map((tool) => tool.name)),
    });
  }

  #touch(): void {
    this.#updatedAt = toUtcTimestamp(this.#clock.nowMs());
  }
}

export class AgentSessionStore {
  readonly #sessions = new Map<string, AgentSession>();
  readonly #factory: (sessionId: string) => AgentSession;

  constructor(factory: (sessionId: string) => AgentSession) {
    this.#factory = factory;
  }

  getOrCreate(sessionId: string): AgentSession {
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const created = this.#factory(sessionId);
    this.#sessions.set(sessionId, created);
    return created;
  }

  get(sessionId: string): AgentSession | undefined {
    return this.#sessions.get(sessionId);
  }

  get size(): number {
    return this.#sessions.size;
  }

  snapshots(): readonly AgentSessionSnapshot[] {
    return Object.freeze(
      [...this.#sessions.values()]
        .map((session) => session.snapshot())
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
    );
  }
}
