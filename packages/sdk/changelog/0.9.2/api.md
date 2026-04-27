# 🔌 API Changes v0.9.2

## Add sentence-level streaming for onnx text-to-speech

PR: [#1590](https://github.com/tetherto/qvac/pull/1590)

```typescript
import { loadModel, textToSpeech, unloadModel } from "@qvac/sdk";

const modelId = await loadModel({ /* ...Supertonic ONNX TTS config... */ });

const result = textToSpeech({
  modelId,
  text: "Your long passage here.",
  inputType: "text",
  stream: true,
  sentenceStream: true,
  sentenceStreamLocale: "en",
});

for await (const chunk of result.chunkUpdates!) {
  // chunk.buffer      -> int16 PCM samples for this sentence
  // chunk.chunkIndex  -> 0-based sentence index
  // chunk.sentenceChunk -> source text for this chunk
}

await result.done;
await unloadModel({ modelId });
```

```typescript
import { completion, textToSpeechStream } from "@qvac/sdk";

const session = await textToSpeechStream({
  modelId: ttsModelId,
  inputType: "text",
  accumulateSentences: true,
  sentenceDelimiterPreset: "latin", // "latin" | "cjk" | "multilingual"
  flushAfterMs: 400,
});

(async () => {
  for await (const delta of completion({ modelId: llmModelId, /* ... */ }).tokenStream) {
    session.write(delta);
  }
  session.end();
})();

for await (const chunk of session) {
  // chunk.buffer       -> int16 PCM for this sentence / flush window
  // chunk.chunkIndex   -> optional sentence index
  // chunk.sentenceChunk-> optional source text
  if (chunk.done) break;
}
```

---

## Make auto KV-cache reuse completed turn history

PR: [#1705](https://github.com/tetherto/qvac/pull/1705)

```typescript
// New: `final.cacheableAssistantContent` — the canonical assistant
// string the SDK persisted to the auto-cache key on this turn.
// Push it back into `history` verbatim to guarantee a next-turn hit.
const run = completion({ modelId, history, kvCache: true });
for await (const _ of run.tokenStream) { /* stream */ }
const final = await run.final;
const nextHistory = [
  ...history,
  {
    role: "assistant",
    // Falls back to contentText for tool-call turns, which can't
    // be auto-cached today and therefore omit the field.
    content: final.cacheableAssistantContent ?? final.contentText,
  },
  { role: "user", content: "follow-up question" },
];
```

---

## Propagate registry download retries and expose stream timeout

PR: [#1743](https://github.com/tetherto/qvac/pull/1743)

```ts
import { setSDKConfig } from "@qvac/sdk";

setSDKConfig({
  // Retry REQUEST_TIMEOUT failures up to N times before giving up.
  // Set to 0 to disable retries entirely.
  registryDownloadMaxRetries: 5,

  // Raise the per-block stream timeout for slow/high-latency links
  // (default: 60_000 ms).
  registryStreamTimeoutMs: 180_000,
});
```

---

