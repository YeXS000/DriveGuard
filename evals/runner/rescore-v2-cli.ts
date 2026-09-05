import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { buildNativeDatasetV2 } from "../native/datasets/v2.js";
import { buildNativeDataset } from "../native/scenarios/catalog.js";
import { renderNativeV2Report } from "../reports/native-v2-report.js";
import {
  rescoreNativeBenchmarkReportV2,
  rescoreNativeBenchmarkReportV2_1,
} from "../reports/native-v2-rescore.js";
import type { NativeBenchmarkReportV2 } from "./native-v2-runner.js";

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const inputText = valueAfter(args, "--input");
  if (inputText === undefined) throw new Error("--input is required");
  const scorer = valueAfter(args, "--scorer") ?? "v2";
  if (scorer !== "v2" && scorer !== "v2.1") throw new Error("--scorer is invalid");
  const input = resolve(process.cwd(), inputText);
  const outputDir = resolve(process.cwd(), valueAfter(args, "--output-dir") ?? dirname(input));
  const source = JSON.parse(await readFile(input, "utf8")) as NativeBenchmarkReportV2;
  const contracts = buildNativeDatasetV2(buildNativeDataset());
  const report =
    scorer === "v2.1"
      ? rescoreNativeBenchmarkReportV2_1(source, contracts)
      : rescoreNativeBenchmarkReportV2(source, contracts);
  await mkdir(outputDir, { recursive: true });
  const jsonPath = resolve(outputDir, "native-v2.json");
  const markdownPath = resolve(outputDir, "native-v2.md");
  const jsonTemporary = `${jsonPath}.tmp`;
  const markdownTemporary = `${markdownPath}.tmp`;
  await writeFile(jsonTemporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownTemporary, renderNativeV2Report(report), "utf8");
  await rename(jsonTemporary, jsonPath);
  await rename(markdownTemporary, markdownPath);
  process.stdout.write(
    `${JSON.stringify({ runId: report.benchmarkRunId, scorerVersion: report.scorerVersion, metrics: report.metrics })}\n`,
  );
}

await main();
