# 🔌 API Changes v0.7.0

## Ffmpeg-backed mp3/opus/aac/flac encoding for POST /v1/audio/speech

PR: [#2451](https://github.com/tetherto/qvac/pull/2451)

```
GET /v1/audio/voices  →  { object: "list", voices: string[], data: [{ id, object: "audio.voice", model }] }
GET /v1/audio/models  →  { object: "list", data: [{ id, object: "model", created, owned_by }] }
```

---

## Finish_reason=length + unified token accounting across chat-category routes

PR: [#2477](https://github.com/tetherto/qvac/pull/2477)

```typescript
// finish_reason now reflects truncation
{ finish_reason: "length" }  // when max_tokens cuts generation short (was always "stop")

// Responses API — length truncation (blocking)
{ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }
// Responses API — length truncation (streaming)
{ type: "response.incomplete" }  // was "response.completed"

// completion_tokens: now consistently uses stats.generatedTokens (with whitespace-split fallback)
// across /v1/chat/completions, /v1/completions, and /v1/responses
```

---

## Img2vid for POST /v1/videos

PR: [#2481](https://github.com/tetherto/qvac/pull/2481)

```typescript
import OpenAI, { toFile } from 'openai'
import fs from 'node:fs'

const client = new OpenAI({ baseURL: 'http://localhost:11434/v1' })

const job = await client.videos.create({
  model: 'wan-i2v',
  prompt: 'subject slowly turns and smiles',
  input_reference: await toFile(fs.createReadStream('./frame.png'), 'frame.png'),
})
```

```typescript
const job = await client.videos.create({
  model: 'wan-i2v',
  prompt: 'subject slowly turns and smiles',
  input_reference: { image_url: 'data:image/png;base64,...' },
})
```

---

