import test from "brittle";
import { createCompletionNormalizer } from "@/server/utils/completion-normalizer";
import type {
  CompletionEvent,
  NormalizerConfig,
  PluginCapabilities,
  Tool,
} from "@/schemas";

const NONE_CAPS: PluginCapabilities = {
  toolCalling: "none",
  thinkingFraming: "none",
};

const THINKING_CAPS: PluginCapabilities = {
  ...NONE_CAPS,
  thinkingFraming: "thinkTags",
};

const TEXT_PARSE_CAPS: PluginCapabilities = {
  ...NONE_CAPS,
  toolCalling: "textParse",
  thinkingFraming: "thinkTags",
};

const GET_WEATHER_TOOL: Tool = {
  type: "function",
  name: "get_weather",
  description: "fetch weather for a city",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string" },
      country: { type: "string" },
    },
    required: ["city"],
  },
};

const ECHO_TOOL: Tool = {
  type: "function",
  name: "echo",
  description: "echoes input",
  parameters: {
    type: "object",
    properties: { msg: { type: "string" } },
    required: ["msg"],
  },
};

function baseConfig(overrides?: Partial<NormalizerConfig>): NormalizerConfig {
  return {
    capabilities: NONE_CAPS,
    tools: [],
    captureThinking: false,
    emitRawDeltas: false,
    ...overrides,
  };
}

function pushAll(n: ReturnType<typeof createCompletionNormalizer>, tokens: string[]) {
  const all: CompletionEvent[] = [];
  for (const t of tokens) all.push(...n.push(t));
  return all;
}

function types(events: CompletionEvent[]) {
  return events.map((e) => e.type);
}

function texts(events: CompletionEvent[], type: string) {
  return events
    .filter((e) => e.type === type && "text" in e)
    .map((e) => (e as { text: string }).text);
}

test("plain content: emits ordered contentDelta and completionDone", (t) => {
  const n = createCompletionNormalizer(baseConfig());
  const events = [...pushAll(n, ["Hel", "lo ", "world"]), ...n.finish()];

  t.alike(types(events), [
    "contentDelta", "contentDelta", "contentDelta", "completionDone",
  ]);
  t.alike(texts(events, "contentDelta"), ["Hel", "lo ", "world"]);
  t.is(n.getAccumulated().contentText, "Hello world");

  const seqs = events.map((e) => e.seq);
  t.ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]!), "seqs are monotonic");
});

test("emitRawDeltas: interleaves rawDelta with contentDelta", (t) => {
  const n = createCompletionNormalizer(baseConfig({ emitRawDeltas: true }));
  const events = pushAll(n, ["ab", "cd"]);

  t.alike(types(events), [
    "rawDelta", "contentDelta", "rawDelta", "contentDelta",
  ]);
  t.alike(texts(events, "rawDelta"), ["ab", "cd"]);
});

test("thinkingFraming none: <think> text stays in content", (t) => {
  const n = createCompletionNormalizer(baseConfig({ captureThinking: true }));
  const events = pushAll(n, ["Hello <think>deep thought</think> end"]);

  t.alike(types(events), ["contentDelta"]);
  t.ok(texts(events, "contentDelta")[0]!.includes("<think>"));
  t.is(n.getAccumulated().thinkingText, undefined);
});

test("captureThinking false: <think> text stays in content", (t) => {
  const n = createCompletionNormalizer(
    baseConfig({ capabilities: THINKING_CAPS }),
  );
  const events = [
    ...pushAll(n, ["Before <think>inner</think> After"]),
    ...n.finish(),
  ];

  t.alike(texts(events, "contentDelta"), ["Before <think>inner</think> After"]);
  t.ok(!types(events).includes("thinkingDelta"), "no thinkingDelta when not captured");
  t.is(n.getAccumulated().contentText, "Before <think>inner</think> After");
});

test("captureThinking true: strips <think> content and emits thinkingDelta events", (t) => {
  const n = createCompletionNormalizer(
    baseConfig({ capabilities: THINKING_CAPS, captureThinking: true }),
  );
  const events = pushAll(n, ["A<think>thought</think>B"]);

  t.alike(types(events), ["contentDelta", "thinkingDelta", "contentDelta"]);
  t.alike(texts(events, "thinkingDelta"), ["thought"]);
  t.alike(texts(events, "contentDelta"), ["A", "B"]);
  t.is(n.getAccumulated().thinkingText, "thought");
});

test("valid framed tool call: emits toolCall, no content for markup", (t) => {
  const n = createCompletionNormalizer(
    baseConfig({ capabilities: TEXT_PARSE_CAPS, tools: [ECHO_TOOL] }),
  );
  const toolJson = JSON.stringify({ name: "echo", arguments: { msg: "hi" } });
  const events = [
    ...pushAll(n, [`Before <tool_call>${toolJson}</tool_call> After`]),
    ...n.finish(),
  ];

  const toolEvents = events.filter((e) => e.type === "toolCall");
  t.is(toolEvents.length, 1);
  t.alike(texts(events, "contentDelta"), ["Before ", " After"]);
});

test("invalid framed tool call: emits toolError and fails open as content", (t) => {
  const n = createCompletionNormalizer(
    baseConfig({ capabilities: TEXT_PARSE_CAPS, tools: [ECHO_TOOL] }),
  );
  const events = [
    ...pushAll(n, ["<tool_call>not valid json</tool_call>"]),
    ...n.finish(),
  ];

  t.ok(types(events).includes("toolError"), "toolError emitted for unparseable frame");
  t.ok(types(events).includes("contentDelta"), "buffered text fails open as content");
  const content = texts(events, "contentDelta").join("");
  t.ok(content.includes("not valid json"), "original text is preserved");
});

test("no tools provided: <tool_call> text is plain content", (t) => {
  const n = createCompletionNormalizer(
    baseConfig({ capabilities: TEXT_PARSE_CAPS }),
  );
  const events = pushAll(n, ["<tool_call>some text</tool_call>"]);

  t.alike(types(events), ["contentDelta"]);
  t.ok(texts(events, "contentDelta")[0]!.includes("<tool_call>"));
});

test("incomplete tool buffer at finish: emits toolError and fails open", (t) => {
  const n = createCompletionNormalizer(
    baseConfig({ capabilities: TEXT_PARSE_CAPS, tools: [ECHO_TOOL] }),
  );
  const events = [
    ...pushAll(n, ["<tool_call>partial content with no close"]),
    ...n.finish(),
  ];

  t.ok(types(events).includes("toolError"), "toolError for incomplete frame");
  const content = texts(events, "contentDelta").join("");
  t.ok(content.includes("partial content with no close"), "buffered text is flushed");
  t.ok(types(events).includes("completionDone"));
});

// Empty-payload frames (truly empty inner buffer): the normalizer surfaces a
// toolError but must NOT leak the literal `<tool_call>` / `</tool_call>`
// markers into `contentDelta` — pre-fix, the dead `if (!raw.trim())` guard
// never fired (raw always carried the markers) and the parser then re-emitted
// raw as content, exposing markers to consumers.
test("empty frame (closed and incomplete): emits toolError, no marker leak", (t) => {
  const closed = createCompletionNormalizer(
    baseConfig({ capabilities: TEXT_PARSE_CAPS, tools: [ECHO_TOOL] }),
  );
  const closedEvents = [...pushAll(closed, ["<tool_call></tool_call>"]), ...closed.finish()];
  t.ok(types(closedEvents).includes("toolError"), "closed empty: toolError");
  t.absent(
    types(closedEvents).includes("toolCall"),
    "closed empty: no toolCall event",
  );
  const closedContent = texts(closedEvents, "contentDelta").join("");
  t.absent(closedContent.includes("<tool_call>"), "closed empty: no open marker leak");
  t.absent(closedContent.includes("</tool_call>"), "closed empty: no close marker leak");

  const incomplete = createCompletionNormalizer(
    baseConfig({ capabilities: TEXT_PARSE_CAPS, tools: [ECHO_TOOL] }),
  );
  const incompleteEvents = [...pushAll(incomplete, ["<tool_call>"]), ...incomplete.finish()];
  t.ok(types(incompleteEvents).includes("toolError"), "incomplete empty: toolError");
  const incompleteContent = texts(incompleteEvents, "contentDelta").join("");
  t.absent(
    incompleteContent.includes("<tool_call>"),
    "incomplete empty: no open marker leak",
  );
  t.ok(types(incompleteEvents).includes("completionDone"));
});

// Whitespace-only inner payload exercises the strip-then-trim path —
// `<tool_call>   \n  </tool_call>` should be treated identically to a truly
// empty frame: toolError, no toolCall, no marker leak.
test("empty frame (whitespace-only inner): treated as empty, no marker leak", (t) => {
  const n = createCompletionNormalizer(
    baseConfig({ capabilities: TEXT_PARSE_CAPS, tools: [ECHO_TOOL] }),
  );
  const events = [
    ...pushAll(n, ["<tool_call>   \n  </tool_call>"]),
    ...n.finish(),
  ];
  t.ok(types(events).includes("toolError"), "toolError emitted");
  t.absent(types(events).includes("toolCall"), "no toolCall event");
  const content = texts(events, "contentDelta").join("");
  t.absent(content.includes("<tool_call>"), "no open marker leak");
  t.absent(content.includes("</tool_call>"), "no close marker leak");
});

test("completionStats precedes completionDone", (t) => {
  const n = createCompletionNormalizer(baseConfig());
  pushAll(n, ["hi"]);
  const terminal = n.finish({ stats: { tokensPerSecond: 42 } });

  const statsIdx = terminal.findIndex((e) => e.type === "completionStats");
  const doneIdx = terminal.findIndex((e) => e.type === "completionDone");
  t.ok(statsIdx >= 0 && doneIdx >= 0);
  t.ok(statsIdx < doneIdx);
});

test("error finish: skips tool parsing, emits error done", (t) => {
  const n = createCompletionNormalizer(
    baseConfig({ capabilities: TEXT_PARSE_CAPS, tools: [ECHO_TOOL] }),
  );
  const toolJson = JSON.stringify({ name: "echo", arguments: { msg: "hi" } });
  pushAll(n, [`<tool_call>${toolJson}</tool_call>`]);
  const terminal = n.finish({ error: { message: "timeout" } });

  t.ok(!types(terminal).includes("toolCall"), "no tool parsing on error");
  const done = terminal.find((e) => e.type === "completionDone");
  t.ok(done);
  t.is((done as { stopReason: string }).stopReason, "error");
  t.is((done as { error: { message: string } }).error.message, "timeout");
});

test("error finish mid-tool-frame: no toolCall/toolError, fails open as content", (t) => {
  const n = createCompletionNormalizer(
    baseConfig({ capabilities: TEXT_PARSE_CAPS, tools: [ECHO_TOOL] }),
  );
  pushAll(n, ['<tool_call>{"name"']);
  const all = [...n.finish({ error: { message: "connection lost" } })];

  t.ok(!types(all).includes("toolCall"), "no toolCall on error");
  t.ok(!types(all).includes("toolError"), "no toolError on error");
  t.ok(types(all).includes("contentDelta"), "buffered text fails open as content");
  const done = all.find((e) => e.type === "completionDone");
  t.ok(done);
  t.is((done as { stopReason: string }).stopReason, "error");
});

test("completionDone carries raw.fullText from accumulated raw output", (t) => {
  const n = createCompletionNormalizer(
    baseConfig({ capabilities: THINKING_CAPS }),
  );
  pushAll(n, ["Before <think>inner</think> After"]);
  const terminal = n.finish();

  const done = terminal.find((e) => e.type === "completionDone");
  t.ok(done);
  const raw = (done as { raw?: { fullText: string } }).raw;
  t.ok(raw, "completionDone has raw");
  t.is(raw!.fullText, "Before <think>inner</think> After");
});

test("textParse finish: emits server-side parsed toolCalls", (t) => {
  const n = createCompletionNormalizer(
    baseConfig({ capabilities: TEXT_PARSE_CAPS, tools: [ECHO_TOOL] }),
  );
  const toolJson = JSON.stringify({ name: "echo", arguments: { msg: "hi" } });
  pushAll(n, [toolJson]);
  const terminal = n.finish({
    toolCalls: [
      { id: "c1", name: "echo", arguments: { msg: "hi" }, raw: toolJson },
    ],
  });

  const toolEvents = terminal.filter((e) => e.type === "toolCall");
  t.is(toolEvents.length, 1, "server-side parsed toolCall emitted at finish");
  t.is(n.getAccumulated().contentText, toolJson, "unframed raw JSON stays as content");
});

test("dedupe: framed and final with different raw whitespace are deduped", (t) => {
  const n = createCompletionNormalizer(
    baseConfig({ capabilities: TEXT_PARSE_CAPS, tools: [ECHO_TOOL] }),
  );
  const toolJson = JSON.stringify({ name: "echo", arguments: { msg: "hi" } });
  const events = [
    ...pushAll(n, [`<tool_call>\n${toolJson}\n</tool_call>`]),
    ...n.finish({
      toolCalls: [
        { name: "echo", arguments: { msg: "hi" }, raw: toolJson },
      ],
    }),
  ];

  const toolEvents = events.filter((e) => e.type === "toolCall");
  t.is(toolEvents.length, 1, "same name+args deduped regardless of raw whitespace");
});

test("dedupe: calls with different arguments are both emitted", (t) => {
  const n = createCompletionNormalizer(
    baseConfig({ capabilities: TEXT_PARSE_CAPS, tools: [ECHO_TOOL] }),
  );
  const events = n.finish({
    toolCalls: [
      { name: "echo", arguments: { msg: "hello" } },
      { name: "echo", arguments: { msg: "world" } },
    ],
  });

  const toolEvents = events.filter((e) => e.type === "toolCall");
  t.is(toolEvents.length, 2, "different args produce distinct calls");
});

test("dedupe: repeated identical calls from same source are preserved", (t) => {
  const toolJson = JSON.stringify({ name: "echo", arguments: { msg: "hi" } });

  const nFinal = createCompletionNormalizer(
    baseConfig({ capabilities: TEXT_PARSE_CAPS, tools: [ECHO_TOOL] }),
  );
  const finalEvents = nFinal.finish({
    toolCalls: [
      { name: "echo", arguments: { msg: "hi" } },
      { name: "echo", arguments: { msg: "hi" } },
    ],
  });
  t.is(finalEvents.filter((e) => e.type === "toolCall").length, 2, "final: identical calls preserved");

  const nFramed = createCompletionNormalizer(
    baseConfig({ capabilities: TEXT_PARSE_CAPS, tools: [ECHO_TOOL] }),
  );
  const framedEvents = pushAll(nFramed, [
    `<tool_call>${toolJson}</tool_call>`,
    `<tool_call>${toolJson}</tool_call>`,
  ]);
  t.is(framedEvents.filter((e) => e.type === "toolCall").length, 2, "framed: identical calls preserved");
});

// Regression: marker split across token pushes used to be missed by indexOf
// per-token, causing the open marker to leak into contentDelta and the frame
// to never be detected.
test("cross-token marker: <tool_call> split across pushes is still detected", (t) => {
  const n = createCompletionNormalizer(
    baseConfig({ capabilities: TEXT_PARSE_CAPS, tools: [ECHO_TOOL] }),
  );
  const toolJson = JSON.stringify({ name: "echo", arguments: { msg: "hi" } });

  const events = [
    ...pushAll(n, ["Before <tool_", "call>", toolJson, "</tool_", "call> After"]),
    ...n.finish(),
  ];

  t.is(events.filter((e) => e.type === "toolCall").length, 1, "frame detected despite split markers");
  const content = texts(events, "contentDelta").join("");
  t.is(content, "Before  After", "no marker bytes leak into content");
});

test("cross-token marker: <think> split across pushes still strips correctly", (t) => {
  const n = createCompletionNormalizer(
    baseConfig({ capabilities: THINKING_CAPS, captureThinking: true }),
  );

  const events = pushAll(n, ["A<thi", "nk>thought</thi", "nk>B"]);

  t.alike(types(events), ["contentDelta", "thinkingDelta", "contentDelta"]);
  t.alike(texts(events, "thinkingDelta"), ["thought"]);
  t.alike(texts(events, "contentDelta"), ["A", "B"]);
});

// Pythonic dialect — wrapped variant (LFM <|tool_call_start|>...<|tool_call_end|>).
test("pythonic streaming: wrapped frame emits toolCall mid-stream", (t) => {
  const n = createCompletionNormalizer(
    baseConfig({
      capabilities: TEXT_PARSE_CAPS,
      tools: [GET_WEATHER_TOOL],
      toolDialect: "pythonic",
    }),
  );

  const text = `<|tool_call_start|>[get_weather(city="Paris", country="FR")]<|tool_call_end|>`;
  const events = pushAll(n, [text]);

  const tools = events.filter((e) => e.type === "toolCall");
  t.is(tools.length, 1);
  t.alike(
    (tools[0] as { call: { arguments: unknown } }).call.arguments,
    { city: "Paris", country: "FR" },
  );
});

test("pythonic streaming: wrapped marker split across pushes still detected", (t) => {
  const n = createCompletionNormalizer(
    baseConfig({
      capabilities: TEXT_PARSE_CAPS,
      tools: [GET_WEATHER_TOOL],
      toolDialect: "pythonic",
    }),
  );

  const events = pushAll(n, [
    "<|tool_",
    `call_start|>[get_weather(city="Lima")]<|tool_call_`,
    "end|>",
  ]);

  const tools = events.filter((e) => e.type === "toolCall");
  t.is(tools.length, 1, "wrapped pythonic frame detected across split markers");
});

test("pythonic streaming: bare canonical [func(...)] still parses at finish via opts.toolCalls", (t) => {
  // Bare Pythonic has no streaming markers — it's parsed via opts.toolCalls
  // passed by the plugin (which calls parseToolCalls(rawText, tools)).
  const n = createCompletionNormalizer(
    baseConfig({
      capabilities: TEXT_PARSE_CAPS,
      tools: [GET_WEATHER_TOOL],
      toolDialect: "pythonic",
    }),
  );

  const text = `[get_weather(city="Tokyo", country="JP")]`;
  const streamed = pushAll(n, [text]);
  t.is(
    streamed.filter((e) => e.type === "toolCall").length,
    0,
    "bare pythonic has no streaming frame",
  );

  const events = n.finish({
    toolCalls: [
      { name: "get_weather", arguments: { city: "Tokyo", country: "JP" } },
    ],
  });

  const tools = events.filter((e) => e.type === "toolCall");
  t.is(tools.length, 1, "bare pythonic emitted at finish via opts.toolCalls");
});

// Harmony (GPT-OSS): analysis (thinking) / commentary (tool) / final
// (content) channels are stripped unconditionally; `captureThinking` only
// gates `thinkingDelta` emission for the analysis frame.

test("harmony analysis frame: stripped from content (captureThinking=true → thinkingDelta)", (t) => {
  const n = createCompletionNormalizer(
    baseConfig({
      capabilities: NONE_CAPS,
      toolDialect: "harmony",
      captureThinking: true,
    }),
  );
  const text = `<|channel|>analysis<|message|>thinking inside<|end|>after`;
  const events = [...pushAll(n, [text]), ...n.finish()];

  t.alike(texts(events, "thinkingDelta"), ["thinking inside"]);
  t.alike(texts(events, "contentDelta"), ["after"]);
  t.is(n.getAccumulated().thinkingText, "thinking inside");
  t.is(n.getAccumulated().contentText, "after");
});

test("harmony analysis frame: stripped from content (captureThinking=false → silently dropped)", (t) => {
  const n = createCompletionNormalizer(
    baseConfig({
      capabilities: NONE_CAPS,
      toolDialect: "harmony",
      captureThinking: false,
    }),
  );
  const text = `<|channel|>analysis<|message|>thinking inside<|end|>after`;
  const events = [...pushAll(n, [text]), ...n.finish()];

  t.absent(types(events).includes("thinkingDelta"), "no thinkingDelta when not captured");
  t.alike(texts(events, "contentDelta"), ["after"]);
  t.is(n.getAccumulated().thinkingText, undefined);
  // No marker leak.
  const contentJoined = texts(events, "contentDelta").join("");
  t.absent(contentJoined.includes("<|channel|>"), "no analysis open marker leak");
  t.absent(contentJoined.includes("<|end|>"), "no analysis close marker leak");
  t.absent(contentJoined.includes("thinking inside"), "analysis inner is dropped");
});

test("harmony content frame: inner emitted as contentDelta with markers stripped", (t) => {
  const n = createCompletionNormalizer(
    baseConfig({
      capabilities: NONE_CAPS,
      toolDialect: "harmony",
    }),
  );
  const text = `<|channel|>final<|message|>Hello, world!<|return|>`;
  const events = [...pushAll(n, [text]), ...n.finish()];

  t.alike(texts(events, "contentDelta"), ["Hello, world!"]);
  const joined = texts(events, "contentDelta").join("");
  t.absent(joined.includes("<|channel|>"));
  t.absent(joined.includes("<|message|>"));
  t.absent(joined.includes("<|return|>"));
  t.is(n.getAccumulated().contentText, "Hello, world!");
});

// Final-frame inner streams as it arrives — long GPT-OSS responses must
// not stall waiting for `<|return|>`.
test("harmony content frame: inner is emitted incrementally across token chunks", (t) => {
  const n = createCompletionNormalizer(
    baseConfig({
      capabilities: NONE_CAPS,
      toolDialect: "harmony",
    }),
  );
  const chunks = [
    `<|channel|>final<|message|>Hello`,
    `, `,
    `world`,
    `!<|return|>`,
  ];
  const events = [...pushAll(n, chunks), ...n.finish()];

  const deltas = texts(events, "contentDelta");
  t.ok(
    deltas.length >= 2,
    `expected multiple contentDelta events, got ${deltas.length}`,
  );
  t.is(deltas.join(""), "Hello, world!");
  t.absent(deltas.some((d) => d.includes("<|channel|>")));
  t.absent(deltas.some((d) => d.includes("<|return|>")));
  t.is(n.getAccumulated().contentText, "Hello, world!");
});

test("harmony content frame: missing close (cutoff) flushes inner at finish", (t) => {
  const n = createCompletionNormalizer(
    baseConfig({
      capabilities: NONE_CAPS,
      toolDialect: "harmony",
    }),
  );
  // No `<|return|>` — simulates token-limit / abort cutoff inside a final frame.
  const text = `<|channel|>final<|message|>partial answer with no close`;
  const events = [...pushAll(n, [text]), ...n.finish()];

  t.alike(texts(events, "contentDelta"), ["partial answer with no close"]);
  const joined = texts(events, "contentDelta").join("");
  t.absent(joined.includes("<|channel|>"), "open marker stripped on cutoff");
  t.is(n.getAccumulated().contentText, "partial answer with no close");
});

test("harmony tool frame: parsed via parseToolCalls(dialect=harmony), emits toolCall", (t) => {
  const n = createCompletionNormalizer(
    baseConfig({
      capabilities: TEXT_PARSE_CAPS,
      tools: [GET_WEATHER_TOOL],
      toolDialect: "harmony",
    }),
  );
  const text = `<|channel|>commentary to=functions.get_weather <|constrain|>json<|message|>{"city":"Tokyo","country":"JP"}<|call|>`;
  const events = [...pushAll(n, [text]), ...n.finish()];

  const toolEvents = events.filter((e) => e.type === "toolCall");
  t.is(toolEvents.length, 1, "harmony tool frame emits toolCall");
  t.is(
    (toolEvents[0] as { call: { name: string } }).call.name,
    "get_weather",
  );
  t.alike(
    (toolEvents[0] as { call: { arguments: unknown } }).call.arguments,
    { city: "Tokyo", country: "JP" },
  );
  // Tool frame markers must not leak into content.
  const contentJoined = texts(events, "contentDelta").join("");
  t.absent(contentJoined.includes("<|channel|>"));
  t.absent(contentJoined.includes("<|call|>"));
});

test("harmony cross-token marker: commentary open split across pushes still detected", (t) => {
  const n = createCompletionNormalizer(
    baseConfig({
      capabilities: TEXT_PARSE_CAPS,
      tools: [GET_WEATHER_TOOL],
      toolDialect: "harmony",
    }),
  );
  // Split the open marker `<|channel|>commentary to=functions.` across two
  // pushes — the trailing-prefix tail buffer must hold the partial bytes.
  const events = [
    ...pushAll(n, [
      "<|channel|>commentary to=fun",
      `ctions.get_weather <|constrain|>json<|message|>{"city":"Lima"}<|call|>`,
    ]),
    ...n.finish(),
  ];

  const toolEvents = events.filter((e) => e.type === "toolCall");
  t.is(toolEvents.length, 1, "frame detected despite split open marker");
  // No marker bytes leak into content.
  const contentJoined = texts(events, "contentDelta").join("");
  t.absent(contentJoined.includes("<|channel|>"));
  t.absent(contentJoined.includes("commentary"));
});

test("harmony multi-frame: analysis → commentary in one stream, both handled", (t) => {
  const n = createCompletionNormalizer(
    baseConfig({
      capabilities: TEXT_PARSE_CAPS,
      tools: [GET_WEATHER_TOOL],
      toolDialect: "harmony",
      captureThinking: true,
    }),
  );
  const text =
    `<|channel|>analysis<|message|>I should call get_weather for Tokyo.<|end|>` +
    `<|channel|>commentary to=functions.get_weather <|constrain|>json<|message|>{"city":"Tokyo"}<|call|>`;
  const events = [...pushAll(n, [text]), ...n.finish()];

  t.alike(
    texts(events, "thinkingDelta"),
    ["I should call get_weather for Tokyo."],
  );
  t.is(events.filter((e) => e.type === "toolCall").length, 1);
  // No marker leak into content.
  const contentJoined = texts(events, "contentDelta").join("");
  t.absent(contentJoined.includes("<|channel|>"));
  t.absent(contentJoined.includes("<|message|>"));
});

// Role glue tokens (`<|start|>assistant`, etc.) sit between channel frames
// in real GPT-OSS traces — must be stripped via the dialect's `dropTokens`.
test("harmony glue tokens (<|start|>assistant between frames) do not leak into contentDelta", (t) => {
  const empiricalTrace =
    `<|channel|>analysis<|message|>We need to use tools.<|end|>` +
    `<|start|>assistant<|channel|>commentary to=functions.get_weather <|constrain|>json<|message|>{"city":"Tokyo"}<|call|>`;

  function assertClean(events: CompletionEvent[], label: string) {
    const contentJoined = texts(events, "contentDelta").join("");
    t.absent(contentJoined.includes("<|start|>"), `${label}: no <|start|> leak`);
    t.absent(contentJoined.includes("assistant"), `${label}: no role token leak`);
    t.absent(contentJoined.includes("<|channel|>"), `${label}: no <|channel|> leak`);
    t.absent(contentJoined.includes("<|end|>"), `${label}: no <|end|> leak`);
    t.absent(contentJoined.includes("<|call|>"), `${label}: no <|call|> leak`);

    const toolEvents = events.filter((e) => e.type === "toolCall");
    t.is(toolEvents.length, 1, `${label}: exactly one toolCall`);
    const call = (toolEvents[0] as { call: { name: string; arguments: { city?: string } } })
      .call;
    t.is(call.name, "get_weather", `${label}: name`);
    t.is(call.arguments.city, "Tokyo", `${label}: args.city`);
  }

  const single = createCompletionNormalizer(
    baseConfig({
      capabilities: TEXT_PARSE_CAPS,
      tools: [GET_WEATHER_TOOL],
      toolDialect: "harmony",
    }),
  );
  const singleEvents = [...pushAll(single, [empiricalTrace]), ...single.finish()];
  assertClean(singleEvents, "single chunk");
  t.is(single.getAccumulated().contentText, "", "single chunk: contentText empty");

  // Split right after `<|end|>` and again mid-`<|start|>assistant` to exercise
  // the cross-token tail-buffer for both the analysis close and the glue token.
  const splitAfterEnd = empiricalTrace.indexOf("<|end|>") + "<|end|>".length;
  const splitMidStart = splitAfterEnd + "<|sta".length;
  const chunks = [
    empiricalTrace.slice(0, splitAfterEnd),
    empiricalTrace.slice(splitAfterEnd, splitMidStart),
    empiricalTrace.slice(splitMidStart),
  ];

  const split = createCompletionNormalizer(
    baseConfig({
      capabilities: TEXT_PARSE_CAPS,
      tools: [GET_WEATHER_TOOL],
      toolDialect: "harmony",
    }),
  );
  const splitEvents = [...pushAll(split, chunks), ...split.finish()];
  assertClean(splitEvents, "multi-token split");
  t.is(split.getAccumulated().contentText, "", "split: contentText empty");
});

// Dialect must be applied regardless of tool availability — plain
// completions still need analysis/final stripping.
test("harmony dialect strips analysis/final markers even when tools array is empty", (t) => {
  const text =
    `<|channel|>analysis<|message|>thinking…<|end|>` +
    `<|start|>assistant<|channel|>final<|message|>Hello, world!<|return|>`;

  const n = createCompletionNormalizer(
    baseConfig({
      capabilities: NONE_CAPS,
      tools: [],
      toolDialect: "harmony",
    }),
  );
  const events = [...pushAll(n, [text]), ...n.finish()];

  t.is(
    texts(events, "contentDelta").join(""),
    "Hello, world!",
    "final-channel inner is the only content",
  );
  t.absent(types(events).includes("toolCall"), "no toolCall events with empty tools");
  const joined = texts(events, "contentDelta").join("");
  t.absent(joined.includes("<|channel|>"), "no <|channel|> leak");
  t.absent(joined.includes("<|start|>"), "no <|start|> leak");
  t.absent(joined.includes("<|message|>"), "no <|message|> leak");
  t.absent(joined.includes("<|end|>"), "no <|end|> leak");
  t.absent(joined.includes("<|return|>"), "no <|return|> leak");
});

test("harmony dialect with empty tools + captureThinking=true: analysis routed to thinkingDelta", (t) => {
  const text =
    `<|channel|>analysis<|message|>thinking…<|end|>` +
    `<|start|>assistant<|channel|>final<|message|>Hello, world!<|return|>`;

  const n = createCompletionNormalizer(
    baseConfig({
      capabilities: NONE_CAPS,
      tools: [],
      toolDialect: "harmony",
      captureThinking: true,
    }),
  );
  const events = [...pushAll(n, [text]), ...n.finish()];

  t.alike(texts(events, "thinkingDelta"), ["thinking…"]);
  t.is(texts(events, "contentDelta").join(""), "Hello, world!");
});

// Regression guard: the existing `<think>` reasoning and `<tool_call>`
// streaming paths must not be perturbed by the harmony spec being defined.
test("harmony spec defined but hermes dialect still strips <think> as before", (t) => {
  const n = createCompletionNormalizer(
    baseConfig({
      capabilities: THINKING_CAPS,
      captureThinking: true,
      toolDialect: "hermes",
    }),
  );
  const events = pushAll(n, ["A<think>thought</think>B"]);
  t.alike(types(events), ["contentDelta", "thinkingDelta", "contentDelta"]);
  t.alike(texts(events, "thinkingDelta"), ["thought"]);
  t.alike(texts(events, "contentDelta"), ["A", "B"]);
});
