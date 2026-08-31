import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import { Type, type Static } from "typebox";
import type {
  UrgentEventNotification,
  UrgentEventNotificationHub,
  UrgentEventRepository,
  UrgentEventRecord,
} from "@driveguard/urgent-events";

import { ApiError } from "./errors.js";
import { publicEvent, type PublicRunEvent } from "./events.js";
import { DEVELOPMENT_IDENTITY_BOUNDARY, type DevelopmentIdentity } from "./service.js";

const safeId = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
});
const identityHeadersSchema = Type.Object({
  "x-driveguard-user-id": safeId,
  "x-driveguard-vehicle-id": safeId,
});
const eventParamsSchema = Type.Object({ eventId: safeId }, { additionalProperties: false });
const dataResponseSchema = Type.Object({ data: Type.Any() }, { additionalProperties: false });

type IdentityHeaders = Static<typeof identityHeadersSchema>;
type EventParams = Static<typeof eventParamsSchema>;

function identity(request: FastifyRequest<{ Headers: IdentityHeaders }>): DevelopmentIdentity {
  return Object.freeze({
    userId: request.headers["x-driveguard-user-id"],
    vehicleId: request.headers["x-driveguard-vehicle-id"],
  });
}

function writeSse(raw: NodeJS.WritableStream, event: PublicRunEvent): void {
  raw.write(`id: ${event.event_id}\n`);
  raw.write(`event: ${event.event_type}\n`);
  raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

function eventView(record: UrgentEventRecord): Readonly<Record<string, unknown>> {
  return Object.freeze({
    eventId: record.eventId,
    eventType: record.eventType,
    vehicleId: record.vehicleId,
    severity: record.severity,
    status: record.status,
    receivedAt: record.receivedAt,
    processedAt: record.processedAt,
    safeSummary: record.result.safeSummary,
    requiresConfirmation: record.result.requiresConfirmation ?? false,
    actionId: record.result.actionId ?? null,
    executionId: record.result.executionId ?? null,
    tool: record.result.toolName ?? null,
  });
}

function notificationEvent(notification: UrgentEventNotification): PublicRunEvent {
  return publicEvent({
    eventId: notification.notificationId,
    eventType: notification.notificationType,
    runId: notification.runId,
    traceId: notification.traceId,
    timestamp: notification.timestamp,
    data: {
      event_id: notification.eventId,
      event_type: notification.eventType,
      severity: notification.severity,
      status: notification.status,
      summary: notification.safeSummary,
      requires_confirmation: notification.notificationType === "urgent.confirmation_required",
      ...(notification.actionId === undefined ? {} : { action_id: notification.actionId }),
      ...(notification.sessionId === undefined ? {} : { session_id: notification.sessionId }),
      ...(notification.toolName === undefined ? {} : { tool: notification.toolName }),
      ...(notification.riskLevel === undefined ? {} : { risk_level: notification.riskLevel }),
      ...(notification.expiresAt === undefined ? {} : { expires_at: notification.expiresAt }),
      ...(notification.confirmationCredential === undefined
        ? {}
        : { confirmation_credential: notification.confirmationCredential }),
      parameters: {},
    },
  });
}

export class UrgentApiService {
  readonly #repository: UrgentEventRepository;
  readonly #hub: UrgentEventNotificationHub;
  readonly #userId: string;

  constructor(options: {
    readonly repository: UrgentEventRepository;
    readonly hub: UrgentEventNotificationHub;
    readonly userId: string;
  }) {
    this.#repository = options.repository;
    this.#hub = options.hub;
    this.#userId = options.userId;
  }

  async get(eventId: string, requestIdentity: DevelopmentIdentity) {
    this.#requireUser(requestIdentity);
    const record = await this.#repository.get(eventId);
    if (record === undefined || record.vehicleId !== requestIdentity.vehicleId) {
      throw new ApiError("URGENT_EVENT_NOT_FOUND", "Urgent event was not found", 404);
    }
    return eventView(record);
  }

  async list(requestIdentity: DevelopmentIdentity) {
    this.#requireUser(requestIdentity);
    const records = await this.#repository.listByVehicle(requestIdentity.vehicleId, 50);
    return Object.freeze(records.map(eventView));
  }

  subscribe(
    requestIdentity: DevelopmentIdentity,
    listener: (event: PublicRunEvent) => void,
  ): () => void {
    this.#requireUser(requestIdentity);
    return this.#hub.subscribe((notification) => {
      if (
        notification.userId === requestIdentity.userId &&
        notification.vehicleId === requestIdentity.vehicleId
      ) {
        listener(notificationEvent(notification));
      }
    });
  }

  #requireUser(identityValue: DevelopmentIdentity): void {
    if (identityValue.userId !== this.#userId) {
      throw new ApiError("URGENT_EVENT_NOT_FOUND", "Urgent event was not found", 404);
    }
  }
}

export function registerUrgentRoutes(app: FastifyInstance, service: UrgentApiService): void {
  app.get<{ Headers: IdentityHeaders }>(
    "/v1/urgent-events",
    {
      schema: { headers: identityHeadersSchema, response: { 200: dataResponseSchema } },
    },
    async (request) => ({ data: await service.list(identity(request)) }),
  );

  app.get<{ Headers: IdentityHeaders }>(
    "/v1/urgent-events/stream",
    { schema: { headers: identityHeadersSchema } },
    async (request, reply) => {
      const requestIdentity = identity(request);
      let closed = false;
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        "x-driveguard-identity-boundary": DEVELOPMENT_IDENTITY_BOUNDARY,
      });
      reply.raw.flushHeaders();
      const unsubscribe = service.subscribe(requestIdentity, (event) => {
        if (!closed) writeSse(reply.raw, event);
      });
      const heartbeat = setInterval(() => {
        if (!closed) reply.raw.write(`: heartbeat ${randomUUID()}\n\n`);
      }, 15_000);
      const onClose = (): void => {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
      };
      reply.raw.once("close", onClose);
    },
  );

  app.get<{ Headers: IdentityHeaders; Params: EventParams }>(
    "/v1/urgent-events/:eventId",
    {
      schema: {
        headers: identityHeadersSchema,
        params: eventParamsSchema,
        response: { 200: dataResponseSchema },
      },
    },
    async (request) => ({
      data: await service.get(request.params.eventId, identity(request)),
    }),
  );
}
