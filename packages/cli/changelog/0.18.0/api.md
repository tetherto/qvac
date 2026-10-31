# 🔌 API Changes v0.18.0

## Surface context overflow and close failed HTTP streams

PR: [#4834](https://github.com/tetherto/qvac/pull/4834)

```json
{
  "error": {
    "code": "context_length_exceeded",
    "type": "invalid_request_error",
    "message": "The request exceeds the model's context capacity. Shorten the input, start a new conversation, or increase ctx_size."
  }
}
```

---

## Assess ESRGAN and ABot world memory fit

PR: [#5038](https://github.com/tetherto/qvac/pull/5038)

```bash
# Load-time fit checks and POST /qvac/v1/models/fit now cover ESRGAN upscalers and ABot world
# sessions. A world alias can set world.fitSteps (default 100) for the estimated walk length.
curl -sS http://localhost:11434/qvac/v1/models/fit \
  -H "Content-Type: application/json" \
  -d '{"models":[{"model":"upscaler"}]}'
```

---

## Serve OCR on /qvac/v1/ocr

PR: [#5290](https://github.com/tetherto/qvac/pull/5290)

```bash
curl -sS http://localhost:11434/qvac/v1/ocr -F model=ocr-en -F image=@receipt.png
# { "object": "ocr", "model": "ocr-en", "blocks": [{ "text": "...", "bbox": [...], "confidence": 0.98 }], "stats": { ... } }
```

---

## Support Qwen-Image-2.1 generation and reference editing

PR: [#5302](https://github.com/tetherto/qvac/pull/5302)

```bash
curl -sS http://127.0.0.1:11434/v1/images/edits \
  -F "image[]=@reference-a.png" \
  -F "image[]=@reference-b.png" \
  -F "model=my-diffusion" \
  -F "prompt=Place the referenced subjects together in one scene."
```

---

## Serve image classification on /qvac/v1/classifications

PR: [#5317](https://github.com/tetherto/qvac/pull/5317)

```bash
curl -sS http://localhost:11434/qvac/v1/classifications -F model=classifier -F image=@photo.jpg
# { "object": "classification", "model": "classifier", "results": [{ "label": "food", "confidence": 0.93 }, ...] }
```

---

## Serve image upscale on /qvac/v1/images/upscale

PR: [#5318](https://github.com/tetherto/qvac/pull/5318)

```bash
curl -sS http://localhost:11434/qvac/v1/images/upscale \
  -F model=upscaler -F image=@photo.png -F repeats=1
# → { "created": …, "output_format": "png", "size": "4x4", "data": [{ "b64_json": "…" }] }
```

---

## Serve music generation, edits and understanding on /qvac/v1/audio

PR: [#5355](https://github.com/tetherto/qvac/pull/5355)

```bash
curl -sS http://localhost:11434/qvac/v1/audio/generations -H 'Content-Type: application/json' \
  -d '{ "model": "music", "caption": "calm lofi piano", "lyrics": "[Instrumental]", "duration": 30 }'
# { "id": "audiogen_…", "object": "audio.generation", "status": "queued", … }

curl -sS http://localhost:11434/qvac/v1/audio/edits \
  -F model=music \
  -F sourceAudio=@song.wav \
  -F 'operations=[{"type":"repaint","caption":"analog synth solo","start":10,"end":20}]'

# WAV by default; mp3, flac, opus or aac through the system ffmpeg
curl -sS "http://localhost:11434/qvac/v1/audio/generations/audiogen_…/content?format=mp3" -o song.mp3

curl -sS http://localhost:11434/qvac/v1/audio/understandings -F model=music -F sourceAudio=@song.wav
```

---

## Serve the live model registry on /qvac/v1/registry

PR: [#5356](https://github.com/tetherto/qvac/pull/5356)

```bash
curl -sS "http://localhost:11434/qvac/v1/registry/models?addon=llm&search=qwen3&limit=1"
# { "object": "list", "data": [{ "name": "Qwen3-0.6B-Q4_0", "registrySource": "hf", "registryPath": "...", ... }], "has_more": true }

curl -sS "http://localhost:11434/qvac/v1/registry/models/lookup?registrySource=hf&registryPath=org/missing.gguf"
# 404 { "error": { "code": "model_not_found", ... } }
```

---
