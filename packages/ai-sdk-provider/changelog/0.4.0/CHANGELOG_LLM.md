# QVAC AI SDK Provider v0.4.0 Release Notes

Release Date: 2026-07-27

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.4.0

This release migrates `@qvac/ai-sdk-provider` to AI SDK 7, adds native files / speech / transcription contracts on top of the OpenAI-compatible transport, and requires `@qvac/cli` 0.9 for managed mode so callers pick up the latest serve fixes through the published package graph.

## Breaking Changes

### AI SDK 7 and Node 22

The provider now depends on AI SDK 7 (`ai@^7`) and `@ai-sdk/openai-compatible@^3`. Node 20 is no longer supported; runtimes must be Node 22 or newer.

**Before:**

```bash
npm install @qvac/ai-sdk-provider ai@^6 @ai-sdk/openai-compatible@^2
```

**After:**

```bash
npm install @qvac/ai-sdk-provider ai@^7 @ai-sdk/openai-compatible@^3
```

Language, embedding, and image calls keep the same OpenAI-compatible wire shape. Custom middleware and direct model integrations must use the AI SDK v4 provider interfaces that ship with these versions.

### Managed Mode Requires CLI 0.9

The optional `@qvac/cli` peer for managed mode is now `^0.9.0` only. Older CLI minors (`0.6`–`0.8`) are no longer accepted, so managed installs resolve the CLI 0.9 / SDK 0.16 runtime that includes the latest serve fixes.

**Before:**

```json
{ "peerDependencies": { "@qvac/cli": "^0.6.0 || ^0.7.0 || ^0.8.0" } }
```

**After:**

```json
{ "peerDependencies": { "@qvac/cli": "^0.9.0" } }
```

Install managed mode with:

```bash
npm install @qvac/ai-sdk-provider ai @ai-sdk/openai-compatible @qvac/cli@^0.9.0
```

## Native Files, Speech, and Transcription

External and managed providers now expose QVAC-native `files()`, `transcriptionModel()`, and `speechModel()` contracts composed over the existing OpenAI-compatible fallback. Local `uploadFile` references resolve through the running `qvac serve` process instead of becoming cloud URLs.

```ts
import { createQvac } from '@qvac/ai-sdk-provider'
import { generateText, uploadFile } from 'ai'
import { readFileSync } from 'node:fs'

const qvac = createQvac({ baseURL: 'http://127.0.0.1:11434/v1', apiKey: 'qvac' })

const file = await uploadFile({
  provider: qvac,
  file: readFileSync('./note.txt'),
  mediaType: 'text/plain'
})

const { text } = await generateText({
  model: qvac('qwen3.5-9b'),
  messages: [
    {
      role: 'user',
      content: [
        { type: 'file', data: file },
        { type: 'text', text: 'Summarize this.' }
      ]
    }
  ]
})
```

## Model Constant Refresh

The mirrored model constant surface picks up the latest TTS-ggml / Parler TTS exports and drops retired Parakeet and older Chatterbox / Supertonic constants that the SDK registry no longer publishes. See `models.md` for the full added and removed lists.

## Compatibility

`createQvac()` external mode remains the default synchronous path. Managed mode (`mode: 'managed'`) keeps the same options shape (`models`, `reuse`, `closeOnParentExit`, timeouts) and still returns a `ManagedQvacProvider` with `baseURL` / `port` / `pid` / `close()`.
