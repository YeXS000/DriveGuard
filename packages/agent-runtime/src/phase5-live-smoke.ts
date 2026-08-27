import { createLiveProductionDriveGuardRuntime, type AgentRunResult } from "./index.js";

interface LiveCase {
  readonly case: string;
  readonly prompts: number;
  readonly providerRequests: number;
  readonly toolCalls: readonly string[];
  readonly toolExecutions: number;
  readonly toolErrors: number;
  readonly terminalStates: readonly string[];
  readonly contextVersions: readonly number[];
  readonly expectationsMet: boolean;
}

function toolNames(results: readonly AgentRunResult[]): string[] {
  return results.flatMap((result) =>
    result.events.flatMap((event) =>
      event.eventType === "tool.requested" && event.metadata?.toolName !== undefined
        ? [event.metadata.toolName]
        : [],
    ),
  );
}

function summarize(
  name: string,
  results: readonly AgentRunResult[],
  expectationsMet: boolean,
): LiveCase {
  return {
    case: name,
    prompts: results.length,
    providerRequests: results.reduce(
      (count, result) =>
        count + result.events.filter((event) => event.eventType === "model.started").length,
      0,
    ),
    toolCalls: toolNames(results),
    toolExecutions: results.reduce(
      (count, result) =>
        count +
        result.events.filter(
          (event) => event.eventType === "tool.completed" && event.metadata?.isError === false,
        ).length,
      0,
    ),
    toolErrors: results.reduce(
      (count, result) =>
        count +
        result.events.filter(
          (event) => event.eventType === "tool.completed" && event.metadata?.isError === true,
        ).length,
      0,
    ),
    terminalStates: results.map((result) => result.run.status),
    contextVersions: results.flatMap((result) =>
      result.context === undefined ? [] : [result.context.contextVersion],
    ),
    expectationsMet,
  };
}

function formalToolResults(results: readonly AgentRunResult[]): unknown[] {
  return results.flatMap((run) =>
    run.toolExecutions.flatMap((execution) =>
      execution.outcome === "succeeded" && execution.result !== undefined ? [execution.result] : [],
    ),
  );
}

async function control(baseUrl: string, path: string, body: object): Promise<void> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`Simulator control request failed with HTTP ${response.status}`);
}

async function singleCase(
  baseUrl: string,
  caseName: string,
  sessionId: string,
  prompt: string,
  expectedTools: readonly string[],
): Promise<LiveCase> {
  await control(baseUrl, "/simulator/reset", { scenario: "active_navigation", seed: 500 });
  const { runtime } = createLiveProductionDriveGuardRuntime(baseUrl);
  const result = await runtime.run({ sessionId, prompt });
  const observed = toolNames([result]);
  const expectationsMet =
    result.status === "succeeded" &&
    result.run.status === "RUN_SUCCEEDED" &&
    expectedTools.every((name) => observed.includes(name)) &&
    observed.every((name) => expectedTools.includes(name)) &&
    result.events.every((event) => event.runId === result.run.runId) &&
    result.events.every((event) => event.traceId === result.run.traceId);
  return summarize(caseName, [result], expectationsMet);
}

async function worldStateRefresh(baseUrl: string): Promise<LiveCase> {
  const { runtime } = createLiveProductionDriveGuardRuntime(baseUrl);
  await control(baseUrl, "/simulator/reset", { scenario: "active_navigation", seed: 505 });
  const first = await runtime.run({
    sessionId: "phase5-live-refresh",
    prompt: "Check my current battery level using the current vehicle-state tool.",
  });
  const firstDetails = formalToolResults([first]);
  await control(baseUrl, "/simulator/vehicle/soc", { soc: 20 });
  const second = await runtime.run({
    sessionId: "phase5-live-refresh",
    prompt: "Check my battery again using the current vehicle-state tool.",
  });
  const secondDetails = formalToolResults([second]);
  const firstSoc = firstDetails.some(
    (value) => typeof value === "object" && value !== null && Reflect.get(value, "soc") === 72,
  );
  const secondSoc = secondDetails.some(
    (value) => typeof value === "object" && value !== null && Reflect.get(value, "soc") === 20,
  );
  const expectationsMet =
    first.status === "succeeded" &&
    second.status === "succeeded" &&
    toolNames([first, second]).filter((name) => name === "get_vehicle_state").length === 2 &&
    firstSoc &&
    secondSoc &&
    (second.context?.contextVersion ?? 0) > (first.context?.contextVersion ?? 0) &&
    (second.context?.vehicleVersion ?? 0) > (first.context?.vehicleVersion ?? 0);
  return summarize("CASE 6 world-state refresh", [first, second], expectationsMet);
}

async function main(): Promise<void> {
  if (
    process.env.DEEPSEEK_API_KEY?.trim().length === 0 ||
    process.env.DEEPSEEK_API_KEY === undefined
  ) {
    process.stdout.write(
      `${JSON.stringify(
        {
          status: "NOT RUN",
          reason: "DEEPSEEK_API_KEY not present in environment",
          cases: [],
        },
        undefined,
        2,
      )}\n`,
    );
    return;
  }
  if ((process.env.PHASE_5_RUNTIME_MODE ?? "read_only") !== "read_only") {
    throw new Error("Phase 5 live smoke requires PHASE_5_RUNTIME_MODE=read_only");
  }
  const baseUrl = process.env.SIMULATOR_BASE_URL ?? "http://127.0.0.1:3001";
  const cases: LiveCase[] = [];
  cases.push(
    await singleCase(
      baseUrl,
      "CASE 1 battery",
      "phase5-live-1",
      "What is my current battery level? Use the current vehicle-state tool.",
      ["get_vehicle_state"],
    ),
  );
  cases.push(
    await singleCase(
      baseUrl,
      "CASE 2 navigation",
      "phase5-live-2",
      "Where am I currently navigating? Use the current trip-state tool.",
      ["get_trip_state"],
    ),
  );
  cases.push(
    await singleCase(
      baseUrl,
      "CASE 3 charging stations",
      "phase5-live-3",
      "Find nearby charging stations using the charging-station search tool.",
      ["search_charging_stations"],
    ),
  );
  cases.push(
    await singleCase(
      baseUrl,
      "CASE 4 multi-tool",
      "phase5-live-4",
      "Tell me the current battery level and remaining trip distance. Use both current-state tools.",
      ["get_vehicle_state", "get_trip_state"],
    ),
  );
  cases.push(await singleCase(baseUrl, "CASE 5 ordinary chat", "phase5-live-5", "Say hello.", []));
  cases.push(await worldStateRefresh(baseUrl));

  const selection = createLiveProductionDriveGuardRuntime(baseUrl).selection;
  const summary = {
    status: cases.every((entry) => entry.expectationsMet) ? "PASS" : "FAIL",
    provider: selection.providerId,
    api: selection.api,
    model: selection.modelId,
    runtimeMode: "read_only",
    requests: cases.reduce((count, entry) => count + entry.providerRequests, 0),
    toolCalls: cases.reduce((count, entry) => count + entry.toolCalls.length, 0),
    toolExecutions: cases.reduce((count, entry) => count + entry.toolExecutions, 0),
    cases,
  };
  process.stdout.write(`${JSON.stringify(summary, undefined, 2)}\n`);
  if (summary.status !== "PASS") process.exitCode = 1;
}

await main();
