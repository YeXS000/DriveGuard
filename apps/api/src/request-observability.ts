import type { FastifyRequest } from "fastify";
import type { HttpRequestObservation } from "@driveguard/observability";

const observations = new WeakMap<FastifyRequest, HttpRequestObservation>();
const errorCodes = new WeakMap<FastifyRequest, string>();

export function setRequestObservation(
  request: FastifyRequest,
  observation: HttpRequestObservation,
): void {
  observations.set(request, observation);
}

export function requestTraceId(request: FastifyRequest): string | undefined {
  return observations.get(request)?.traceId;
}

export function setRequestErrorCode(request: FastifyRequest, errorCode: string): void {
  errorCodes.set(request, errorCode);
}

export function finishRequestObservation(request: FastifyRequest, statusCode: number): void {
  const observation = observations.get(request);
  if (observation === undefined) return;
  const errorCode = errorCodes.get(request);
  observation.end({
    statusCode,
    method: request.method,
    route: request.routeOptions.url ?? "unmatched",
    ...(errorCode === undefined ? {} : { errorCode }),
  });
  observations.delete(request);
  errorCodes.delete(request);
}
