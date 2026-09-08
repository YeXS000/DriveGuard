import { execFileSync } from "node:child_process";
const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const forbidden = paths.filter(
  (path) =>
    /^(?:_phase|DriveGuard_phase|artifacts)\//.test(path) || /^\d+(?:\.\d+)*-[^/]+\//.test(path),
);
if (forbidden.length > 0) {
  console.error(
    `Main integration tree contains ${forbidden.length} stage-only paths. Retain these on the phase branch and prepare a source-only integration commit.`,
  );
  process.exitCode = 1;
} else {
  console.log("PASS: main integration tree contains no tracked stage directories or artifacts.");
}
