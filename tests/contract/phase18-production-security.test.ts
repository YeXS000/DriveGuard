import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { assertProductionSecurityConfiguration } from "../../apps/api/src/production-security.js";

const root = process.cwd();

async function source(path: string): Promise<string> {
  return readFile(resolve(root, path), "utf8");
}

describe("Phase 18 production security boundary", () => {
  it("keeps the only production host publication at the HMI gateway", async () => {
    const compose = await source("docker-compose.production.yml");
    for (const service of [
      "postgres",
      "redis",
      "nats",
      "api",
      "vehicle-simulator",
      "prometheus",
      "grafana",
    ]) {
      expect(compose).toContain(`${service}:\n    ports: !override []`);
    }
    expect(compose).toContain("DRIVEGUARD_HMI_BIND_ADDRESS");
    expect(compose).toContain("networks: !override [edge, application]");
    expect(compose).toContain("internal: true");
  });

  it("applies a minimal non-privileged runtime profile to every production service", async () => {
    const compose = await source("docker-compose.production.yml");
    for (const service of [
      "postgres",
      "redis",
      "nats",
      "persistence-migrate",
      "vehicle-simulator",
      "api",
      "hmi",
      "prometheus",
      "grafana",
    ]) {
      const section = compose.slice(compose.indexOf(`  ${service}:`));
      expect(section).toContain("read_only: true");
      expect(section).toContain("cap_drop: [ALL]");
      expect(section).toContain("no-new-privileges:true");
      expect(section).toContain("privileged: false");
    }
  });

  it("uses isolated, CHOWN-only one-shot volume initialization before non-root runtimes", async () => {
    const compose = await source("docker-compose.production.yml");
    for (const [service, volume, identity, capabilities] of [
      ["postgres-volume-init", "postgres-data", "70:70", "[CHOWN, FOWNER]"],
      ["redis-volume-init", "redis-data", "999:1000", "[CHOWN, FOWNER, DAC_OVERRIDE]"],
      ["nats-volume-init", "nats-data", "1000:1000", "[CHOWN]"],
    ]) {
      const section = compose.slice(compose.indexOf(`  ${service}:`));
      expect(section).toContain(`- ${volume}:`);
      expect(section).toContain("network_mode: none");
      expect(section).toContain("read_only: true");
      expect(section).toContain("cap_drop: [ALL]");
      expect(section).toContain(`cap_add: ${capabilities}`);
      expect(section).toContain("privileged: false");
      expect(section).toContain(`chown ${identity}`);
    }
    expect(compose).toContain('user: "70:70"');
    expect(compose).toContain('user: "999:1000"');
    expect(compose).toContain('user: "1000:1000"');
    expect(compose).toContain("/var/run/postgresql:uid=70,gid=70,mode=3775");
    expect(compose).not.toContain("cap_add: [ALL]");
  });

  it("requires an explicit production JWT configuration before startup", () => {
    expect(() =>
      assertProductionSecurityConfiguration({ DRIVEGUARD_DEPLOYMENT_ENV: "production" }),
    ).toThrow(/DRIVEGUARD_AUTH_MODE/u);
    expect(() =>
      assertProductionSecurityConfiguration({
        DRIVEGUARD_DEPLOYMENT_ENV: "production",
        DRIVEGUARD_AUTH_MODE: "jwt",
      }),
    ).toThrow(/DRIVEGUARD_AUTH_ISSUER/u);
    expect(() =>
      assertProductionSecurityConfiguration({ DRIVEGUARD_DEPLOYMENT_ENV: "staging" }),
    ).not.toThrow();
  });

  it("marks all production secrets as deployment supplied placeholders", async () => {
    const example = await source(".env.production.example");
    expect(example).not.toMatch(/(?:api[_-]?key|password|secret)=((?!replace-with).){16,}/iu);
    expect(example).toContain("DEEPSEEK_API_KEY=replace-with-deployment-secret");
    expect(example).toContain("DRIVEGUARD_AUTH_MODE=jwt");
    expect(example).toContain("DRIVEGUARD_AUTH_JWKS_URL=");
  });

  it("declares the complete fail-closed JWT contract in production Compose", async () => {
    const compose = await source("docker-compose.production.yml");
    for (const name of [
      "DRIVEGUARD_AUTH_MODE: jwt",
      "DRIVEGUARD_AUTH_ISSUER",
      "DRIVEGUARD_AUTH_AUDIENCE",
      "DRIVEGUARD_AUTH_JWKS_URL",
      "DRIVEGUARD_AUTH_ALLOWED_ALGORITHMS",
      "DRIVEGUARD_AUTH_VEHICLE_CLAIM",
    ]) {
      expect(compose).toContain(name);
    }
  });
});
