// @ts-expect-error brittle has no type declarations
import test from "brittle";
import {
  buildAutoCacheSaveHistory,
  getAutoCacheLookupHistory,
} from "@/server/utils/cache/auto-history";
import { buildFinalFromEvents } from "@/utils/aggregate-events";
import { normalizeAssistantCacheContent } from "@/utils/cache-normalize";

test("auto kv-cache history: next-turn lookup matches prior saved turn", (t) => {
  const firstTurnHistory = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "What is the capital of France?" },
  ];

  const savedHistory = buildAutoCacheSaveHistory(firstTurnHistory, "Paris.");
  const nextTurnHistory = [
    ...savedHistory,
    { role: "user", content: "What about Germany?" },
  ];

  t.alike(getAutoCacheLookupHistory(nextTurnHistory), savedHistory);
});

test("auto kv-cache history: no lookup target for first turn", (t) => {
  t.alike(
    getAutoCacheLookupHistory([
      { role: "user", content: "What is the capital of France?" },
    ]),
    [],
  );
});

test("auto kv-cache history: lookup hits regardless of caller-side assistant trim", (t) => {
  const turn1 = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "What is the capital of France?" },
  ];

  const rawResponse = "  Paris.\n";
  const savedHistory = buildAutoCacheSaveHistory(turn1, rawResponse);

  const nextTurnTrimmed = [
    ...turn1,
    { role: "assistant", content: rawResponse.trim() },
    { role: "user", content: "What about Germany?" },
  ];

  const nextTurnUntrimmed = [
    ...turn1,
    { role: "assistant", content: rawResponse },
    { role: "user", content: "What about Germany?" },
  ];

  const savedKey = JSON.stringify(savedHistory);
  t.is(JSON.stringify(getAutoCacheLookupHistory(nextTurnTrimmed)), savedKey);
  t.is(JSON.stringify(getAutoCacheLookupHistory(nextTurnUntrimmed)), savedKey);
});

test("auto kv-cache history: lookup normalizes every assistant turn, not just the last", (t) => {
  const baseTurns = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Q1" },
  ];
  const afterTurn1 = buildAutoCacheSaveHistory(baseTurns, "  A1\n");
  const afterTurn1PlusUser = [
    ...afterTurn1,
    { role: "user", content: "Q2" },
  ];
  const afterTurn2 = buildAutoCacheSaveHistory(afterTurn1PlusUser, "\tA2 ");

  const turn3CallerHistory = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Q1" },
    { role: "assistant", content: "  A1\n" },
    { role: "user", content: "Q2" },
    { role: "assistant", content: "\tA2 " },
    { role: "user", content: "Q3" },
  ];

  t.is(
    JSON.stringify(getAutoCacheLookupHistory(turn3CallerHistory)),
    JSON.stringify(afterTurn2),
  );
});

test("auto kv-cache history: normalizer is the single source of truth", (t) => {
  const raw = "  hello world\n\n";
  const normalized = normalizeAssistantCacheContent(raw);

  const saved = buildAutoCacheSaveHistory(
    [{ role: "user", content: "hi" }],
    raw,
  );
  t.is(saved[saved.length - 1].content, normalized);

  const lookup = getAutoCacheLookupHistory([
    { role: "user", content: "hi" },
    { role: "assistant", content: raw },
    { role: "user", content: "next" },
  ]);
  t.is(lookup[lookup.length - 1].content, normalized);
});

test("auto kv-cache history: think blocks normalize away on save and lookup", (t) => {
  const turn1 = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "What is the capital of France?" },
  ];

  const rawWithThink = "<think>Let me recall European capitals.</think>Paris.";
  const savedHistory = buildAutoCacheSaveHistory(turn1, rawWithThink);

  t.is(savedHistory[savedHistory.length - 1].content, "Paris.");

  const nextTurnContentText = [
    ...turn1,
    { role: "assistant", content: "Paris." },
    { role: "user", content: "What about Germany?" },
  ];

  const nextTurnRaw = [
    ...turn1,
    { role: "assistant", content: rawWithThink },
    { role: "user", content: "What about Germany?" },
  ];

  const savedKey = JSON.stringify(savedHistory);
  t.is(JSON.stringify(getAutoCacheLookupHistory(nextTurnContentText)), savedKey);
  t.is(JSON.stringify(getAutoCacheLookupHistory(nextTurnRaw)), savedKey);
});

test("auto kv-cache history: multiple think blocks and surrounding whitespace", (t) => {
  const raw =
    "  <think>step 1</think>\n\nThe answer is <think>double-check</think>42.\n";

  const saved = buildAutoCacheSaveHistory(
    [{ role: "user", content: "Q" }],
    raw,
  );
  t.is(saved[saved.length - 1].content, "The answer is 42.");

  const lookup = getAutoCacheLookupHistory([
    { role: "user", content: "Q" },
    { role: "assistant", content: raw },
    { role: "user", content: "next" },
  ]);
  t.is(lookup[lookup.length - 1].content, "The answer is 42.");
});

test("auto kv-cache history: unclosed trailing think block normalizes away", (t) => {
  const rawUnclosed = "Partial answer.<think>still thinking";
  const saved = buildAutoCacheSaveHistory(
    [{ role: "user", content: "Q" }],
    rawUnclosed,
  );
  t.is(saved[saved.length - 1].content, "Partial answer.");

  const lookup = getAutoCacheLookupHistory([
    { role: "user", content: "Q" },
    { role: "assistant", content: "Partial answer." },
    { role: "user", content: "next" },
  ]);
  t.is(lookup[lookup.length - 1].content, "Partial answer.");
});

test("auto kv-cache: final.cacheableAssistantContent matches server-saved assistant content", (t) => {
  const rawFromAddon = "  <think>reasoning</think>Paris.\n";
  const events = [
    { type: "thinkingDelta" as const, seq: 0, text: "reasoning" },
    { type: "contentDelta" as const, seq: 1, text: "Paris." },
    {
      type: "completionDone" as const,
      seq: 2,
      raw: { fullText: rawFromAddon },
    },
  ];
  const { final } = buildFinalFromEvents(events, new Map());

  const savedHistory = buildAutoCacheSaveHistory(
    [{ role: "user", content: "What is the capital of France?" }],
    rawFromAddon,
  );
  const savedAssistantContent =
    savedHistory[savedHistory.length - 1]!.content;

  t.is(
    final.cacheableAssistantContent,
    savedAssistantContent,
    "client-canonical and server-saved content must be byte-identical",
  );
});

test("auto kv-cache history: lookup leaves non-assistant messages untouched", (t) => {
  const userContent = "  raw user input\n";
  const lookup = getAutoCacheLookupHistory([
    { role: "system", content: "  sys  " },
    { role: "user", content: userContent },
    { role: "user", content: "next" },
  ]);

  t.is(lookup[0].content, "  sys  ");
  t.is(lookup[1].content, userContent);
});
