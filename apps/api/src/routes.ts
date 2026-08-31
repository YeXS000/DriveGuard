import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import { Type, type Static } from "typebox";
import { toUtcTimestamp } from "@driveguard/domain";

import { ApiError } from "./errors.js";
import { publicEvent, type PublicRunEvent } from "./events.js";
import {
  DEVELOPMENT_IDENTITY_BOUNDARY,
  DriveGuardApiService,
  type DevelopmentIdentity,
} from "./service.js";

const safeId = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
});
const identityHeadersSchema = Type.Object({
  "x-driveguard-user-id": safeId,
  "x-driveguard-vehicle-id": safeId,
});
const sessionParamsSchema = Type.Object({ sessionId: safeId }, { additionalProperties: false });
const actionParamsSchema = Type.Object({ actionId: safeId }, { additionalProperties: false });
const executionParamsSchema = Type.Object({ executionId: safeId }, { additionalProperties: false });
const sessionBodySchema = Type.Object(
  { sessionId: Type.Optional(safeId) },
  { additionalProperties: false },
);
const messageBodySchema = Type.Object(
  { prompt: Type.String({ minLength: 1, maxLength: 32_000 }) },
  { additionalProperties: false },
);
const actionBodySchema = Type.Object({ sessionId: safeId }, { additionalProperties: false });
const confirmBodySchema = Type.Object(
  {
    sessionId: safeId,
    confirmationCredential: Type.String({ minLength: 8, maxLength: 1_024 }),
  },
  { additionalProperties: false },
);
const dataResponseSchema = Type.Object({ data: Type.Any() }, { additionalProperties: false });

type IdentityHeaders = Static<typeof identityHeadersSchema>;
type SessionParams = Static<typeof sessionParamsSchema>;
type ActionParams = Static<typeof actionParamsSchema>;
type ExecutionParams = Static<typeof executionParamsSchema>;
type SessionBody = Static<typeof sessionBodySchema>;
type MessageBody = Static<typeof messageBodySchema>;
type ActionBody = Static<typeof actionBodySchema>;
type ConfirmBody = Static<typeof confirmBodySchema>;

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

export function registerPhase10Routes(app: FastifyInstance, service: DriveGuardApiService): void {
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/v1/")) {
      void reply.header("x-driveguard-identity-boundary", DEVELOPMENT_IDENTITY_BOUNDARY);
    }
    return payload;
  });

  app.post<{ Headers: IdentityHeaders; Body: SessionBody }>(
    "/v1/sessions",
    {
      schema: {
        headers: identityHeadersSchema,
        body: sessionBodySchema,
        response: { 200: dataResponseSchema },
      },
    },
    async (request) => ({
      data: await service.createSession(identity(request), request.body.sessionId),
    }),
  );

  app.get<{ Headers: IdentityHeaders; Params: SessionParams }>(
    "/v1/sessions/:sessionId",
    {
      schema: {
        headers: identityHeadersSchema,
        params: sessionParamsSchema,
        response: { 200: dataResponseSchema },
      },
    },
    async (request) => ({
      data: await service.getSession(request.params.sessionId, identity(request)),
    }),
  );

  app.post<{ Headers: IdentityHeaders; Params: SessionParams; Body: MessageBody }>(
    "/v1/sessions/:sessionId/messages",
    {
      schema: {
        headers: identityHeadersSchema,
        params: sessionParamsSchema,
        body: messageBodySchema,
        response: { 200: dataResponseSchema },
      },
    },
    async (request) => {
      const result = await service.sendMessage({
        sessionId: request.params.sessionId,
        prompt: request.body.prompt,
        identity: identity(request),
      });
      const failure = service.failureFor(result);
      if (failure !== undefined) throw failure;
      return { data: result };
    },
  );

  app.post<{ Headers: IdentityHeaders; Params: SessionParams; Body: MessageBody }>(
    "/v1/sessions/:sessionId/messages/stream",
    {
      schema: {
        headers: identityHeadersSchema,
        params: sessionParamsSchema,
        body: messageBodySchema,
      },
    },
    async (request, reply) => {
      const requestIdentity = identity(request);
      const sessionId = request.params.sessionId;
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
        "x-driveguard-identity-boundary": DEVELOPMENT_IDENTITY_BOUNDARY,
      });
      reply.raw.flushHeaders();
      try {
        await service.sendMessage({
          sessionId,
          prompt: request.body.prompt,
          identity: requestIdentity,
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
              traceId: `trace:${randomUUID()}`,
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

  app.get<{ Headers: IdentityHeaders; Params: ActionParams }>(
    "/v1/actions/:actionId",
    {
      schema: {
        headers: identityHeadersSchema,
        params: actionParamsSchema,
        response: { 200: dataResponseSchema },
      },
    },
    async (request) => ({
      data: await service.getAction(request.params.actionId, identity(request)),
    }),
  );

  app.post<{ Headers: IdentityHeaders; Params: ActionParams; Body: ConfirmBody }>(
    "/v1/actions/:actionId/confirm",
    {
      schema: {
        headers: identityHeadersSchema,
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
        identity: identity(request),
      }),
    }),
  );

  for (const operation of ["reject", "cancel"] as const) {
    app.post<{ Headers: IdentityHeaders; Params: ActionParams; Body: ActionBody }>(
      `/v1/actions/:actionId/${operation}`,
      {
        schema: {
          headers: identityHeadersSchema,
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
                identity(request),
              )
            : await service.cancelAction(
                request.params.actionId,
                request.body.sessionId,
                identity(request),
              ),
      }),
    );
  }

  app.get<{ Headers: IdentityHeaders; Params: ExecutionParams }>(
    "/v1/executions/:executionId",
    {
      schema: {
        headers: identityHeadersSchema,
        params: executionParamsSchema,
        response: { 200: dataResponseSchema },
      },
    },
    async (request) => ({
      data: await service.getExecution(request.params.executionId, identity(request)),
    }),
  );
}
