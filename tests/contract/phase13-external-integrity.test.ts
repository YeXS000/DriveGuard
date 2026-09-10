import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const root = new URL("../../evals/external/car-bench/", import.meta.url);

async function jsonFile(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(name, root), "utf8")) as Record<string, unknown>;
}

describe("Phase 13 CAR-bench external integrity", () => {
  it("pins the inspected official repository and dataset commits", async () => {
    const metadata = await jsonFile("benchmark-metadata.json");
    expect(metadata).toMatchObject({
      commit: "54990894241f2c07e9b523928c2a29e9b693d313",
      benchmarkVersion: "0.1.0",
      license: "MIT",
      datasetCommit: "1fcf24ad802c42e04a0d8fe05b5ca0d481a4e7af",
    });
  });

  it("records the official 50/50/25 test split and 58 Tool / 19 Policy counts", async () => {
    const metadata = await jsonFile("benchmark-metadata.json");
    expect(metadata).toMatchObject({
      taskSplit: { test: { base: 50, hallucination: 50, disambiguation: 25, total: 125 } },
      toolCount: 58,
      policyCount: 19,
    });
  });

  it("declares zero evaluator semantic changes", async () => {
    await expect(jsonFile("benchmark-metadata.json")).resolves.toMatchObject({
      evaluatorSemanticsModified: false,
    });
  });

  it("creates the compatibility manifest before a model run with 125 entries", async () => {
    const manifest = await jsonFile("car-bench-compatibility.json");
    expect(manifest).toMatchObject({
      generatedBeforeModelRun: true,
      testTaskCount: 125,
      supportedCount: 125,
      coverage: "125/125",
    });
    expect(manifest.tasks).toHaveLength(125);
  });

  it("records task ID, required Tools, reason and mapping for every compatibility row", async () => {
    const manifest = await jsonFile("car-bench-compatibility.json");
    for (const task of manifest.tasks as Record<string, unknown>[]) {
      expect(typeof task.taskId).toBe("string");
      expect(task.supported).toBe(true);
      expect(typeof task.reason).toBe("string");
      expect(Array.isArray(task.requiredTools)).toBe(true);
      expect(typeof task.mapping).toBe("object");
      expect(task.mapping).not.toBeNull();
    }
  });

  it("does not vendor or modify official task/evaluator source", async () => {
    const metadata = await jsonFile("benchmark-metadata.json");
    expect(metadata.evaluatorSemanticsModified).toBe(false);
    await expect(readFile(new URL("run.py", root), "utf8")).rejects.toThrow();
    await expect(
      readFile(new URL("car_bench/envs/reward_calculators.py", root), "utf8"),
    ).rejects.toThrow();
  });

  it("bounds each evaluation bridge process and reports sanitized diagnostics", async () => {
    const adapter = await readFile(new URL("car_bench_adapter.py", root), "utf8");
    expect(adapter).toContain("BRIDGE_TIMEOUT_SECONDS = 120");
    expect(adapter).toContain("timeout=BRIDGE_TIMEOUT_SECONDS");
    expect(adapter).toContain("except subprocess.TimeoutExpired");
    expect(adapter).toContain('"[REDACTED]"');
    expect(adapter).not.toContain("completed.stderr.strip()}");
  });

  it("keeps DeepSeek JSON-mode retries bounded and feeds validation detail back", async () => {
    const runner = await readFile(new URL("run_official.py", root), "utf8");
    expect(runner).toContain("for attempt in range(4)");
    expect(runner).toContain("The previous response failed validation:");
    expect(runner).toContain("response_format.model_validate(parsed)");
    expect(runner).toContain("sanitized_validation_error(last_error");
    expect(runner).toContain("parsed = ast.literal_eval(content)");
    expect(runner).toContain("result.choices[0].message.content = json.dumps(");
    expect(runner).toContain("time.sleep(2 ** (attempt + 1))");
  });

  it("writes a strict JSON aggregate when official diagnostics contain non-finite floats", async () => {
    const runner = await readFile(new URL("run_official.py", root), "utf8");
    expect(runner).toContain("def json_safe(value: Any) -> Any:");
    expect(runner).toContain("not math.isfinite(value)");
    expect(runner).toContain("json.dumps(json_safe(payload)");
    expect(runner).toContain("allow_nan=False");
    expect(runner).toContain('"nonFiniteOfficialMetadataNormalizedToNull": True');
  });
});
