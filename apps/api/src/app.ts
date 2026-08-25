import Fastify, { type FastifyInstance } from "fastify";

import { assessReadiness, type DependencyProbe } from "./health.js";

export interface BuildApiOptions {
  readonly dependencies?: readonly DependencyProbe[];
  readonly dependencyTimeoutMs?: number;
  readonly logger?: boolean;
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
  const app = Fastify({ logger: options.logger ?? false });

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
  });

  return app;
}
