import { webcrypto } from "node:crypto";

import type { FastifyRequest } from "fastify";

import { ApiError } from "./errors.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SUPPORTED_JWT_ALGORITHMS = ["RS256", "ES256"] as const;
const JWKS_CACHE_MS = 5 * 60_000;

type SupportedJwtAlgorithm = (typeof SUPPORTED_JWT_ALGORITHMS)[number];
type JsonRecord = Readonly<Record<string, unknown>>;

export const DEVELOPMENT_IDENTITY_BOUNDARY = "DEVELOPMENT_IDENTITY_BOUNDARY";
export const JWT_IDENTITY_BOUNDARY = "JWT_VERIFIED_PRINCIPAL";

export interface TrustedPrincipal {
  readonly subject: string;
  readonly userId: string;
  readonly authorizedVehicleIds: readonly string[];
  readonly authIssuer: string;
  readonly identityBoundary: typeof DEVELOPMENT_IDENTITY_BOUNDARY | typeof JWT_IDENTITY_BOUNDARY;
}

export interface RequestAuthentication {
  readonly identityBoundary: TrustedPrincipal["identityBoundary"];
  authenticate(
    headers: Readonly<Record<string, string | string[] | undefined>>,
  ): Promise<TrustedPrincipal>;
}

export interface JwtAuthenticationConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
  readonly allowedAlgorithms: readonly SupportedJwtAlgorithm[];
  readonly vehicleClaim: string;
  readonly fetchFn?: typeof fetch;
}

export interface VehicleAuthorizer {
  authorize(principal: TrustedPrincipal, vehicleId: string): boolean;
}

export const claimVehicleAuthorizer: VehicleAuthorizer = Object.freeze({
  authorize: (principal: TrustedPrincipal, vehicleId: string) =>
    principal.authorizedVehicleIds.includes(vehicleId),
});

declare module "fastify" {
  interface FastifyRequest {
    driveGuardPrincipal?: TrustedPrincipal;
  }
}

function stringHeader(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

function parseSafeId(value: string | undefined, field: string, statusCode: number): string {
  if (value === undefined || !SAFE_ID.test(value)) {
    throw new ApiError(
      statusCode === 400 ? "VALIDATION_ERROR" : "AUTHENTICATION_INVALID",
      statusCode === 400 ? "Request validation failed" : `Authentication ${field} is invalid`,
      statusCode,
    );
  }
  return value;
}

function jsonObject(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function decodeJson(segment: string): JsonRecord {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    const result = jsonObject(parsed);
    if (result === undefined) throw new Error("not an object");
    return result;
  } catch {
    throw new ApiError("AUTHENTICATION_INVALID", "Authentication token component is invalid", 401);
  }
}

function readRequiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function parseAllowedAlgorithms(value: string): readonly SupportedJwtAlgorithm[] {
  const algorithms = value
    .split(",")
    .map((algorithm) => algorithm.trim())
    .filter((algorithm) => algorithm.length > 0);
  if (
    algorithms.length === 0 ||
    algorithms.some(
      (algorithm): algorithm is string =>
        !SUPPORTED_JWT_ALGORITHMS.includes(algorithm as SupportedJwtAlgorithm),
    )
  ) {
    throw new Error("DRIVEGUARD_AUTH_ALLOWED_ALGORITHMS must contain only RS256 or ES256");
  }
  return Object.freeze(algorithms as SupportedJwtAlgorithm[]);
}

function requiredClaimVehicleIds(payload: JsonRecord, claim: string): readonly string[] {
  const value = payload[claim];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || !SAFE_ID.test(item))
  ) {
    throw new ApiError("AUTHENTICATION_INVALID", "Authentication vehicle scope is invalid", 401);
  }
  return Object.freeze([...new Set(value as string[])]);
}

function requiredNumericClaim(payload: JsonRecord, claim: "exp" | "nbf"): number {
  const value = payload[claim];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ApiError("AUTHENTICATION_INVALID", `Authentication ${claim} claim is invalid`, 401);
  }
  return value;
}

function audienceMatches(value: unknown, expected: string): boolean {
  return value === expected || (Array.isArray(value) && value.includes(expected));
}

export function createDevelopmentAuthentication(): RequestAuthentication {
  return Object.freeze({
    identityBoundary: DEVELOPMENT_IDENTITY_BOUNDARY,
    authenticate: (headers: Readonly<Record<string, string | string[] | undefined>>) => {
      const userId = parseSafeId(
        stringHeader(headers, "x-driveguard-user-id"),
        "user identity",
        400,
      );
      const vehicleId = parseSafeId(
        stringHeader(headers, "x-driveguard-vehicle-id"),
        "vehicle identity",
        400,
      );
      return Promise.resolve(
        Object.freeze({
          subject: userId,
          userId,
          authorizedVehicleIds: Object.freeze([vehicleId]),
          authIssuer: "development-header-boundary",
          identityBoundary: DEVELOPMENT_IDENTITY_BOUNDARY,
        }),
      );
    },
  });
}

export function createJwtAuthentication(config: JwtAuthenticationConfig): RequestAuthentication {
  const fetchFn = config.fetchFn ?? fetch;
  let cachedJwks: readonly JsonRecord[] | undefined;
  let cachedAt = 0;

  async function loadJwks(force = false): Promise<readonly JsonRecord[]> {
    if (cachedJwks === undefined || force || Date.now() - cachedAt >= JWKS_CACHE_MS) {
      let response: Response;
      try {
        response = await fetchFn(config.jwksUrl, { headers: { accept: "application/json" } });
      } catch {
        throw new ApiError(
          "AUTHENTICATION_INVALID",
          "Authentication key service is unavailable",
          401,
        );
      }
      if (!response.ok) {
        throw new ApiError(
          "AUTHENTICATION_INVALID",
          "Authentication key service is unavailable",
          401,
        );
      }
      const document = jsonObject(await response.json().catch(() => undefined));
      const keys = document?.keys;
      if (!Array.isArray(keys) || keys.some((key) => jsonObject(key) === undefined)) {
        throw new ApiError("AUTHENTICATION_INVALID", "Authentication key set is invalid", 401);
      }
      cachedJwks = keys as JsonRecord[];
      cachedAt = Date.now();
    }
    return cachedJwks;
  }

  async function keyFor(kid: string, algorithm: SupportedJwtAlgorithm): Promise<JsonRecord> {
    let key = (await loadJwks()).find((candidate) => candidate.kid === kid);
    if (key === undefined) key = (await loadJwks(true)).find((candidate) => candidate.kid === kid);
    if (
      key === undefined ||
      (key.alg !== undefined && key.alg !== algorithm) ||
      (key.use !== undefined && key.use !== "sig")
    ) {
      throw new ApiError("AUTHENTICATION_INVALID", "Authentication signing key is invalid", 401);
    }
    return key;
  }

  return Object.freeze({
    identityBoundary: JWT_IDENTITY_BOUNDARY,
    authenticate: async (headers: Readonly<Record<string, string | string[] | undefined>>) => {
      if (
        stringHeader(headers, "x-driveguard-user-id") !== undefined ||
        stringHeader(headers, "x-driveguard-vehicle-id") !== undefined
      ) {
        throw new ApiError(
          "AUTHENTICATION_INVALID",
          "Development identity headers are disabled",
          401,
        );
      }
      const authorization = stringHeader(headers, "authorization");
      if (authorization === undefined) {
        throw new ApiError("AUTHENTICATION_REQUIRED", "Bearer authentication is required", 401);
      }
      const [scheme, compactToken, unexpected] = authorization.trim().split(/\s+/u);
      const segments = compactToken?.split(".") ?? [];
      if (
        scheme?.toLowerCase() !== "bearer" ||
        unexpected !== undefined ||
        segments.length !== 3 ||
        segments.some((segment) => !/^[A-Za-z0-9_-]+$/u.test(segment))
      ) {
        throw new ApiError("AUTHENTICATION_INVALID", "Authentication token is malformed", 401);
      }
      const [encodedHeader, encodedPayload, encodedSignature] = segments;
      if (
        encodedHeader === undefined ||
        encodedPayload === undefined ||
        encodedSignature === undefined
      ) {
        throw new ApiError("AUTHENTICATION_INVALID", "Authentication token is malformed", 401);
      }
      const header = decodeJson(encodedHeader);
      const payload = decodeJson(encodedPayload);
      const algorithm = header.alg;
      const kid = header.kid;
      if (
        typeof algorithm !== "string" ||
        !config.allowedAlgorithms.includes(algorithm as SupportedJwtAlgorithm) ||
        typeof kid !== "string" ||
        kid.length === 0
      ) {
        throw new ApiError("AUTHENTICATION_INVALID", "Authentication token header is invalid", 401);
      }
      const supportedAlgorithm = algorithm as SupportedJwtAlgorithm;
      const key = await keyFor(kid, supportedAlgorithm);
      let verified: boolean;
      try {
        if (supportedAlgorithm === "RS256") {
          const cryptoKey = await webcrypto.subtle.importKey(
            "jwk",
            key as never,
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            false,
            ["verify"],
          );
          verified = await webcrypto.subtle.verify(
            { name: "RSASSA-PKCS1-v1_5" },
            cryptoKey,
            Buffer.from(encodedSignature, "base64url"),
            Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8"),
          );
        } else {
          const cryptoKey = await webcrypto.subtle.importKey(
            "jwk",
            key as never,
            { name: "ECDSA", namedCurve: "P-256" },
            false,
            ["verify"],
          );
          verified = await webcrypto.subtle.verify(
            { name: "ECDSA", hash: "SHA-256" },
            cryptoKey,
            Buffer.from(encodedSignature, "base64url"),
            Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8"),
          );
        }
      } catch {
        throw new ApiError("AUTHENTICATION_INVALID", "Authentication signature is invalid", 401);
      }
      if (!verified)
        throw new ApiError("AUTHENTICATION_INVALID", "Authentication signature is invalid", 401);
      const nowSeconds = Math.floor(Date.now() / 1_000);
      const expiresAt = requiredNumericClaim(payload, "exp");
      const notBefore = requiredNumericClaim(payload, "nbf");
      if (
        payload.iss !== config.issuer ||
        !audienceMatches(payload.aud, config.audience) ||
        expiresAt <= nowSeconds ||
        notBefore > nowSeconds
      ) {
        throw new ApiError("AUTHENTICATION_INVALID", "Authentication claims are invalid", 401);
      }
      const subject = parseSafeId(
        typeof payload.sub === "string" ? payload.sub : undefined,
        "subject",
        401,
      );
      return Object.freeze({
        subject,
        userId: subject,
        authorizedVehicleIds: requiredClaimVehicleIds(payload, config.vehicleClaim),
        authIssuer: config.issuer,
        identityBoundary: JWT_IDENTITY_BOUNDARY,
      });
    },
  });
}

export function readRequestAuthentication(
  environment: NodeJS.ProcessEnv = process.env,
): RequestAuthentication {
  const production = environment.DRIVEGUARD_DEPLOYMENT_ENV === "production";
  const mode = environment.DRIVEGUARD_AUTH_MODE ?? (production ? "" : "development");
  if (mode === "development" && !production) return createDevelopmentAuthentication();
  if (mode !== "jwt") {
    throw new Error("DRIVEGUARD_AUTH_MODE must be jwt in production");
  }
  return createJwtAuthentication({
    issuer: readRequiredEnvironment(environment, "DRIVEGUARD_AUTH_ISSUER"),
    audience: readRequiredEnvironment(environment, "DRIVEGUARD_AUTH_AUDIENCE"),
    jwksUrl: readRequiredEnvironment(environment, "DRIVEGUARD_AUTH_JWKS_URL"),
    allowedAlgorithms: parseAllowedAlgorithms(
      readRequiredEnvironment(environment, "DRIVEGUARD_AUTH_ALLOWED_ALGORITHMS"),
    ),
    vehicleClaim: readRequiredEnvironment(environment, "DRIVEGUARD_AUTH_VEHICLE_CLAIM"),
  });
}

export function trustedPrincipal(request: FastifyRequest): TrustedPrincipal {
  if (request.driveGuardPrincipal === undefined) {
    throw new ApiError("AUTHENTICATION_REQUIRED", "Bearer authentication is required", 401);
  }
  return request.driveGuardPrincipal;
}

export function identityForPrincipal(
  principal: TrustedPrincipal,
  vehicleId: string | undefined,
  authorizer: VehicleAuthorizer = claimVehicleAuthorizer,
): Readonly<{ userId: string; vehicleId: string }> {
  const selectedVehicleId =
    principal.identityBoundary === DEVELOPMENT_IDENTITY_BOUNDARY
      ? principal.authorizedVehicleIds[0]
      : parseSafeId(vehicleId, "vehicle", 403);
  if (selectedVehicleId === undefined || !authorizer.authorize(principal, selectedVehicleId)) {
    throw new ApiError("VEHICLE_FORBIDDEN", "Vehicle access is not authorized", 403);
  }
  return Object.freeze({ userId: principal.userId, vehicleId: selectedVehicleId });
}
