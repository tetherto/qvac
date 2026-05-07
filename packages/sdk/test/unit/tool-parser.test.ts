// @ts-expect-error brittle has no type declarations
import test from "brittle";
import type { Tool } from "@/schemas";
import {
  parseToolCalls,
  detectToolDialectFromName,
} from "@/server/utils/tools";
import { parseHarmonyFormat } from "@/server/utils/tools/parsers/harmony";
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

const getWeatherTool: Tool = {
  type: "function",
  name: "get_weather",
  description: "Get current weather for a city",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string" },
      country: { type: "string" },
    },
    required: ["city"],
  },
};

const getHoroscopeTool: Tool = {
  type: "function",
  name: "get_horoscope",
  description: "Get today's horoscope for an astrological sign",
  parameters: {
    type: "object",
    properties: {
      sign: { type: "string" },
    },
    required: ["sign"],
  },
};

const pythonicTools: Tool[] = [getWeatherTool, getHoroscopeTool];

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

test("matched-but-failed: malformed JSON inside Hermes frame surfaces PARSE_ERROR", (t) => {
  const text = `<tool_call>
{name: "weather", arguments: {args: ["Paris"]}}
</tool_call>`;

  const { toolCalls, errors } = parseToolCalls(text, tools);
  t.is(toolCalls.length, 0);
  t.is(errors.length, 1);
  t.is(errors[0]?.code, "PARSE_ERROR");
});

test("matched-but-failed: malformed Gemma tool_calls entry surfaces PARSE_ERROR", (t) => {
  const text = JSON.stringify({
    tool_calls: [
      { arguments: { args: ["Paris"] } },
      { name: "weather", arguments: { args: ["London"] } },
    ],
  });

  const { toolCalls, errors } = parseToolCalls(text, tools);
  t.is(toolCalls.length, 1);
  t.is(toolCalls[0]?.name, "weather");
  t.is(errors.length, 1);
  t.is(errors[0]?.code, "PARSE_ERROR");
});

// Token-limit cutoff / abort / connection drop produces an open `<tool_call>`
// with no close. parseHermesFormat now recovers the inner buffer directly
// (the JSON / generic fallbacks downstream can't, because they JSON.parse the
// whole text and the `<tool_call>` prefix makes that throw).
test("incomplete Hermes frame: open without close recovers inner JSON", (t) => {
  const text = `<tool_call>
{"name": "weather", "arguments": {"args": ["Paris"]}}`;

  const { toolCalls, errors } = parseToolCalls(text, tools);
  t.is(toolCalls.length, 1);
  t.is(toolCalls[0]?.name, "weather");
  t.alike(toolCalls[0]?.arguments, { args: ["Paris"] });
  t.is(errors.length, 0);
});

// Same path also handles a truncated close-marker tail like `</tool` from a
// mid-token cutoff — strip the partial tag, then parse the inner JSON.
test("incomplete Hermes frame: truncated close-marker tail still recovers", (t) => {
  const text = `<tool_call>
{"name": "weather", "arguments": {"args": ["Paris"]}}
</tool`;

  const { toolCalls, errors } = parseToolCalls(text, tools);
  t.is(toolCalls.length, 1);
  t.is(toolCalls[0]?.name, "weather");
  t.is(errors.length, 0);
});

// Regression guard for the fix: fully-framed payload (open + close present)
// with broken inner JSON must still surface as `matched: true` + PARSE_ERROR
// — the open-without-close fall-through must NOT weaken the matched-but-
// failed semantics for complete frames.
test("matched-but-failed: complete Hermes frame with broken JSON keeps PARSE_ERROR", (t) => {
  const text = `<tool_call>
{"name": "weather", "arguments": {"args": ["Paris"],}}
</tool_call>`;

  const { toolCalls, errors } = parseToolCalls(text, tools);
  t.is(toolCalls.length, 0);
  t.is(errors.length, 1);
  t.is(errors[0]?.code, "PARSE_ERROR");
});

test("detectToolDialectFromName: LFM names and paths → pythonic", (t) => {
  const cases: Array<[string | undefined, string]> = [
    [
      "LFM_2_5_1_2B_INST_Q4_K_M",
      "/Users/x/.qvac/models/abc_lfm-2.5-1.2b-instruct-Q4_K_M.gguf",
    ],
    [
      undefined,
      "/Users/x/.qvac/models/23238f141f948551_LFM2-1.2B-Tool-Q4_K_M.gguf",
    ],
    [undefined, "/cache/abc_lfm3-7b-tool.gguf"],
    [undefined, "/cache/abc_LFM-4-Instruct.gguf"],
  ];

  for (const [name, path] of cases) {
    t.is(detectToolDialectFromName(name, path), "pythonic");
  }
});

// Single negative pin: with the explicit qwen|hermes|mistral allowlist gone,
// every non-LFM model (Qwen, Hermes, Mistral, Llama tool-calling fine-tunes,
// unknowns, empty paths) routes to "hermes" via the catch-all. The hermes
// parser chain is the catch-all; it also covers unknown JSON-payload models.
test("detectToolDialectFromName: non-LFM models default to hermes", (t) => {
  const cases: Array<[string | undefined, string]> = [
    [
      "QWEN3_1_7B_INST_Q4",
      "/Users/x/.qvac/models/abc_Qwen3-1.7B-Q4_K_M.gguf",
    ],
    [undefined, "/cache/foo_qwen3-1.7b.gguf"],
    [
      "Hermes-2-Pro-Mistral-7B",
      "/Users/x/.qvac/models/abc_Hermes-2-Pro-Mistral-7B-Q4_K_M.gguf",
    ],
    [
      "MISTRAL_7B_INSTRUCT",
      "/Users/x/.qvac/models/abc_Mistral-7B-Instruct-v0.3-Q4_K_M.gguf",
    ],
    [undefined, "/cache/abc_Mistral-Nemo-Instruct-2407.gguf"],
    // Llama tool-calling fine-tunes (mav23, nguyenthanhthuan, etc.)
    // empirically emit OpenAI-style JSON, not pythonic, so they fall through
    // the catch-all rather than being auto-routed to pythonic. Callers with
    // a pythonic-emitting Llama variant should use `completion({ toolDialect:
    // "pythonic" })` to opt in.
    [
      "LLAMA_TOOL_CALLING_1B_INST_Q4_K",
      "/Users/x/.qvac/models/abc_llama_3.2_1b_intruct_tool_calling_v2.Q4_K.gguf",
    ],
    [
      "LLAMA_3_2_1B_INST_Q4_0",
      "/Users/x/.qvac/models/abc_Llama-3.2-1B-Instruct-Q4_0.gguf",
    ],
    [undefined, "/cache/abc_Llama-3.3-70B-Instruct-Tool-Calling.gguf"],
    [undefined, ""],
    ["", ""],
  ];

  for (const [name, path] of cases) {
    t.is(detectToolDialectFromName(name, path), "hermes");
  }
});

// Regression: catch-all "hermes" dialect must still recover Gemma /
// bare-llamacpp JSON with nested arguments via the chain's JSON fallbacks
// (the generic regex alone stops at the first nested `}`).
test("hermes (catch-all) recovers Gemma {tool_calls:[]} with nested arguments", (t) => {
  const text = `{"tool_calls":[{"name":"weather","arguments":{"args":["Paris"]}}]}`;
  const { toolCalls, errors } = parseToolCalls(text, tools, "hermes");
  t.is(errors.length, 0);
  t.is(toolCalls.length, 1);
  t.is(toolCalls[0]?.name, "weather");
  t.alike(toolCalls[0]?.arguments, { args: ["Paris"] });
});

test("hermes (catch-all) recovers bare llamacpp {name,arguments} with nested arguments", (t) => {
  const text = `{"name":"weather","arguments":{"args":["Paris"]}}`;
  const { toolCalls, errors } = parseToolCalls(text, tools, "hermes");
  t.is(errors.length, 0);
  t.is(toolCalls.length, 1);
  t.is(toolCalls[0]?.name, "weather");
  t.alike(toolCalls[0]?.arguments, { args: ["Paris"] });
});

test("json dialect recovers Gemma {tool_calls:[]} with nested arguments", (t) => {
  const text = `{"tool_calls":[{"name":"weather","arguments":{"args":["Paris"]}}]}`;
  const { toolCalls, errors } = parseToolCalls(text, tools, "json");
  t.is(errors.length, 0);
  t.is(toolCalls.length, 1);
  t.is(toolCalls[0]?.name, "weather");
  t.alike(toolCalls[0]?.arguments, { args: ["Paris"] });
});

test("json dialect recovers bare llamacpp {name,arguments} with nested arguments", (t) => {
  const text = `{"name":"weather","arguments":{"args":["Paris"]}}`;
  const { toolCalls, errors } = parseToolCalls(text, tools, "json");
  t.is(errors.length, 0);
  t.is(toolCalls.length, 1);
  t.is(toolCalls[0]?.name, "weather");
  t.alike(toolCalls[0]?.arguments, { args: ["Paris"] });
});

// Pins why the structured-JSON fallbacks are needed: the generic regex's
// lazy `\}` matches the first nested `}` inside `arguments`.
test("parseGenericFormat alone CANNOT recover nested arguments (chain ordering matters)", (t) => {
  // Pythonic dialect skips JSON parsers, forcing the generic-only path.
  const text = `{"name":"weather","arguments":{"args":["Paris"]}}`;
  const { toolCalls } = parseToolCalls(text, tools, "pythonic");
  t.is(
    toolCalls.length,
    0,
    "generic regex fallback drops the outer brace on nested args",
  );
});

// Real LFM2-Tool output shape — bare `[func(...), func(...)]` array.
test("pythonic: bare LFM-style multi-call → 2 calls with correct names + args", (t) => {
  const text = `[get_weather(city="Tokyo", country="JP"), get_horoscope(sign="Aquarius")]`;

  const { toolCalls, errors } = parseToolCalls(text, pythonicTools);
  t.is(errors.length, 0);
  t.is(toolCalls.length, 2);
  t.is(toolCalls[0]?.name, "get_weather");
  t.alike(toolCalls[0]?.arguments, { city: "Tokyo", country: "JP" });
  t.is(toolCalls[1]?.name, "get_horoscope");
  t.alike(toolCalls[1]?.arguments, { sign: "Aquarius" });
});

test("pythonic: single-quoted strings supported", (t) => {
  const text = `[get_weather(city='Paris', country='FR')]`;
  const { toolCalls } = parseToolCalls(text, pythonicTools);
  t.is(toolCalls.length, 1);
  t.alike(toolCalls[0]?.arguments, { city: "Paris", country: "FR" });
});

test("pythonic: True/False/None coerce to true/false/null", (t) => {
  const text = `[weather(args=[True, False, None])]`;
  const { toolCalls, errors } = parseToolCalls(text, tools);
  t.is(errors.length, 0);
  t.is(toolCalls.length, 1);
  t.alike(toolCalls[0]?.arguments.args, [true, false, null]);
});

test("pythonic: nested list and dict args preserved", (t) => {
  const text = `[weather(args=[1, 2, [3, 4], {"a": 1, "b": "two"}])]`;
  const { toolCalls, errors } = parseToolCalls(text, tools);
  t.is(errors.length, 0);
  t.is(toolCalls.length, 1);
  t.alike(toolCalls[0]?.arguments.args, [1, 2, [3, 4], { a: 1, b: "two" }]);
});

test("pythonic: numeric args (negative, float, scientific)", (t) => {
  const text = `[weather(args=[-1, 3.14, 1e3, -2.5e-2])]`;
  const { toolCalls, errors } = parseToolCalls(text, tools);
  t.is(errors.length, 0);
  t.alike(toolCalls[0]?.arguments.args, [-1, 3.14, 1000, -0.025]);
});

test("pythonic: wrapped call forms supported", (t) => {
  const cases = [
    `<|tool_call_start|>[get_weather(city="Paris")]<|tool_call_end|>`,
    `<|start_header_id|>tool_call<|end_header_id|>[get_weather(city="Paris")]<|eot_id|>`,
  ];

  for (const text of cases) {
    const { toolCalls } = parseToolCalls(text, pythonicTools);
    t.is(toolCalls.length, 1);
    t.alike(toolCalls[0]?.arguments, { city: "Paris" });
  }
});

test("pythonic: empty array → matched, no calls, no errors", (t) => {
  const text = `[]`;
  const { toolCalls, errors } = parseToolCalls(text, pythonicTools);
  t.is(toolCalls.length, 0);
  t.is(errors.length, 0);
});

test("pythonic: malformed (unclosed paren) → matched + PARSE_ERROR", (t) => {
  const text = `[get_weather(city="Paris"]`;
  const { toolCalls, errors } = parseToolCalls(text, pythonicTools);
  t.is(toolCalls.length, 0);
  t.is(errors.length, 1);
  t.is(errors[0]?.code, "PARSE_ERROR");
});

test("pythonic: malformed (positional arg without =) → matched + PARSE_ERROR", (t) => {
  const text = `[get_weather("Paris")]`;
  const { toolCalls, errors } = parseToolCalls(text, pythonicTools);
  t.is(toolCalls.length, 0);
  t.is(errors.length, 1);
  t.is(errors[0]?.code, "PARSE_ERROR");
});

test("pythonic: unknown tool → matched + UNKNOWN_TOOL error", (t) => {
  const text = `[unknown_tool(x=1)]`;
  const { toolCalls, errors } = parseToolCalls(text, pythonicTools);
  t.is(toolCalls.length, 0);
  t.is(errors.length, 1);
  t.is(errors[0]?.code, "UNKNOWN_TOOL");
});

test("pythonic: no array shape in text → matched=false, falls through", (t) => {
  const text = `Sorry, I can't help with that.`;
  const { toolCalls, errors } = parseToolCalls(text, pythonicTools);
  t.is(toolCalls.length, 0);
  t.is(errors.length, 0);
});

test("pythonic: bare locator and forgiving string forms", (t) => {
  const cases: Array<[string, string]> = [
    [`[get_weather(city="Paris")]`, "Paris"],
    [`Sure, let me check that.\n[get_weather(city="Paris")]`, "Paris"],
    [`[get_weather(city="say \\"hi\\"")]`, 'say "hi"'],
    [`[get_weather(city=Paris)]`, "Paris"],
    [`[get_weather(city="Paris",)]`, "Paris"],
  ];

  for (const [text, city] of cases) {
    const { toolCalls, errors } = parseToolCalls(text, pythonicTools);
    t.is(errors.length, 0);
    t.is(toolCalls.length, 1);
    t.is(toolCalls[0]?.arguments.city, city);
  }
});

// Some Llama tool-calling fine-tunes emit JSON answers instead of Pythonic;
// the locator must not falsely match this shape.
test("pythonic: does not eat top-level JSON tool-call shapes", (t) => {
  const text = `{
  "weather": "Partly cloudy",
  "horoscope": "Today is a great day."
}`;
  const { toolCalls, errors } = parseToolCalls(text, pythonicTools);
  t.is(toolCalls.length, 0);
  t.is(errors.length, 0);
});

// Override semantics: parseToolCalls must respect the supplied dialect, not
// re-detect from text shape. This pins the contract behind the public
// `completion({ toolDialect })` override — given a dialect, the chain only
// runs the parsers scoped to that dialect.
test("parseToolCalls(dialect=pythonic): bare Pythonic parses, JSON shapes ignored", (t) => {
  // Bare Pythonic — must parse via parsePythonicFormat.
  const pythonicText = `[get_weather(city="Lima")]`;
  const pythonicResult = parseToolCalls(pythonicText, pythonicTools, "pythonic");
  t.is(pythonicResult.toolCalls.length, 1, "pythonic parses bare call");
  t.is(pythonicResult.toolCalls[0]?.name, "get_weather");

  // JSON tool-call shape — must NOT match in the pythonic chain (no JSON
  // parsers are wired for "pythonic"), confirming dialect scoping is honoured.
  const jsonText = `{"name":"get_weather","arguments":{"city":"Lima"}}`;
  const jsonResult = parseToolCalls(jsonText, pythonicTools, "pythonic");
  t.is(jsonResult.toolCalls.length, 0, "pythonic chain does not pick up JSON shape");
});

test("parseToolCalls(dialect=hermes): Hermes wrap and bare JSON both parse, Pythonic ignored", (t) => {
  // Hermes-wrapped JSON.
  const hermesText = `<tool_call>{"name":"get_weather","arguments":{"city":"Lima"}}</tool_call>`;
  const hermesResult = parseToolCalls(hermesText, pythonicTools, "hermes");
  t.is(hermesResult.toolCalls.length, 1, "hermes parses wrapped JSON");

  // Bare JSON falls through to the JSON parsers in the hermes chain.
  const jsonText = `{"name":"get_weather","arguments":{"city":"Lima"}}`;
  const jsonResult = parseToolCalls(jsonText, pythonicTools, "hermes");
  t.is(jsonResult.toolCalls.length, 1, "hermes chain recovers bare JSON via fallback");

  // Pythonic-only payload — must NOT match in the hermes chain.
  const pythonicText = `[get_weather(city="Lima")]`;
  const pythonicResult = parseToolCalls(pythonicText, pythonicTools, "hermes");
  t.is(pythonicResult.toolCalls.length, 0, "hermes chain does not pick up pythonic shape");
});

// Harmony dialect — GPT-OSS native tool-call frame format.
test("parseToolCalls(dialect=harmony): single Harmony frame parses", (t) => {
  const text = `<|channel|>commentary to=functions.get_weather <|constrain|>json<|message|>{"city":"Tokyo","country":"JP"}<|call|>`;
  const { toolCalls, errors } = parseToolCalls(text, pythonicTools, "harmony");
  t.is(errors.length, 0);
  t.is(toolCalls.length, 1);
  t.is(toolCalls[0]?.name, "get_weather");
  t.alike(toolCalls[0]?.arguments, { city: "Tokyo", country: "JP" });
});

test("parseToolCalls(dialect=harmony): with surrounding analysis frame", (t) => {
  const text =
    `<|channel|>analysis<|message|>The user wants weather. I'll call get_weather.<|end|>` +
    `<|channel|>commentary to=functions.get_weather <|constrain|>json<|message|>{"city":"Lima"}<|call|>`;
  const { toolCalls, errors } = parseToolCalls(text, pythonicTools, "harmony");
  t.is(errors.length, 0);
  t.is(toolCalls.length, 1);
  t.is(toolCalls[0]?.name, "get_weather");
  t.alike(toolCalls[0]?.arguments, { city: "Lima" });
});

// `<|channel|>` alone (analysis/final frames) must not promote the parser
// to `matched: true` — only `to=functions.` is uniquely Harmony.
test("parseHarmonyFormat: <|channel|> alone (no to=functions.) returns matched: false", (t) => {
  const text = `<|channel|>analysis<|message|>thinking only<|end|>`;
  const result = parseHarmonyFormat(text, pythonicTools);
  t.is(result.matched, false, "no to=functions. → matched=false");
  t.is(result.toolCalls.length, 0);
  t.is(result.errors.length, 0);
});

test("parseHarmonyFormat: to=functions. without <|channel|> still matches and parses", (t) => {
  const text = `to=functions.get_weather <|constrain|>json<|message|>{"city":"Paris"}<|call|>`;
  const result = parseHarmonyFormat(text, pythonicTools);
  t.is(result.matched, true);
  t.is(result.toolCalls.length, 1);
  t.is(result.toolCalls[0]?.name, "get_weather");
});

test("parseToolCalls(default): analysis-only buffer falls through to fallbacks (no Harmony short-circuit)", (t) => {
  const text = `<|channel|>analysis<|message|>I should think about this.<|end|>`;
  const { toolCalls, errors } = parseToolCalls(text, pythonicTools);
  t.is(toolCalls.length, 0);
  t.is(errors.length, 0);
});

// `to=functions.X` without the full `<|constrain|>json<|message|>...<|call|>`
// shape must fall through, not short-circuit the chain.
test("parseHarmonyFormat: to=functions. without complete frame returns matched: false", (t) => {
  const text = `Some preamble mentioning to=functions.get_weather without the constrain marker.`;
  const result = parseHarmonyFormat(text, pythonicTools);
  t.is(result.matched, false, "no extracted frames → matched=false");
  t.is(result.toolCalls.length, 0);
  t.is(result.errors.length, 0);
});

// Hyphenated names are valid per OpenAI's `[a-zA-Z0-9_-]{1,64}` and pass
// the SDK's `name: z.string()` schema — must not silently drop.
test("parseHarmonyFormat: hyphenated function names parse", (t) => {
  const hyphenTool: Tool = {
    type: "function",
    name: "get-weather",
    description: "Get current weather",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  };
  const text = `<|channel|>commentary to=functions.get-weather <|constrain|>json<|message|>{"city":"Tokyo"}<|call|>`;
  const result = parseHarmonyFormat(text, [hyphenTool]);
  t.is(result.matched, true);
  t.is(result.toolCalls.length, 1);
  t.is(result.toolCalls[0]?.name, "get-weather");
  t.alike(result.toolCalls[0]?.arguments, { city: "Tokyo" });
  t.is(result.errors.length, 0);
});

// Complete frame whose payload fails JSON.parse: matched=true (the parser
// recognised its format) but the call surfaces as a PARSE_ERROR rather than
// a silently dropped frame.
test("parseHarmonyFormat: complete frame with malformed JSON surfaces PARSE_ERROR", (t) => {
  const text = `<|channel|>commentary to=functions.get_weather <|constrain|>json<|message|>{"city":"Tokyo",}<|call|>`;
  const result = parseHarmonyFormat(text, pythonicTools);
  t.is(result.matched, true);
  t.is(result.toolCalls.length, 0);
  t.is(result.errors.length, 1);
  t.is(result.errors[0]?.code, "PARSE_ERROR");
});

test("parseToolCalls(default): Harmony frame in default chain still parses", (t) => {
  // Default chain (with parseHarmonyFormat first) must still pick up Harmony
  // frames so unrouted models that emit them are recovered.
  const text = `<|channel|>commentary to=functions.get_weather <|constrain|>json<|message|>{"city":"Paris"}<|call|>`;
  const { toolCalls } = parseToolCalls(text, pythonicTools);
  t.is(toolCalls.length, 1);
  t.is(toolCalls[0]?.name, "get_weather");
  t.alike(toolCalls[0]?.arguments, { city: "Paris" });
});

test("detectToolDialectFromName: GPT-OSS variants → harmony", (t) => {
  const cases: Array<[string | undefined, string]> = [
    ["gpt-oss-20b", "/cache/gpt-oss-20b-Q4_K_M.gguf"],
    [
      "GPT_OSS_120B_INST_Q4_K_M",
      "/Users/x/.qvac/models/abc_gpt-oss-120b-Q4_K_M.gguf",
    ],
    [undefined, "/cache/abc_gpt_oss_20b_q4.gguf"],
    [undefined, "/cache/abc_gpt-oss-20b.gguf"],
    ["GPTOSS-20B", "/cache/gptoss-20b.gguf"],
  ];

  for (const [name, path] of cases) {
    t.is(detectToolDialectFromName(name, path), "harmony", `name=${name} path=${path}`);
  }
});
