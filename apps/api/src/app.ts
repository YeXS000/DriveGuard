import Fastify, { type FastifyInstance } from "fastify";

import { assessReadiness, type DependencyProbe } from "./health.js";
import { ApiError } from "./errors.js";
import { registerPhase10Routes } from "./routes.js";
import type { DriveGuardApiService } from "./service.js";

export interface BuildApiOptions {
  readonly dependencies?: readonly DependencyProbe[];
  readonly dependencyTimeoutMs?: number;
  readonly logger?: boolean;
  readonly service?: DriveGuardApiService;
  readonly onClose?: () => void | Promise<void>;
}

const liveResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { const: "ok" },
  },
} as const;

const readyResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "dependencies"],
  properties: {
    status: { enum: ["ready", "not_ready"] },
    dependencies: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "status"],
        properties: {
          name: { type: "string" },
          status: { enum: ["up", "down"] },
        },
      },
    },
  },
} as const;

export function buildApi(options: BuildApiOptions = {}): FastifyInstance {
  const dependencies = options.dependencies ?? [];
  const dependencyTimeoutMs = options.dependencyTimeoutMs ?? 2_000;
  const app = Fastify({
    logger: options.logger ?? false,
    ajv: {
      customOptions: {
        coerceTypes: false,
        removeAdditional: false,
      },
    },
  });

  app.get(
    "/health/live",
    {
      schema: {
        response: { 200: liveResponseSchema },
      },
    },
    () => ({ status: "ok" as const }),
  );

  app.get(
    "/health/ready",
    {
      schema: {
        response: {
          200: readyResponseSchema,
          503: readyResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const assessment = await assessReadiness(dependencies, dependencyTimeoutMs);
      const status = assessment.ready ? "ready" : "not_ready";

      return reply.code(assessment.ready ? 200 : 503).send({
        status,
        dependencies: assessment.dependencies,
      });
    },
  );

  app.addHook("onClose", async () => {
    await Promise.allSettled(
      dependencies.map(async (dependency) => {
        await dependency.close?.();
      }),
    );
    await options.onClose?.();
  });

  if (options.service !== undefined) registerPhase10Routes(app, options.service);

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: "VALIDATION_ERROR", message: "Route was not found" } }),
  );

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "validation" in error &&
      error.validation !== undefined
    ) {
      return reply.code(400).send({
        error: { code: "VALIDATION_ERROR", message: "Request validation failed" },
      });
    }
    return reply.code(500).send({
      error: { code: "INTERNAL_ERROR", message: "The request failed safely" },
    });
  });

  return app;
}
