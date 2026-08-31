import {
  AckPolicy,
  DeliverPolicy,
  DiscardPolicy,
  ReplayPolicy,
  RetentionPolicy,
  StorageType,
  jetstream,
  jetstreamManager,
  JetStreamApiCodes,
  JetStreamApiError,
  type ConsumerMessages,
  type JetStreamClient,
} from "@nats-io/jetstream";
import { nanos, type NatsConnection } from "@nats-io/nats-core";

import { UrgentEventTransientError } from "./errors.js";
import { parseUrgentEvent, readRejectableEventIdentity } from "./model.js";
import type { UrgentEventProcessor, UrgentEventProcessingResult } from "./processor.js";

export const URGENT_NATS = Object.freeze({
  stream: "DRIVEGUARD_URGENT_EVENTS",
  durable: "driveguard-urgent-v1",
  vehicleSubject: "driveguard.vehicle.events",
  urgentSubject: "driveguard.urgent.events",
  dlqSubject: "driveguard.urgent.dlq",
  maxDeliver: 5,
  ackWaitMs: 10_000,
  nakDelayMs: 500,
});

const encoder = new TextEncoder();

export class UrgentEventPublisher {
  readonly #jetstream: JetStreamClient;

  constructor(connection: NatsConnection, client?: JetStreamClient) {
    this.#jetstream = client ?? jetstream(connection);
  }

  async publish(input: unknown): Promise<Readonly<{ sequence: number; duplicate: boolean }>> {
    const event = parseUrgentEvent(input);
    const ack = await this.#jetstream.publish(
      URGENT_NATS.urgentSubject,
      encoder.encode(JSON.stringify(event)),
      { msgID: event.eventId },
    );
    return Object.freeze({ sequence: ack.seq, duplicate: ack.duplicate });
  }
}

export interface UrgentEventConsumerOptions {
  readonly connection: NatsConnection;
  readonly processor: UrgentEventProcessorPort;
  readonly maxDeliver?: number;
  readonly nakDelayMs?: number;
  readonly jetstreamClient?: JetStreamClient;
}

export interface UrgentEventProcessorPort {
  process(input: unknown): ReturnType<UrgentEventProcessor["process"]>;
}

export interface UrgentConsumableMessage {
  readonly info: { readonly deliveryCount: number };
  json<T>(): T;
  ack(): void;
  nak(delayMs?: number): void;
}

export class UrgentEventConsumer {
  readonly #connection: NatsConnection;
  readonly #jetstream: JetStreamClient;
  readonly #processor: UrgentEventProcessorPort;
  readonly #maxDeliver: number;
  readonly #nakDelayMs: number;
  #messages: ConsumerMessages | undefined;
  #task: Promise<void> | undefined;

  constructor(options: UrgentEventConsumerOptions) {
    this.#connection = options.connection;
    this.#jetstream = options.jetstreamClient ?? jetstream(options.connection);
    this.#processor = options.processor;
    this.#maxDeliver = options.maxDeliver ?? URGENT_NATS.maxDeliver;
    this.#nakDelayMs = options.nakDelayMs ?? URGENT_NATS.nakDelayMs;
  }

  async initialize(): Promise<void> {
    const manager = await jetstreamManager(this.#connection);
    try {
      const existing = await manager.streams.info(URGENT_NATS.stream);
      const subjects = new Set(existing.config.subjects ?? []);
      for (const subject of [
        URGENT_NATS.vehicleSubject,
        URGENT_NATS.urgentSubject,
        URGENT_NATS.dlqSubject,
      ]) {
        subjects.add(subject);
      }
      await manager.streams.update(URGENT_NATS.stream, {
        subjects: [...subjects],
        max_age: nanos(7 * 24 * 60 * 60 * 1_000),
        duplicate_window: nanos(2 * 60 * 1_000),
      });
    } catch (error) {
      if (
        !(error instanceof JetStreamApiError) ||
        error.code !== JetStreamApiCodes.StreamNotFound
      ) {
        throw error;
      }
      await manager.streams.add({
        name: URGENT_NATS.stream,
        subjects: [URGENT_NATS.vehicleSubject, URGENT_NATS.urgentSubject, URGENT_NATS.dlqSubject],
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        discard: DiscardPolicy.Old,
        max_age: nanos(7 * 24 * 60 * 60 * 1_000),
        duplicate_window: nanos(2 * 60 * 1_000),
      });
    }
    await manager.consumers.add(URGENT_NATS.stream, {
      name: URGENT_NATS.durable,
      durable_name: URGENT_NATS.durable,
      description: "DriveGuard Phase 12 durable urgent-event consumer",
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      replay_policy: ReplayPolicy.Instant,
      filter_subject: URGENT_NATS.urgentSubject,
      ack_wait: nanos(URGENT_NATS.ackWaitMs),
      max_deliver: this.#maxDeliver,
      max_ack_pending: 1,
    });
  }

  async start(): Promise<void> {
    if (this.#task !== undefined) return;
    await this.initialize();
    const consumer = await this.#jetstream.consumers.get(URGENT_NATS.stream, URGENT_NATS.durable);
    this.#messages = await consumer.consume({ max_messages: 1 });
    this.#task = this.#consume(this.#messages);
  }

  async stop(): Promise<void> {
    await this.#messages?.close();
    await this.#task;
    this.#messages = undefined;
    this.#task = undefined;
  }

  async #consume(messages: ConsumerMessages): Promise<void> {
    for await (const message of messages) {
      await this.handle(message);
    }
  }

  async handle(message: UrgentConsumableMessage): Promise<void> {
    let input: unknown;
    try {
      input = message.json<unknown>();
    } catch {
      await this.#publishDlq(undefined, "URGENT_EVENT_INVALID_JSON", message.info.deliveryCount);
      message.ack();
      return;
    }
    try {
      const result = await this.#processor.process(input);
      if (result.disposition === "REJECTED") {
        await this.#publishDlq(input, "URGENT_EVENT_REJECTED", message.info.deliveryCount, result);
      }
      message.ack();
    } catch (error) {
      if (
        error instanceof UrgentEventTransientError &&
        message.info.deliveryCount < this.#maxDeliver
      ) {
        message.nak(error.retryDelayMs ?? this.#nakDelayMs);
        return;
      }
      await this.#publishDlq(
        input,
        error instanceof UrgentEventTransientError
          ? "URGENT_EVENT_REDELIVERY_EXHAUSTED"
          : "URGENT_EVENT_PERMANENT_FAILURE",
        message.info.deliveryCount,
      );
      message.ack();
    }
  }

  async #publishDlq(
    input: unknown,
    reasonCode: string,
    deliveryCount: number,
    result?: UrgentEventProcessingResult,
  ): Promise<void> {
    const identity = readRejectableEventIdentity(input);
    const safe = Object.freeze({
      reasonCode,
      deliveryCount,
      originalSubject: URGENT_NATS.urgentSubject,
      eventId: result?.invalidEventId ?? identity?.eventId ?? null,
      eventType: identity?.eventType ?? null,
      vehicleId: identity?.vehicleId ?? null,
      receivedAt: identity?.receivedAt ?? null,
    });
    await this.#jetstream.publish(URGENT_NATS.dlqSubject, encoder.encode(JSON.stringify(safe)));
  }
}
