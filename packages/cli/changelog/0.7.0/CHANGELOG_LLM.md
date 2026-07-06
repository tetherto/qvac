# QVAC CLI v0.7.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/cli/v/0.7.0

This release adds image-to-video generation and audio encoding to the OpenAI-compatible HTTP server. It also fixes token accounting and `finish_reason` reporting across all chat-category routes.

## New Features

### Image-to-video via POST /v1/videos

`POST /v1/videos` now supports img2vid in addition to txt2vid. Supply the reference image as a multipart file field (the form the OpenAI SDK sends for `Uploadable`), as a JSON `{ image_url }` (base64 data URI or HTTP(S) URL up to 100 MB), or as a JSON `{ file_id }` referencing a previously uploaded file. Mode is inferred automatically from the presence of `input_reference`.

```typescript
import OpenAI, { toFile } from 'openai'
import fs from 'node:fs'

const client = new OpenAI({ baseURL: 'http://localhost:11434/v1' })

// img2vid via local file (multipart)
const job = await client.videos.create({
  model: 'wan-i2v',
  prompt: 'subject slowly turns and smiles',
  input_reference: await toFile(fs.createReadStream('./frame.png'), 'frame.png')
})

// img2vid via data URI (JSON)
const job2 = await client.videos.create({
  model: 'wan-i2v',
  prompt: 'subject slowly turns and smiles',
  input_reference: { image_url: 'data:image/png;base64,...' }
})
```

### Audio encoding — mp3, opus, aac, flac

`POST /v1/audio/speech` now supports `response_format: "mp3"`, `"opus"`, `"aac"`, and `"flac"` in addition to `wav` and `pcm`. Encoding is handled by `ffmpeg` on the server's `PATH`; if ffmpeg is absent, these formats return `503 transcode_unavailable`. Use `qvac doctor` to check availability.

Two new discovery endpoints are also available:

```
GET /v1/audio/voices  →  list of configured TTS voices
GET /v1/audio/models  →  list of loaded (READY) TTS models
```

## Bug Fixes

### Correct finish_reason and token accounting

`finish_reason: "length"` is now returned when generation is truncated by `max_tokens` or `max_completion_tokens` (previously always `"stop"`). The Responses API equivalent is `status: "incomplete"` with `incomplete_details.reason: "max_output_tokens"`. Token counts (`completion_tokens` / `output_tokens`) now consistently use the SDK's `generatedTokens` stats across `/v1/chat/completions`, `/v1/completions`, and `/v1/responses`.
