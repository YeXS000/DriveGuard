import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function command(commandName, args) {
  return execFileSync(commandName, args, { encoding: "utf8" }).trim();
}

const output = resolve(process.env.DRIVEGUARD_RELEASE_MANIFEST ?? "release-manifest.json");
const gitSha = command("git", ["rev-parse", "HEAD"]);
const branch = command("git", ["branch", "--show-current"]);
const imageTag = process.env.DRIVEGUARD_IMAGE_TAG ?? gitSha;
const manifest = {
  schemaVersion: 1,
  gitSha,
  branch,
  buildTimestamp: new Date().toISOString(),
  nodeVersion: process.version,
  packageManager: `npm@${command("npm", ["--version"])}`,
  docker: {
    version: process.env.DRIVEGUARD_DOCKER_VERSION ?? "not-recorded",
    baseImages: [
      "node:22.22.1-bookworm-slim",
      "postgres:17-alpine@sha256:ae8a26b5b27ef277b46284a0faa2f0059e36a0b40b4064e3353e1bbaaaa2b214",
      "redis:8-alpine@sha256:642d3031f9c79ebc20ccbb4dca457a30dd06725b2f40c10b1ec0e17df90a5697",
      "nats:2.11-alpine@sha256:8e9da4a39fad71bc91237fbe4cc68c2fefe7126c7608a0b3ee94f2084aacfd8c",
    ],
  },
  images: ["driveguard-api", "driveguard-vehicle-simulator", "driveguard-hmi"].map((name) => ({
    name,
    tag: imageTag,
  })),
  validation: {
    tests: process.env.DRIVEGUARD_TEST_SUMMARY ?? "not-recorded",
    dockerBuild: process.env.DRIVEGUARD_DOCKER_BUILD_RESULT ?? "not-recorded",
    releaseSmoke: process.env.DRIVEGUARD_RELEASE_SMOKE_RESULT ?? "not-recorded",
  },
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o644,
});
process.stdout.write(`${output}\n`);
