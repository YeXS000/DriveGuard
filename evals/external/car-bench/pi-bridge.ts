import {
  createModels,
  type AssistantMessage,
  type Message,
  type Tool,
  type Usage,
} from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { Unsafe, type TSchema } from "typebox";

interface OpenAiTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters: TSchema;
  };
}

interface BridgeRequest {
  readonly systemPrompt: string;
  readonly messages: readonly Record<string, unknown>[];
  readonly tools: readonly OpenAiTool[];
  readonly model?: string;
}

const zeroUsage: Usage = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
});

function stringField(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function convertMessages(input: readonly Record<string, unknown>[], model: string): Message[] {
  const now = Date.now();
  return input.flatMap((item): Message[] => {
    const role = stringField(item.role, "message.role");
    if (role === "system") return [];
    if (role === "user") {
      return [
        { role: "user", content: stringField(item.content ?? "", "user.content"), timestamp: now },
      ];
    }
    if (role === "tool") {
      return [
        {
          role: "toolResult",
          toolCallId: stringField(item.tool_call_id, "tool.tool_call_id"),
          toolName: stringField(item.name, "tool.name"),
          content: [{ type: "text", text: stringField(item.content ?? "", "tool.content") }],
          details: null,
          isError: false,
          timestamp: now,
        },
      ];
    }
    if (role === "assistant") {
      const content: AssistantMessage["content"] = [];
      if (typeof item.content === "string" && item.content.length > 0) {
        content.push({ type: "text", text: item.content });
      }
      if (Array.isArray(item.tool_calls)) {
        for (const candidate of item.tool_calls) {
          if (typeof candidate !== "object" || candidate === null) continue;
          const call = candidate as Record<string, unknown>;
          const function_ = call.function as Record<string, unknown> | undefined;
          if (function_ === undefined) continue;
          const rawArguments = function_.arguments;
          content.push({
            type: "toolCall",
            id: stringField(call.id, "assistant.tool_call.id"),
            name: stringField(function_.name, "assistant.tool_call.name"),
            arguments:
              typeof rawArguments === "string"
                ? (JSON.parse(rawArguments) as Record<string, unknown>)
                : ((rawArguments ?? {}) as Record<string, unknown>),
          });
        }
      }
      return [
        {
          role: "assistant",
          content,
          api: "openai-completions",
          provider: "deepseek",
          model,
          usage: zeroUsage,
          stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
          timestamp: now,
        },
      ];
    }
    throw new Error(`Unsupported CAR-bench message role: ${role}`);
  });
}

function convertTools(input: readonly OpenAiTool[]): Tool[] {
  return input.map((item) => ({
    name: item.function.name,
    description: item.function.description ?? item.function.name,
    parameters: Unsafe<Record<string, unknown>>(structuredClone(item.function.parameters)),
  }));
}

function toOpenAiMessage(message: AssistantMessage): Record<string, unknown> {
  const text = message.content
    .filter(
      (block): block is Extract<(typeof message.content)[number], { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("");
  const calls = message.content
    .filter(
      (block): block is Extract<(typeof message.content)[number], { type: "toolCall" }> =>
        block.type === "toolCall",
    )
    .map((block) => ({
      id: block.id,
      type: "function",
      function: { name: block.name, arguments: JSON.stringify(block.arguments) },
    }));
  return {
    role: "assistant",
    content: text.length === 0 ? null : text,
    tool_calls: calls.length === 0 ? null : calls,
  };
}

async function main(): Promise<void> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0)
    throw new Error("DEEPSEEK_API_KEY is required");
  process.stdin.setEncoding("utf8");
  let raw = "";
  for await (const chunk of process.stdin) {
    if (typeof chunk !== "string") throw new Error("stdin must be UTF-8 text");
    raw += chunk;
  }
  const request = JSON.parse(raw) as BridgeRequest;
  const models = createModels();
  models.setProvider(deepseekProvider());
  const modelId = request.model ?? process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
  const model = models.getModel("deepseek", modelId);
  if (model === undefined)
    throw new Error("Requested DeepSeek model is unavailable in the installed Pi catalog");
  const stream = models.streamSimple(
    model,
    {
      systemPrompt: request.systemPrompt,
      messages: convertMessages(request.messages, modelId),
      tools: convertTools(request.tools),
    },
    { apiKey, temperature: 0, reasoning: "low", maxRetries: 1 },
  );
  const result = await stream.result();
  if (result.stopReason === "error" || result.stopReason === "aborted") {
    throw new Error(result.errorMessage ?? "DeepSeek planning request failed");
  }
  process.stdout.write(`${JSON.stringify(toOpenAiMessage(result))}\n`);
}

await main();
