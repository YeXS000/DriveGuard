import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { buildNativeDatasetV2 } from "../native/datasets/v2.js";
import { createNativeSplitManifest } from "../native/split.js";

const datasetPath = resolve(process.cwd(), "evals/native/datasets/driveguard-eval-v2.json");
const outputPath = resolve(
  process.cwd(),
  "13.2-agent-quality-remediation/reports/split-manifest.json",
);
const datasetBytes = await readFile(datasetPath);
const manifest = createNativeSplitManifest(
  buildNativeDatasetV2(),
  createHash("sha256").update(datasetBytes).digest("hex"),
);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(
  `${JSON.stringify({ development: manifest.development.count, holdout: manifest.holdout.count })}\n`,
);
