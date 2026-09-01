import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { buildNativeDatasetV2 } from "../native/datasets/v2.js";
import { buildNativeDataset } from "../native/scenarios/catalog.js";
import { renderNativeV2Report } from "../reports/native-v2-report.js";
import { rescoreNativeBenchmarkReportV2 } from "../reports/native-v2-rescore.js";
import type { NativeBenchmarkReportV2 } from "./native-v2-runner.js";

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const inputText = valueAfter(args, "--input");
  if (inputText === undefined) throw new Error("--input is required");
  const input = resolve(process.cwd(), inputText);
  const outputDir = resolve(process.cwd(), valueAfter(args, "--output-dir") ?? dirname(input));
  const source = JSON.parse(await readFile(input, "utf8")) as NativeBenchmarkReportV2;
  const report = rescoreNativeBenchmarkReportV2(source, buildNativeDatasetV2(buildNativeDataset()));
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
