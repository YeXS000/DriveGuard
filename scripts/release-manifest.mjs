import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function command(commandName, args) {
  return execFileSync(commandName, args, { encoding: "utf8" }).trim();
}

function immutableTag(value) {
  if (!/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error("DRIVEGUARD_IMAGE_TAG must be a full 40-character Git SHA");
  }
  return value;
}

function imageMetadata(name, tag) {
  const reference = `${name}:${tag}`;
  const image = { name, tag, reference, digest: "not-recorded", digestSource: "not-recorded" };
  if (process.env.DRIVEGUARD_CAPTURE_IMAGE_DIGESTS !== "1") return image;

  try {
    const dockerCommand = process.env.DRIVEGUARD_DOCKER_COMMAND ?? "docker";
    const inspected = JSON.parse(command(dockerCommand, ["image", "inspect", reference]))[0];
    const repositoryDigest = inspected?.RepoDigests?.[0];
    if (typeof repositoryDigest === "string" && repositoryDigest.includes("@sha256:")) {
      return { ...image, digest: repositoryDigest, digestSource: "repository" };
    }
    if (typeof inspected?.Id === "string" && inspected.Id.startsWith("sha256:")) {
      return { ...image, digest: inspected.Id, digestSource: "local-image-id" };
    }
    return image;
  } catch (error) {
    return {
      ...image,
      digest: "unavailable",
      digestSource: `inspect-failed:${error.code ?? "unknown"}`,
    };
  }
}

const output = resolve(process.env.DRIVEGUARD_RELEASE_MANIFEST ?? "release-manifest.json");
const gitSha = command("git", ["rev-parse", "HEAD"]);
const branch = command("git", ["branch", "--show-current"]);
const imageTag = immutableTag(process.env.DRIVEGUARD_IMAGE_TAG ?? gitSha);
const manifest = {
  schemaVersion: 2,
  gitSha,
  branch,
  buildTimestamp: new Date().toISOString(),
  nodeVersion: process.version,
  packageManager: `npm@${command("npm", ["--version"])}`,
  docker: {
    version: process.env.DRIVEGUARD_DOCKER_VERSION ?? "not-recorded",
    baseImages: [
      "node:22.23.2-trixie-slim@sha256:7b8a0c89c54499bee567618f96578e1a12a800f062fbdbfd1fb6a443fa6f6284",
      "postgres:17-alpine@sha256:ae8a26b5b27ef277b46284a0faa2f0059e36a0b40b4064e3353e1bbaaaa2b214",
      "redis:8-alpine@sha256:642d3031f9c79ebc20ccbb4dca457a30dd06725b2f40c10b1ec0e17df90a5697",
      "nats:2.11-alpine@sha256:8e9da4a39fad71bc91237fbe4cc68c2fefe7126c7608a0b3ee94f2084aacfd8c",
    ],
  },
  images: ["driveguard-api", "driveguard-simulator", "driveguard-hmi"].map((name) =>
    imageMetadata(name, imageTag),
  ),
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
