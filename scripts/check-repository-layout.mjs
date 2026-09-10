import { execFileSync } from "node:child_process";
const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const allowPhaseArtifacts = process.env.DRIVEGUARD_ALLOW_STAGE_ARTIFACTS === "1";
const forbidden = paths.filter(
  (path) =>
    /^(?:_phase|DriveGuard_phase)\//.test(path) ||
    /^\d+(?:\.\d+)*-[^/]+\//.test(path) ||
    (!allowPhaseArtifacts && /^artifacts\//.test(path)),
);
if (forbidden.length > 0) {
  console.error(
    `Integration tree contains ${forbidden.length} forbidden stage-only paths. Retain phase evidence under artifacts/ only on a phase branch, then prepare a source-only integration commit.`,
  );
  process.exitCode = 1;
} else {
  console.log(
    allowPhaseArtifacts
      ? "PASS: phase branch contains no forbidden root stage directories; retained artifacts are allowed."
      : "PASS: main integration tree contains no tracked stage directories or artifacts.",
  );
}
