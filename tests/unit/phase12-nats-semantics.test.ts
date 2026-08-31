import type { JetStreamClient } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/nats-core";
import {
  URGENT_NATS,
  UrgentEventConsumer,
  UrgentEventPublisher,
  UrgentEventTransientError,
  type UrgentConsumableMessage,
  type UrgentEventProcessingResult,
} from "@driveguard/urgent-events";
import { describe, expect, it, vi } from "vitest";

function event() {
  return {
    eventId: "nats-event-1",
    schemaVersion: 1,
    eventType: "LOW_SOC",
    source: "SIMULATOR",
    vehicleId: "vehicle-001",
    occurredAt: "2026-08-25T09:59:59.000Z",
    receivedAt: "2026-08-25T10:00:00.000Z",
    severity: "HIGH",
    payload: { reportedSoc: 5 },
    correlationId: "nats-correlation-1",
  };
}

function message(input: unknown, deliveryCount = 1, jsonFailure = false) {
  const ack = vi.fn();
  const nak = vi.fn();
  const value: UrgentConsumableMessage = {
    info: { deliveryCount },
    json: <T>() => {
      if (jsonFailure) throw new Error("invalid json");
      return input as T;
    },
    ack,
    nak,
  };
  return { value, ack, nak };
}

function consumer(options: {
  readonly process?: (input: unknown) => Promise<UrgentEventProcessingResult>;
  readonly maxDeliver?: number;
}) {
  const publications: Array<{ subject: string; payload: Uint8Array }> = [];
  const publish = vi.fn((subject: string, payload: Uint8Array) => {
    publications.push({ subject, payload });
    return Promise.resolve({ seq: publications.length, duplicate: false });
  });
  const jetstreamClient = { publish } as unknown as JetStreamClient;
  const subject = new UrgentEventConsumer({
    connection: {} as NatsConnection,
    processor: {
      process:
        options.process ??
        (() => Promise.resolve(Object.freeze({ disposition: "HANDLED" as const }))),
    },
    jetstreamClient,
    ...(options.maxDeliver === undefined ? {} : { maxDeliver: options.maxDeliver }),
    nakDelayMs: 25,
  });
  return { subject, publications, publish };
}

describe("Phase 12 JetStream ACK, redelivery, and DLQ semantics", () => {
  it("ACKs a successfully handled event", async () => {
    const subject = consumer({});
    const input = message(event());
    await subject.subject.handle(input.value);
    expect(input.ack).toHaveBeenCalledOnce();
    expect(input.nak).not.toHaveBeenCalled();
    expect(subject.publish).not.toHaveBeenCalled();
  });

  it("NAKs a transient failure below the bounded delivery limit", async () => {
    const subject = consumer({
      process: () => Promise.reject(new UrgentEventTransientError()),
      maxDeliver: 5,
    });
    const input = message(event(), 2);
    await subject.subject.handle(input.value);
    expect(input.nak).toHaveBeenCalledWith(25);
    expect(input.ack).not.toHaveBeenCalled();
    expect(subject.publish).not.toHaveBeenCalled();
  });

  it("honors the processor retry delay for an active durable lease", async () => {
    const subject = consumer({
      process: () =>
        Promise.reject(new UrgentEventTransientError("owned", { retryDelayMs: 30_100 })),
      maxDeliver: 5,
    });
    const input = message(event(), 2);
    await subject.subject.handle(input.value);
    expect(input.nak).toHaveBeenCalledWith(30_100);
    expect(input.ack).not.toHaveBeenCalled();
  });

  it("moves a transient failure to DLQ and ACKs at max delivery", async () => {
    const subject = consumer({
      process: () => Promise.reject(new UrgentEventTransientError()),
      maxDeliver: 5,
    });
    const input = message(event(), 5);
    await subject.subject.handle(input.value);
    expect(input.nak).not.toHaveBeenCalled();
    expect(input.ack).toHaveBeenCalledOnce();
    expect(subject.publications).toHaveLength(1);
    expect(subject.publications[0]?.subject).toBe(URGENT_NATS.dlqSubject);
    expect(JSON.parse(new TextDecoder().decode(subject.publications[0]?.payload))).toMatchObject({
      reasonCode: "URGENT_EVENT_REDELIVERY_EXHAUSTED",
      deliveryCount: 5,
      eventId: "nats-event-1",
    });
  });

  it("moves malformed JSON directly to DLQ without business processing", async () => {
    const process = vi.fn();
    const subject = consumer({ process });
    const input = message(undefined, 1, true);
    await subject.subject.handle(input.value);
    expect(process).not.toHaveBeenCalled();
    expect(input.ack).toHaveBeenCalledOnce();
    expect(input.nak).not.toHaveBeenCalled();
    expect(JSON.parse(new TextDecoder().decode(subject.publications[0]?.payload))).toMatchObject({
      reasonCode: "URGENT_EVENT_INVALID_JSON",
      eventId: null,
    });
  });

  it("moves permanent handler failures directly to DLQ", async () => {
    const subject = consumer({ process: () => Promise.reject(new Error("permanent")) });
    const input = message(event());
    await subject.subject.handle(input.value);
    expect(input.ack).toHaveBeenCalledOnce();
    expect(input.nak).not.toHaveBeenCalled();
    expect(JSON.parse(new TextDecoder().decode(subject.publications[0]?.payload))).toMatchObject({
      reasonCode: "URGENT_EVENT_PERMANENT_FAILURE",
    });
  });

  it("moves validation rejection to DLQ and ACKs once", async () => {
    const subject = consumer({
      process: () =>
        Promise.resolve(
          Object.freeze({ disposition: "REJECTED" as const, invalidEventId: "nats-event-1" }),
        ),
    });
    const input = message(event());
    await subject.subject.handle(input.value);
    expect(input.ack).toHaveBeenCalledOnce();
    expect(subject.publications).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(subject.publications[0]?.payload))).toMatchObject({
      reasonCode: "URGENT_EVENT_REJECTED",
    });
  });

  it("publishes validated events with eventId transport deduplication", async () => {
    const publish = vi.fn().mockResolvedValue({ seq: 42, duplicate: false });
    const publisher = new UrgentEventPublisher(
      {} as NatsConnection,
      { publish } as unknown as JetStreamClient,
    );
    await expect(publisher.publish(event())).resolves.toEqual({ sequence: 42, duplicate: false });
    expect(publish).toHaveBeenCalledWith(URGENT_NATS.urgentSubject, expect.any(Uint8Array), {
      msgID: "nats-event-1",
    });
  });

  it("rejects invalid publication before touching NATS", async () => {
    const publish = vi.fn();
    const publisher = new UrgentEventPublisher(
      {} as NatsConnection,
      { publish } as unknown as JetStreamClient,
    );
    await expect(publisher.publish({ ...event(), schemaVersion: 2 })).rejects.toThrow();
    expect(publish).not.toHaveBeenCalled();
  });
});
