import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { NATIVE_CATEGORIES, type BenchmarkMode, type NativeCategory } from "../native/types.js";
import { buildNativeDataset } from "../native/scenarios/catalog.js";
import { validateNativeDataset } from "../native/datasets/validator.js";
import { renderNativeReport } from "../reports/native-report.js";
import { createNativeLiveHarness } from "./live-provider.js";
import { runNativeBenchmark } from "./native-runner.js";

interface ParsedArgs {
  readonly track: "native" | "external";
  readonly mode: BenchmarkMode;
  readonly category?: NativeCategory;
  readonly caseId?: string;
  readonly limit?: number;
  readonly writeDataset: boolean;
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const track = valueAfter(args, "--track") ?? "native";
  const mode = valueAfter(args, "--mode") ?? "deterministic";
  const category = valueAfter(args, "--category");
  const caseId = valueAfter(args, "--case");
  const limitText = valueAfter(args, "--limit");
  if (track !== "native" && track !== "external")
    throw new Error("--track must be native or external");
  if (mode !== "deterministic" && mode !== "live")
    throw new Error("--mode must be deterministic or live");
  if (category !== undefined && !NATIVE_CATEGORIES.includes(category as NativeCategory)) {
    throw new Error("--category is invalid");
  }
  const limit = limitText === undefined ? undefined : Number(limitText);
  return {
    track,
    mode,
    ...(category === undefined ? {} : { category: category as NativeCategory }),
    ...(caseId === undefined ? {} : { caseId }),
    ...(limit === undefined ? {} : { limit }),
    writeDataset: args.includes("--write-dataset"),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.track === "external") {
    throw new Error(
      "External runs must use evals/external/car-bench/run_official.py so the official evaluator remains authoritative",
    );
  }
  const cases = buildNativeDataset();
  const validation = validateNativeDataset(cases);
  if (!validation.valid)
    throw new Error(`Dataset validation failed: ${validation.errors.join("; ")}`);
  const root = process.cwd();
  if (options.writeDataset) {
    await mkdir(resolve(root, "evals/native/datasets"), { recursive: true });
    await writeFile(
      resolve(root, "evals/native/datasets/driveguard-eval-v1.json"),
      `${JSON.stringify(cases, null, 2)}\n`,
      "utf8",
    );
  }
  const gitCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const liveHarness = options.mode === "live" ? await createNativeLiveHarness() : undefined;
  let report;
  try {
    report = await runNativeBenchmark({
      cases,
      mode: options.mode,
      gitCommit,
      ...(liveHarness === undefined ? {} : { executeLiveCase: liveHarness.execute }),
      ...(options.category === undefined ? {} : { category: options.category }),
      ...(options.caseId === undefined ? {} : { caseId: options.caseId }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
  } finally {
    await liveHarness?.close();
  }
  await mkdir(resolve(root, "evals/reports"), { recursive: true });
  await writeFile(
    resolve(root, "evals/reports/native-driveguard.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    resolve(root, "evals/reports/native-driveguard.md"),
    renderNativeReport(report),
    "utf8",
  );
  process.stdout.write(
    `${JSON.stringify({ runId: report.benchmarkRunId, cases: report.caseCount, metrics: report.metrics })}\n`,
  );
}

await main();
