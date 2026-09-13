import { generateKeyPairSync, sign } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApi } from "../../apps/api/src/app.js";
import {
  createJwtAuthentication,
  readRequestAuthentication,
} from "../../apps/api/src/authentication.js";
import { createFakeApiHarness, fakeAction } from "../fixtures/phase10-api.js";

const issuer = "https://issuer.test/";
const audience = "driveguard-api";
const vehicleClaim = "authorized_vehicle_ids";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function token(
  overrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
): string {
  const now = Math.floor(Date.now() / 1_000);
  const header = base64url(
    JSON.stringify({ alg: "RS256", kid: "phase18.1-test", ...headerOverrides }),
  );
  const payload = base64url(
    JSON.stringify({
      iss: issuer,
      aud: audience,
      sub: "user:alice",
      nbf: now - 30,
      exp: now + 300,
      [vehicleClaim]: ["vehicle:alice"],
      ...overrides,
    }),
  );
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`, "utf8"),
    privateKey,
  ).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function authentication() {
  return createJwtAuthentication({
    issuer,
    audience,
    jwksUrl: "https://issuer.test/.well-known/jwks.json",
    allowedAlgorithms: ["RS256"],
    vehicleClaim,
    fetchFn: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ keys: [{ ...jwk, kid: "phase18.1-test", use: "sig", alg: "RS256" }] }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
  });
}

function bearer(value = token()): Record<string, string> {
  return { authorization: `Bearer ${value}` };
}

function tokenWithBadSignature(): string {
  const [header, payload, signature] = token().split(".");
  if (header === undefined || payload === undefined || signature === undefined) {
    throw new Error("test token did not have three segments");
  }
  const bytes = Buffer.from(signature, "base64url");
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  return `${header}.${payload}.${bytes.toString("base64url")}`;
}

describe("Phase 18.1 production JWT authentication boundary", () => {
  let app: FastifyInstance;
  let harness: ReturnType<typeof createFakeApiHarness>;

  beforeEach(async () => {
    harness = createFakeApiHarness();
    app = buildApi({ service: harness.service, authentication: authentication() });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("verifies a signed JWT and binds the requested authorized vehicle", async () => {
    const credential = token();
    expect(credential).toMatch(/^[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+$/u);
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: bearer(credential),
      payload: { sessionId: "session:alice", vehicleId: "vehicle:alice" },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["x-driveguard-identity-boundary"]).toBe("JWT_VERIFIED_PRINCIPAL");
    expect(response.json()).toMatchObject({
      data: {
        sessionId: "session:alice",
        userId: "user:alice",
        vehicleId: "vehicle:alice",
        identityBoundary: "JWT_VERIFIED_PRINCIPAL",
      },
    });
  });

  it.each([
    ["missing token", undefined],
    ["malformed token", "Bearer malformed"],
    ["bad signature", `Bearer ${tokenWithBadSignature()}`],
    ["expired token", `Bearer ${token({ exp: Math.floor(Date.now() / 1_000) - 1 })}`],
    ["not-yet-valid token", `Bearer ${token({ nbf: Math.floor(Date.now() / 1_000) + 60 })}`],
    ["wrong issuer", `Bearer ${token({ iss: "https://attacker.test/" })}`],
    ["wrong audience", `Bearer ${token({ aud: "other-api" })}`],
    ["missing subject", `Bearer ${token({ sub: undefined })}`],
    ["unsupported algorithm", `Bearer ${token({}, { alg: "none" })}`],
  ] as const)("rejects %s with a controlled 401", async (_name, authorization) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: authorization === undefined ? {} : { authorization },
      payload: { vehicleId: "vehicle:alice" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string; message: string } }>().error.code).toMatch(
      /^AUTHENTICATION_(?:REQUIRED|INVALID)$/u,
    );
    expect(response.body).not.toMatch(/(?:stack|private key|credential)/iu);
  });

  it("disables development identity headers and rejects unscoped vehicles", async () => {
    const headerResponse = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { ...bearer(), "x-driveguard-user-id": "user:attacker" },
      payload: { vehicleId: "vehicle:alice" },
    });
    expect(headerResponse.statusCode).toBe(401);

    const vehicleResponse = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: bearer(),
      payload: { vehicleId: "vehicle:attacker" },
    });
    expect(vehicleResponse.statusCode).toBe(403);
    expect(vehicleResponse.json()).toMatchObject({ error: { code: "VEHICLE_FORBIDDEN" } });
  });

  it("denies cross-user session access and confirmation before execution", async () => {
    const alice = token();
    const bob = token({ sub: "user:bob" });
    await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: bearer(alice),
      payload: { sessionId: "session:alice", vehicleId: "vehicle:alice" },
    });
    const crossSession = await app.inject({
      method: "GET",
      url: "/v1/sessions/session:alice?vehicleId=vehicle:alice",
      headers: bearer(bob),
    });
    expect(crossSession.statusCode).toBe(404);

    harness.factory.actions.set(
      "action:alice",
      fakeAction({
        actionId: "action:alice",
        sessionId: "session:alice",
        userId: "user:alice",
        vehicleId: "vehicle:alice",
      }),
    );
    const crossConfirm = await app.inject({
      method: "POST",
      url: "/v1/actions/action:alice/confirm",
      headers: bearer(bob),
      payload: {
        sessionId: "session:alice",
        vehicleId: "vehicle:alice",
        confirmationCredential: "credential:test",
      },
    });
    expect(crossConfirm.statusCode).toBe(404);
    expect(harness.factory.confirmCalls).toBe(0);
  });

  it("fails production startup configuration closed when any auth setting is absent", () => {
    expect(() =>
      readRequestAuthentication({
        DRIVEGUARD_DEPLOYMENT_ENV: "production",
        DRIVEGUARD_AUTH_MODE: "jwt",
      }),
    ).toThrow(/DRIVEGUARD_AUTH_ISSUER/u);
    expect(() =>
      readRequestAuthentication({
        DRIVEGUARD_DEPLOYMENT_ENV: "production",
        DRIVEGUARD_AUTH_MODE: "development",
      }),
    ).toThrow(/DRIVEGUARD_AUTH_MODE/u);
  });
});
