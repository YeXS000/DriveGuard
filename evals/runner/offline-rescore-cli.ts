import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildNativeDatasetV2 } from "../native/datasets/v2.js";
import { buildNativeDataset } from "../native/scenarios/catalog.js";
import type { NativeBenchmarkReport } from "../native/types.js";
import type { NativeObservationV2 } from "../native/v2-types.js";
import { offlineRescore, renderOfflineRescore } from "../reports/offline-rescore.js";

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const root = process.cwd();
  const sourcePath = resolve(
    root,
    valueAfter(args, "--source") ?? "evals/reports/native-driveguard.json",
  );
  const outputDir = resolve(
    root,
    valueAfter(args, "--output-dir") ??
      "13.1-evaluation-calibration-scorer-v2/reports/offline-rescore",
  );
  const source = JSON.parse(await readFile(sourcePath, "utf8")) as NativeBenchmarkReport;
  const v2ReportPath = valueAfter(args, "--v2-report");
  let v2Observations: readonly NativeObservationV2[] | undefined;
  if (v2ReportPath !== undefined) {
    const report = JSON.parse(await readFile(resolve(root, v2ReportPath), "utf8")) as {
      readonly observations: readonly NativeObservationV2[];
    };
    v2Observations = report.observations;
  }
  const v1Cases = buildNativeDataset();
  const report = offlineRescore({
    sourceRunId: source.benchmarkRunId,
    v1Cases,
    v2Cases: buildNativeDatasetV2(v1Cases),
    v1Observations: source.observations,
    ...(v2Observations === undefined ? {} : { v2Observations }),
  });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    resolve(outputDir, "offline-rescore.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  await writeFile(resolve(outputDir, "offline-rescore.md"), renderOfflineRescore(report), "utf8");
  process.stdout.write(
    `${JSON.stringify({ transitions: report.transitions, traceSufficiency: report.traceSufficiency })}\n`,
  );
}

await main();
