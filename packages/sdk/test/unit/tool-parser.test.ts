// @ts-expect-error brittle has no type declarations
import test from "brittle";
import type { Tool } from "@/schemas";
import { parseToolCalls } from "@/server/utils/tool-parser";
import { checkForToolEvents } from "@/server/utils/tool-integration";

const weatherTool: Tool = {
  type: "function",
  name: "weather",
  description: "Get current weather",
  parameters: {
    type: "object",
    properties: {
      args: { type: "array" },
      timeoutMs: { type: "integer" },
    },
    required: ["args"],
  },
};

const skillsGetTool: Tool = {
  type: "function",
  name: "skills_get",
  description: "Load skill instructions",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string" },
    },
    required: ["name"],
  },
};

const tools: Tool[] = [weatherTool, skillsGetTool];

test("normal: tool_call outside think → parsed", (t) => {
  const text = `<think>
The user wants weather for Curitiba. I should call the weather skill.
</think>

<tool_call>
{"name": "weather", "arguments": {"args": ["-s", "https://wttr.in/Curitiba"], "timeoutMs": 3000}}
</tool_call>`;

  const { toolCalls } = parseToolCalls(text, tools);
  t.is(toolCalls.length, 1);
  t.is(toolCalls[0]?.name, "weather");
});

test("duplicate: same tool_call inside closed think and outside → one", (t) => {
  const text = `<think>
<tool_call>
{"name": "weather", "arguments": {"args": ["-s", "https://wttr.in/Curitiba"], "timeoutMs": 3000}}
</tool_call></think>

<tool_call>
{"name": "weather", "arguments": {"args": ["-s", "https://wttr.in/Curitiba"], "timeoutMs": 3000}}
</tool_call>`;

  const { toolCalls } = parseToolCalls(text, tools);
  t.is(toolCalls.length, 1);
  t.is(toolCalls[0]?.name, "weather");
});

test("think-only: tool_call only inside closed think → not parsed", (t) => {
  const text = `<think>
Let me call the weather tool.
<tool_call>
{"name": "weather", "arguments": {"args": ["London"]}}
</tool_call>
</think>`;

  const { toolCalls } = parseToolCalls(text, tools);
  t.is(toolCalls.length, 0);
});

test("no think tags: single tool_call → parsed normally", (t) => {
  const text = `<tool_call>
{"name": "weather", "arguments": {"args": ["Paris"]}}
</tool_call>`;

  const { toolCalls } = parseToolCalls(text, tools);
  t.is(toolCalls.length, 1);
  t.alike(toolCalls[0]?.arguments.args, ["Paris"]);
});

test("two distinct tool calls outside think → both parsed", (t) => {
  const text = `<think>
Planning two calls.
</think>

<tool_call>
{"name": "skills_get", "arguments": {"name": "weather"}}
</tool_call>
<tool_call>
{"name": "weather", "arguments": {"args": ["London"]}}
</tool_call>`;

  const { toolCalls } = parseToolCalls(text, tools);
  t.is(toolCalls.length, 2);
  t.is(toolCalls[0]?.name, "skills_get");
  t.is(toolCalls[1]?.name, "weather");
});

test("empty think block → tool_call after it parsed", (t) => {
  const text = `<think>
</think>

<tool_call>
{"name": "weather", "arguments": {"args": ["Curitiba"], "timeoutMs": 3000}}
</tool_call>`;

  const { toolCalls } = parseToolCalls(text, tools);
  t.is(toolCalls.length, 1);
  t.is(toolCalls[0]?.name, "weather");
});

test("no tools provided → empty result", (t) => {
  const text = `<tool_call>
{"name": "weather", "arguments": {"args": ["London"]}}
</tool_call>`;

  const { toolCalls } = parseToolCalls(text, []);
  t.is(toolCalls.length, 0);
});

test("two same-name tools with different args → both parsed", (t) => {
  const text = `<tool_call>
{"name": "weather", "arguments": {"args": ["London"]}}
</tool_call>
<tool_call>
{"name": "weather", "arguments": {"args": ["Paris"]}}
</tool_call>`;

  const { toolCalls } = parseToolCalls(text, tools);
  t.is(toolCalls.length, 2);
});

test("streaming: no events emitted while inside open <think> block", (t) => {
  const accumulated = `<think>\n<tool_call>\n{"name": "weather", "arguments": {"args": ["Curitiba"]}}`;
  const emitted = new Set<number>();
  const events = checkForToolEvents(accumulated, "}", tools, emitted);
  t.is(events.length, 0);
});

test("streaming: events emitted after <think> is closed", (t) => {
  const accumulated = `<think>\nreasoning\n</think>\n\n<tool_call>\n{"name": "weather", "arguments": {"args": ["Curitiba"]}}\n</tool_call>`;
  const emitted = new Set<number>();
  const events = checkForToolEvents(accumulated, "</tool_call>", tools, emitted);
  t.is(events.length, 1);
  t.is(events[0]?.call?.name, "weather");
});

test("streaming: events emitted when no think tags present", (t) => {
  const accumulated = `<tool_call>\n{"name": "weather", "arguments": {"args": ["London"]}}\n</tool_call>`;
  const emitted = new Set<number>();
  const events = checkForToolEvents(accumulated, "</tool_call>", tools, emitted);
  t.is(events.length, 1);
  t.is(events[0]?.call?.name, "weather");
});
