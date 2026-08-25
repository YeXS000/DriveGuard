import { createLivePhase1Runtime, type Phase1RunResult, type Phase1Runtime } from "./runtime.js";
import { PHASE_1_TRIP_STATE } from "./phase1-tools.js";

type LiveToolBehavior = "parallel" | "sequential" | "single" | "no-tools";

interface LiveScenarioSummary {
  readonly case: string;
  readonly promptsAttempted: number;
  readonly promptsSucceeded: number;
  readonly providerRequestsObserved: number;
  readonly toolCallsObserved: number;
  readonly toolNames: readonly string[];
  readonly toolExecutionCount: number;
  readonly toolErrorsObserved: number;
  readonly terminalState: "idle" | "busy";
  readonly behavior: LiveToolBehavior;
  readonly expectationsMet: boolean;
  readonly errors: readonly string[];
}

function observedToolNames(results: readonly Phase1RunResult[]): string[] {
  return results.flatMap((result) =>
    result.events.flatMap((event) =>
      event.type === "tool_execution_start" && event.toolName !== undefined ? [event.toolName] : [],
    ),
  );
}

function toolExecutionCount(results: readonly Phase1RunResult[]): number {
  return results.reduce(
    (count, result) =>
      count + result.instrumentation.filter((record) => record.stage === "afterToolCall").length,
    0,
  );
}

function toolErrorCount(results: readonly Phase1RunResult[]): number {
  return results.reduce(
    (count, result) =>
      count +
      result.events.filter((event) => event.type === "tool_execution_end" && event.isError === true)
        .length,
    0,
  );
}

function providerRequestCount(results: readonly Phase1RunResult[]): number {
  return results.reduce(
    (count, result) => count + result.events.filter((event) => event.type === "turn_start").length,
    0,
  );
}

function toolBehavior(results: readonly Phase1RunResult[]): LiveToolBehavior {
  const events = results.flatMap((result) => result.events);
  const toolEvents = events.filter(
    (event) => event.type === "tool_execution_start" || event.type === "tool_execution_end",
  );
  const starts = toolEvents.filter((event) => event.type === "tool_execution_start").length;

  if (starts === 0) return "no-tools";
  if (starts === 1) return "single";
  return toolEvents[1]?.type === "tool_execution_start" ? "parallel" : "sequential";
}

function summarize(
  caseName: string,
  results: readonly Phase1RunResult[],
  expectationsMet: boolean,
): LiveScenarioSummary {
  const toolNames = observedToolNames(results);
  const observedToolErrors = toolErrorCount(results);
  return {
    case: caseName,
    promptsAttempted: results.length,
    promptsSucceeded: results.filter((result) => result.status === "succeeded").length,
    providerRequestsObserved: providerRequestCount(results),
    toolCallsObserved: toolNames.length,
    toolNames,
    toolExecutionCount: toolExecutionCount(results),
    toolErrorsObserved: observedToolErrors,
    terminalState: results.some((result) => result.terminalState === "busy") ? "busy" : "idle",
    behavior: toolBehavior(results),
    expectationsMet,
    errors: [
      ...results.flatMap((result) => (result.error === undefined ? [] : [result.error.message])),
      ...(observedToolErrors === 0 ? [] : [`${observedToolErrors} tool call error(s) observed`]),
    ],
  };
}

async function singlePromptScenario(
  caseName: string,
  prompt: string,
  validate: (result: Phase1RunResult, toolNames: readonly string[]) => boolean,
): Promise<LiveScenarioSummary> {
  const { runtime } = createLivePhase1Runtime();
  const result = await runtime.run(prompt);
  const toolNames = observedToolNames([result]);
  return summarize(caseName, [result], validate(result, toolNames));
}

async function multiTurnScenario(runtime: Phase1Runtime): Promise<LiveScenarioSummary> {
  const first = await runtime.run("What is my current battery level?");
  const second = await runtime.run("And what about the trip?");
  const results = [first, second];
  const toolNames = observedToolNames(results);
  const expectationsMet =
    results.every((result) => result.status === "succeeded") &&
    results.every((result) => result.terminalState === "idle") &&
    toolErrorCount(results) === 0 &&
    toolExecutionCount(results) === 2 &&
    first.response.includes("67") &&
    second.response.includes("42.5") &&
    toolNames.filter((name) => name === "get_vehicle_state").length === 1 &&
    toolNames.filter((name) => name === "get_trip_state").length === 1;
  return summarize("CASE 5 multi-turn", results, expectationsMet);
}

async function main(): Promise<void> {
  if (process.env.DEEPSEEK_API_KEY?.trim()) {
    const selection = createLivePhase1Runtime().selection;
    const scenarios: LiveScenarioSummary[] = [];

    scenarios.push(
      await singlePromptScenario(
        "CASE 1 vehicle battery",
        "What is the current vehicle battery level?",
        (result, toolNames) =>
          result.status === "succeeded" &&
          result.terminalState === "idle" &&
          toolErrorCount([result]) === 0 &&
          toolExecutionCount([result]) === 1 &&
          result.response.includes("67") &&
          toolNames.length === 1 &&
          toolNames[0] === "get_vehicle_state",
      ),
    );
    scenarios.push(
      await singlePromptScenario(
        "CASE 2 trip navigation",
        "Am I currently navigating somewhere and how far is left?",
        (result, toolNames) =>
          result.status === "succeeded" &&
          result.terminalState === "idle" &&
          toolErrorCount([result]) === 0 &&
          toolExecutionCount([result]) === 1 &&
          result.response.includes("42.5") &&
          result.response.includes(PHASE_1_TRIP_STATE.destination) &&
          /\b(yes|active|navigating)\b/iu.test(result.response) &&
          !/\b(no|not|inactive|isn't|isn’t|aren't|aren’t)\b/iu.test(result.response) &&
          toolNames.length === 1 &&
          toolNames[0] === "get_trip_state",
      ),
    );
    scenarios.push(
      await singlePromptScenario(
        "CASE 3 combined state",
        "Tell me the battery level and how far is left on my trip.",
        (result, toolNames) =>
          result.status === "succeeded" &&
          result.terminalState === "idle" &&
          toolErrorCount([result]) === 0 &&
          toolExecutionCount([result]) === 2 &&
          result.response.includes("67") &&
          result.response.includes("42.5") &&
          toolNames.filter((name) => name === "get_vehicle_state").length === 1 &&
          toolNames.filter((name) => name === "get_trip_state").length === 1,
      ),
    );
    scenarios.push(
      await singlePromptScenario(
        "CASE 4 no tool",
        "Say hello.",
        (result, toolNames) =>
          result.status === "succeeded" &&
          result.terminalState === "idle" &&
          toolNames.length === 0 &&
          toolExecutionCount([result]) === 0 &&
          toolErrorCount([result]) === 0,
      ),
    );
    scenarios.push(await multiTurnScenario(createLivePhase1Runtime().runtime));

    const summary = {
      status: scenarios.every((scenario) => scenario.expectationsMet) ? "PASS" : "FAIL",
      provider: selection.providerId,
      api: selection.api,
      model: selection.modelId,
      promptsAttempted: scenarios.reduce((sum, scenario) => sum + scenario.promptsAttempted, 0),
      promptsSucceeded: scenarios.reduce((sum, scenario) => sum + scenario.promptsSucceeded, 0),
      providerRequestsObserved: scenarios.reduce(
        (sum, scenario) => sum + scenario.providerRequestsObserved,
        0,
      ),
      toolCallsObserved: scenarios.reduce((sum, scenario) => sum + scenario.toolCallsObserved, 0),
      toolExecutionCount: scenarios.reduce((sum, scenario) => sum + scenario.toolExecutionCount, 0),
      toolErrorsObserved: scenarios.reduce((sum, scenario) => sum + scenario.toolErrorsObserved, 0),
      scenarios,
    };
    process.stdout.write(`${JSON.stringify(summary, undefined, 2)}\n`);
    if (summary.status !== "PASS") process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        status: "NOT RUN",
        reason: "DEEPSEEK_API_KEY not present in environment",
        promptsAttempted: 0,
        promptsSucceeded: 0,
        toolExecutionCount: 0,
      },
      undefined,
      2,
    )}\n`,
  );
}

await main();
