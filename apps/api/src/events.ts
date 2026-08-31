import { randomUUID } from "node:crypto";

import type { RuntimeEvent, RuntimeEventSink } from "@driveguard/agent-runtime";
import type { UtcTimestamp } from "@driveguard/domain";

export const PUBLIC_EVENT_TYPES = [
  "run.started",
  "assistant.delta",
  "tool.requested",
  "policy.decision",
  "confirmation.required",
  "tool.completed",
  "assistant.completed",
  "run.failed",
] as const;

export type PublicEventType = (typeof PUBLIC_EVENT_TYPES)[number];

export interface PublicRunEvent {
  readonly event_id: string;
  readonly event_type: PublicEventType;
  readonly run_id: string;
  readonly trace_id: string;
  readonly timestamp: UtcTimestamp;
  readonly data: Readonly<Record<string, unknown>>;
}

export type PublicEventEmitter = (event: PublicRunEvent) => void | Promise<void>;

export function publicEvent(input: {
  readonly eventType: PublicEventType;
  readonly runId: string;
  readonly traceId: string;
  readonly timestamp: UtcTimestamp;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly eventId?: string;
}): PublicRunEvent {
  return Object.freeze({
    event_id: input.eventId ?? `api-event:${randomUUID()}`,
    event_type: input.eventType,
    run_id: input.runId,
    trace_id: input.traceId,
    timestamp: input.timestamp,
    data: Object.freeze({ ...(input.data ?? {}) }),
  });
}

export function createRuntimePublicEventSink(emit: PublicEventEmitter): RuntimeEventSink {
  return {
    async emit(event: RuntimeEvent): Promise<void> {
      const common = {
        runId: event.runId,
        traceId: event.traceId,
        timestamp: event.timestamp,
        eventId: event.eventId,
      };
      switch (event.eventType) {
        case "agent.run.started":
          await emit(publicEvent({ ...common, eventType: "run.started" }));
          return;
        case "tool.requested":
          await emit(
            publicEvent({
              ...common,
              eventType: "tool.requested",
              data: {
                tool: event.metadata?.toolName ?? "unregistered_tool",
                tool_call_id: event.metadata?.toolCallId ?? "unknown",
              },
            }),
          );
          return;
        case "policy.decision.made":
          await emit(
            publicEvent({
              ...common,
              eventType: "policy.decision",
              data: {
                tool: event.metadata?.toolName ?? "unknown",
                decision: event.metadata?.decision ?? "DENY",
                rule_id: event.metadata?.ruleId ?? "unknown",
              },
            }),
          );
          return;
        case "tool.completed":
          await emit(
            publicEvent({
              ...common,
              eventType: "tool.completed",
              data: {
                tool: event.metadata?.toolName ?? "unregistered_tool",
                tool_call_id: event.metadata?.toolCallId ?? "unknown",
                is_error: event.metadata?.isError ?? false,
              },
            }),
          );
          return;
        case "agent.run.failed":
          if (event.metadata?.errorCode !== "POLICY_CONFIRMATION_REQUIRED") {
            await emit(
              publicEvent({
                ...common,
                eventType: "run.failed",
                data: { code: event.metadata?.errorCode ?? "INTERNAL_ERROR" },
              }),
            );
          }
          return;
        default:
          return;
      }
    },
  };
}
