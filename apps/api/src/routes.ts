import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import { Type, type Static } from "typebox";
import { toUtcTimestamp } from "@driveguard/domain";

import { ApiError } from "./errors.js";
import { publicEvent, type PublicRunEvent } from "./events.js";
import {
  type RequestAuthentication,
  identityForPrincipal,
  trustedPrincipal,
} from "./authentication.js";
import { DriveGuardApiService, type DevelopmentIdentity } from "./service.js";
import { requestTraceId } from "./request-observability.js";

const safeId = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
});
const sessionParamsSchema = Type.Object({ sessionId: safeId }, { additionalProperties: false });
const actionParamsSchema = Type.Object({ actionId: safeId }, { additionalProperties: false });
const executionParamsSchema = Type.Object({ executionId: safeId }, { additionalProperties: false });
const sessionBodySchema = Type.Object(
  { sessionId: Type.Optional(safeId), vehicleId: Type.Optional(safeId) },
  { additionalProperties: false },
);
const messageBodySchema = Type.Object(
  { prompt: Type.String({ minLength: 1, maxLength: 32_000 }) },
  { additionalProperties: false },
);
const actionBodySchema = Type.Object(
  { sessionId: safeId, vehicleId: Type.Optional(safeId) },
  { additionalProperties: false },
);
const confirmBodySchema = Type.Object(
  {
    sessionId: safeId,
    confirmationCredential: Type.String({ minLength: 8, maxLength: 1_024 }),
    vehicleId: Type.Optional(safeId),
  },
  { additionalProperties: false },
);
const dataResponseSchema = Type.Object({ data: Type.Any() }, { additionalProperties: false });
const vehicleQuerySchema = Type.Object(
  { vehicleId: Type.Optional(safeId) },
  { additionalProperties: false },
);

type SessionParams = Static<typeof sessionParamsSchema>;
type ActionParams = Static<typeof actionParamsSchema>;
type ExecutionParams = Static<typeof executionParamsSchema>;
type SessionBody = Static<typeof sessionBodySchema>;
type MessageBody = Static<typeof messageBodySchema>;
type ActionBody = Static<typeof actionBodySchema>;
type ConfirmBody = Static<typeof confirmBodySchema>;
type VehicleQuery = Static<typeof vehicleQuerySchema>;

function identity(request: FastifyRequest, vehicleId: string | undefined): DevelopmentIdentity {
  const principal = trustedPrincipal(request);
  return Object.freeze({
    ...identityForPrincipal(principal, vehicleId),
    identityBoundary: principal.identityBoundary,
  });
}

function writeSse(raw: NodeJS.WritableStream, event: PublicRunEvent): void {
  raw.write(`id: ${event.event_id}\n`);
  raw.write(`event: ${event.event_type}\n`);
  raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function registerPhase10Routes(
  app: FastifyInstance,
  service: DriveGuardApiService,
  authentication: Pick<RequestAuthentication, "identityBoundary">,
): void {
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/v1/")) {
      void reply.header("x-driveguard-identity-boundary", authentication.identityBoundary);
    }
    return payload;
  });

  app.post<{ Body: SessionBody }>(
    "/v1/sessions",
    {
      schema: {
        body: sessionBodySchema,
        response: { 200: dataResponseSchema },
      },
    },
    async (request) => ({
      data: await service.createSession(
        identity(request, request.body.vehicleId),
        request.body.sessionId,
      ),
    }),
  );

  app.get<{ Params: SessionParams; Querystring: VehicleQuery }>(
    "/v1/sessions/:sessionId",
    {
      schema: {
        params: sessionParamsSchema,
        querystring: vehicleQuerySchema,
        response: { 200: dataResponseSchema },
      },
    },
    async (request) => ({
      data: await service.getSession(
        request.params.sessionId,
        identity(request, request.query.vehicleId),
      ),
    }),
  );

  app.get<{ Querystring: VehicleQuery }>(
    "/v1/context",
    {
      schema: {
        querystring: vehicleQuerySchema,
        response: { 200: dataResponseSchema },
      },
    },
    async (request) => ({
      data: await service.getVehicleContext(identity(request, request.query.vehicleId)),
    }),
  );

  app.post<{ Params: SessionParams; Querystring: VehicleQuery; Body: MessageBody }>(
    "/v1/sessions/:sessionId/messages",
    {
      schema: {
        params: sessionParamsSchema,
        querystring: vehicleQuerySchema,
        body: messageBodySchema,
        response: { 200: dataResponseSchema },
      },
    },
    async (request) => {
      const traceId = requestTraceId(request);
      const result = await service.sendMessage({
        sessionId: request.params.sessionId,
        prompt: request.body.prompt,
        identity: identity(request, request.query.vehicleId),
        ...(traceId === undefined ? {} : { traceId }),
      });
      const failure = service.failureFor(result);
      if (failure !== undefined) throw failure;
      return { data: result };
    },
  );

  app.post<{ Params: SessionParams; Querystring: VehicleQuery; Body: MessageBody }>(
    "/v1/sessions/:sessionId/messages/stream",
    {
      schema: {
        params: sessionParamsSchema,
        querystring: vehicleQuerySchema,
        body: messageBodySchema,
      },
    },
    async (request, reply) => {
      const requestIdentity = identity(request, request.query.vehicleId);
      const sessionId = request.params.sessionId;
      const traceId = requestTraceId(request);
      let settled = false;
      let closed = false;
      const onClose = (): void => {
        closed = true;
        if (!settled) service.cancelSession(sessionId);
      };
      reply.raw.once("close", onClose);
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        "x-driveguard-identity-boundary": authentication.identityBoundary,
      });
      reply.raw.flushHeaders();
      try {
        await service.sendMessage({
          sessionId,
          prompt: request.body.prompt,
          identity: requestIdentity,
          ...(traceId === undefined ? {} : { traceId }),
          emit: (event) => {
            if (!closed) writeSse(reply.raw, event);
          },
        });
      } catch (error) {
        if (!closed) {
          const code = error instanceof ApiError ? error.code : "INTERNAL_ERROR";
          writeSse(
            reply.raw,
            publicEvent({
              eventType: "run.failed",
              runId: `run:${randomUUID()}`,
              traceId: traceId ?? `trace:${randomUUID()}`,
              timestamp: toUtcTimestamp(Date.now()),
              data: { code },
            }),
          );
        }
      } finally {
        settled = true;
        reply.raw.removeListener("close", onClose);
        if (!closed) reply.raw.end();
      }
    },
  );

  app.get<{ Params: ActionParams; Querystring: VehicleQuery }>(
    "/v1/actions/:actionId",
    {
      schema: {
        params: actionParamsSchema,
        querystring: vehicleQuerySchema,
        response: { 200: dataResponseSchema },
      },
    },
    async (request) => ({
      data: await service.getAction(
        request.params.actionId,
        identity(request, request.query.vehicleId),
      ),
    }),
  );

  app.post<{ Params: ActionParams; Body: ConfirmBody }>(
    "/v1/actions/:actionId/confirm",
    {
      schema: {
        params: actionParamsSchema,
        body: confirmBodySchema,
        response: { 200: dataResponseSchema },
      },
    },
    async (request) => ({
      data: await service.confirmAction({
        actionId: request.params.actionId,
        sessionId: request.body.sessionId,
        confirmationCredential: request.body.confirmationCredential,
        identity: identity(request, request.body.vehicleId),
      }),
    }),
  );

  for (const operation of ["reject", "cancel"] as const) {
    app.post<{ Params: ActionParams; Body: ActionBody }>(
      `/v1/actions/:actionId/${operation}`,
      {
        schema: {
          params: actionParamsSchema,
          body: actionBodySchema,
          response: { 200: dataResponseSchema },
        },
      },
      async (request) => ({
        data:
          operation === "reject"
            ? await service.rejectAction(
                request.params.actionId,
                request.body.sessionId,
                identity(request, request.body.vehicleId),
              )
            : await service.cancelAction(
                request.params.actionId,
                request.body.sessionId,
                identity(request, request.body.vehicleId),
              ),
      }),
    );
  }

  app.get<{ Params: ExecutionParams; Querystring: VehicleQuery }>(
    "/v1/executions/:executionId",
    {
      schema: {
        params: executionParamsSchema,
        querystring: vehicleQuerySchema,
        response: { 200: dataResponseSchema },
      },
    },
    async (request) => ({
      data: await service.getExecution(
        request.params.executionId,
        identity(request, request.query.vehicleId),
      ),
    }),
  );
}
