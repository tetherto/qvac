import test from "brittle";
import type { CompletionEvent, ToolCall } from "@/schemas";
import {
  aggregateEvents,
  buildFinalFromEvents,
} from "@/utils/aggregate-events";
import type { ToolHandlerMap } from "@/utils/tool-helpers";

// --- aggregateEvents ---

test("aggregateEvents: collects contentDelta into contentText", (t) => {
  const events: CompletionEvent[] = [
    { type: "contentDelta", seq: 0, text: "Hello " },
    { type: "contentDelta", seq: 1, text: "world" },
  ];
  const result = aggregateEvents(events);
  t.is(result.contentText, "Hello world");
});

test("aggregateEvents: collects thinkingDelta into thinkingText", (t) => {
  const events: CompletionEvent[] = [
    { type: "contentDelta", seq: 0, text: "answer" },
    { type: "thinkingDelta", seq: 1, text: "let me " },
    { type: "thinkingDelta", seq: 2, text: "think" },
  ];
  const result = aggregateEvents(events);
  t.is(result.contentText, "answer");
  t.is(result.thinkingText, "let me think");
});

test("aggregateEvents: extracts stats from completionStats event", (t) => {
  const events: CompletionEvent[] = [
    { type: "contentDelta", seq: 0, text: "hi" },
    { type: "completionStats", seq: 1, stats: { tokensPerSecond: 50 } },
    { type: "completionDone", seq: 2 },
  ];
  const result = aggregateEvents(events);
  t.is(result.stats?.tokensPerSecond, 50);
});

test("aggregateEvents: collects toolCall events", (t) => {
  const call: ToolCall = { id: "c1", name: "echo", arguments: { msg: "hi" } };
  const events: CompletionEvent[] = [
    { type: "toolCall", seq: 0, call },
    { type: "completionDone", seq: 1 },
  ];
  const result = aggregateEvents(events);
  t.is(result.toolCalls.length, 1);
  t.is(result.toolCalls[0]!.name, "echo");
});

test("aggregateEvents: extracts raw.fullText from completionDone", (t) => {
  const events: CompletionEvent[] = [
    { type: "contentDelta", seq: 0, text: "clean" },
    { type: "completionDone", seq: 1, raw: { fullText: "<think>reasoning</think>clean" } },
  ];
  const result = aggregateEvents(events);
  t.is(result.rawFullText, "<think>reasoning</think>clean");
});

test("aggregateEvents: error extraction from done event", (t) => {
  const errorEvents: CompletionEvent[] = [
    {
      type: "completionDone",
      seq: 0,
      stopReason: "error",
      error: { message: "provider timeout" },
    },
  ];
  const errResult = aggregateEvents(errorEvents);
  t.ok(errResult.error);
  t.is(errResult.error!.message, "provider timeout");

  const successEvents: CompletionEvent[] = [
    { type: "contentDelta", seq: 0, text: "hi" },
    { type: "completionDone", seq: 1 },
  ];
  t.is(aggregateEvents(successEvents).error, undefined, "no error for success-done");
});

test("aggregateEvents: empty events produce empty aggregation", (t) => {
  const result = aggregateEvents([]);
  t.is(result.contentText, "");
  t.is(result.thinkingText, "");
  t.is(result.stats, undefined);
  t.is(result.toolCalls.length, 0);
  t.is(result.rawFullText, undefined);
  t.is(result.error, undefined);
});

// --- buildFinalFromEvents ---

test("buildFinalFromEvents: derives final from event stream", (t) => {
  const call: ToolCall = { id: "c1", name: "echo", arguments: { msg: "hi" } };
  const events: CompletionEvent[] = [
    { type: "contentDelta", seq: 0, text: "Hello" },
    { type: "toolCall", seq: 1, call },
    { type: "completionStats", seq: 2, stats: { tokensPerSecond: 42 } },
    { type: "completionDone", seq: 3, raw: { fullText: "Hello<tool_call>...</tool_call>" } },
  ];
  const handlers: ToolHandlerMap = new Map();

  const { final, error } = buildFinalFromEvents(events, handlers);

  t.is(error, undefined);
  t.is(final.contentText, "Hello");
  t.is(final.toolCalls.length, 1);
  t.is(final.stats?.tokensPerSecond, 42);
  t.is(final.raw.fullText, "Hello<tool_call>...</tool_call>");
});

test("buildFinalFromEvents: attaches handlers to event-derived tool calls", (t) => {
  const call: ToolCall = { id: "c1", name: "greet", arguments: { name: "Ada" } };
  const events: CompletionEvent[] = [
    { type: "toolCall", seq: 0, call },
    { type: "completionDone", seq: 1 },
  ];
  const handler = async (args: Record<string, unknown>) => `Hi ${args["name"]}`;
  const handlers: ToolHandlerMap = new Map([["greet", handler]]);

  const { final } = buildFinalFromEvents(events, handlers);

  t.is(final.toolCalls.length, 1);
  t.ok(final.toolCalls[0]!.invoke, "invoke is attached");
});

test("buildFinalFromEvents: includes thinkingText when present", (t) => {
  const events: CompletionEvent[] = [
    { type: "thinkingDelta", seq: 0, text: "reasoning" },
    { type: "contentDelta", seq: 1, text: "answer" },
    { type: "completionDone", seq: 2, raw: { fullText: "<think>reasoning</think>answer" } },
  ];
  const { final } = buildFinalFromEvents(events, new Map());

  t.is(final.contentText, "answer");
  t.is(final.thinkingText, "reasoning");
  t.is(final.raw.fullText, "<think>reasoning</think>answer");
});

test("buildFinalFromEvents: raw fallback and absent fields", (t) => {
  const events: CompletionEvent[] = [
    { type: "contentDelta", seq: 0, text: "just content" },
    { type: "completionDone", seq: 1 },
  ];
  const { final } = buildFinalFromEvents(events, new Map());

  t.is(final.contentText, "just content");
  t.is(final.raw.fullText, "just content", "raw.fullText falls back to contentText");
  t.is(final.toolCalls.length, 0, "no toolCalls when none emitted");
  t.is(final.stats, undefined, "no stats when none emitted");
});

test("buildFinalFromEvents: returns error for error-done events", (t) => {
  const events: CompletionEvent[] = [
    {
      type: "completionDone",
      seq: 0,
      stopReason: "error",
      error: { message: "provider timeout" },
    },
  ];
  const { final, error } = buildFinalFromEvents(events, new Map());

  t.ok(error);
  t.is(error!.message, "provider timeout");
  t.is(final.contentText, "");
});
