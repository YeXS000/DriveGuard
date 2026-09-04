import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildNativeDatasetV2 } from "../native/datasets/v2.js";
import { validateNativeDatasetV2 } from "../native/datasets/v2-validator.js";
import { buildNativeDataset } from "../native/scenarios/catalog.js";
import { createNativeSplitManifest } from "../native/split.js";
import { renderNativeV2Report } from "../reports/native-v2-report.js";
import { createNativeLiveHarness } from "./live-provider.js";
import { runNativeBenchmarkV2 } from "./native-v2-runner.js";

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("Expected a positive integer");
  return parsed;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = valueAfter(args, "--mode") ?? "deterministic";
  const profile = valueAfter(args, "--profile") ?? "quality";
  const partition = valueAfter(args, "--partition") ?? "all";
  if (mode !== "deterministic" && mode !== "live") throw new Error("--mode is invalid");
  if (profile !== "quality" && profile !== "latency") throw new Error("--profile is invalid");
  if (partition !== "all" && partition !== "development" && partition !== "holdout") {
    throw new Error("--partition is invalid");
  }
  const defaultConcurrency = profile === "latency" ? 1 : 4;
  const concurrency = positiveInteger(valueAfter(args, "--concurrency"), defaultConcurrency);
  const limitText = valueAfter(args, "--limit");
  const limit = limitText === undefined ? undefined : positiveInteger(limitText, 1);
  const outputDir = resolve(
    process.cwd(),
    valueAfter(args, "--output-dir") ?? "13.1-evaluation-calibration-scorer-v2/reports/native-v2",
  );
  const source = buildNativeDataset();
  const contracts = buildNativeDatasetV2(source);
  const validation = validateNativeDatasetV2(contracts);
  if (!validation.valid) throw new Error(`V2 dataset invalid: ${validation.errors.join("; ")}`);
  if (args.includes("--write-dataset")) {
    await writeFile(
      resolve(process.cwd(), "evals/native/datasets/driveguard-eval-v2.json"),
      `${JSON.stringify(contracts, null, 2)}\n`,
      "utf8",
    );
  }
  const datasetBytes = await readFile(
    resolve(process.cwd(), "evals/native/datasets/driveguard-eval-v2.json"),
  );
  const manifest = createNativeSplitManifest(
    contracts,
    createHash("sha256").update(datasetBytes).digest("hex"),
  );
  const selectedIds =
    partition === "all"
      ? undefined
      : new Set(
          partition === "development" ? manifest.development.caseIds : manifest.holdout.caseIds,
        );
  const paired = source
    .map((item, index) => ({ source: item, contract: contracts[index]! }))
    .filter(({ source: item }) => selectedIds === undefined || selectedIds.has(item.caseId));
  const limited = limit === undefined ? paired : paired.slice(0, limit);
  const selectedSource = limited.map(({ source: item }) => item);
  const selectedContracts = limited.map(({ contract }) => contract);
  const liveHarness = mode === "live" ? await createNativeLiveHarness() : undefined;
  let report;
  try {
    report = await runNativeBenchmarkV2({
      sourceCases: selectedSource,
      cases: selectedContracts,
      mode,
      profile,
      concurrency,
      gitCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      worktreeDirty:
        execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
      benchmarkRunPrefix: partition === "all" ? "phase13.1" : "phase13.2",
      ...(liveHarness === undefined ? {} : { executeLiveCase: liveHarness.execute }),
    });
  } finally {
    await liveHarness?.close();
  }
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    resolve(outputDir, "native-v2.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  await writeFile(resolve(outputDir, "native-v2.md"), renderNativeV2Report(report), "utf8");
  process.stdout.write(
    `${JSON.stringify({ runId: report.benchmarkRunId, partition, cases: report.caseCount, concurrency, metrics: report.metrics })}\n`,
  );
}

await main();
