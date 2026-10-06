# 🔌 API Changes v0.15.0

## Opt-in deferred tool loading and tool_search

PR: [#4602](https://github.com/tetherto/qvac/pull/4602)

`POST /v1/chat/completions` and `POST /v1/responses` accept `defer_loading: true` (and an optional `group`) on a tool entry or on its `function` object. Deferred schemas stay out of the prompt. The server synthesizes `tool_search`, loads matching definitions, and the response only ever carries tool calls the client can run.

```bash
curl -sS http://127.0.0.1:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "<alias>",
    "messages": [{"role": "user", "content": "open an issue about the flaky test"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "create_issue",
        "description": "Open a new issue on a repository",
        "parameters": {"type": "object", "properties": {"title": {"type": "string"}}},
        "defer_loading": true,
        "group": "github"
      }
    }]
  }'
```

`tool_choice` naming a deferred tool returns `400 invalid_tool_choice`. Name `tool_search` instead. Tools without `defer_loading` are unchanged.

---

## Type the OpenAI voice field on /v1/audio/speech

PR: [#4635](https://github.com/tetherto/qvac/pull/4635)

`POST /v1/audio/speech` `voice` accepts an OpenAI built-in name, any other string, or `{ "id": "voice_1234" }`. The object form routes the same way as its `id`. A value that is neither a string nor `{ id }` returns `400 missing_voice`.

```bash
curl -sS http://127.0.0.1:11434/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"my-tts","voice":{"id":"alloy"},"input":"Hello from QVAC."}' \
  --output speech.wav
```

---

## Expose ABot-World layer streaming in the SDK

PR: [#4637](https://github.com/tetherto/qvac/pull/4637)

`qvac configure` edits nested World memory controls on a diffusion alias: `world.paramsBackend`, `world.maxVram`, `world.streamLayers`, and `world.verbosity`. Those fields land in `serve.models[].config` and pass through on load.

```json
{
  "serve": {
    "models": {
      "abot-world": {
        "model": "ABOT_WORLD_0_5B_Q8_0",
        "config": {
          "mode": "world",
          "world": {
            "paramsBackend": "diffusion=cpu",
            "maxVram": 2,
            "streamLayers": true,
            "verbosity": 3
          }
        }
      }
    }
  }
}
```

---

## Auto-install addon platform packages for mobile bundles

PR: [#4688](https://github.com/tetherto/qvac/pull/4688)

`qvac bundle` for `android-arm64` and `ios-*` adds missing addon platform packages (for example `@qvac/tts-ggml-android-arm64`) to the project's `package.json`, pinned to the addon's exact version, then bundles again. Skip with `--no-install`. A refused or failed install prints the dependencies to add by hand and still writes the bundle.

```bash
qvac bundle --host android-arm64
qvac bundle --host android-arm64 --no-install
```

---

## Check engines.bare against the Bare runtime each host runs

PR: [#4710](https://github.com/tetherto/qvac/pull/4710)

`qvac verify bundle`, `qvac bundle`, and `qvac doctor` compare each bundled package's `engines.bare` to the Bare version that host actually runs (react-native-bare-kit on mobile, bare-runtime on desktop). A mismatch fails verify/doctor and warns from bundle, with an upgrade target and per-package override. `--offline` skips GitHub and npm lookups.

```bash
qvac verify bundle --addons-source ./node_modules --host android-arm64
qvac verify bundle --addons-source ./node_modules --host darwin-arm64 --offline
qvac doctor --offline
```

`--bare-runtime-version` now replaces the version read from react-native-bare-kit for every host, so pin it for desktop builds only.

---

## Update @qvac/tts-ggml to 0.10.0 and add the MOSS engine

PR: [#4723](https://github.com/tetherto/qvac/pull/4723)

`qvac configure` offers a MOSS speech starter: delay backbone `TTS_DELAY_LLM_MOSS_TTS_F16` plus codec decoder `TTS_CODEC_DECODER_MOSS_TTS_F16`. Add the encoder to clone a voice. `POST /v1/audio/speech` uses that load config (`ttsEngine: "moss"`).

```json
{
  "serve": {
    "models": {
      "my-moss": {
        "model": "TTS_DELAY_LLM_MOSS_TTS_F16",
        "preload": true,
        "config": {
          "ttsEngine": "moss",
          "language": "en",
          "mossCodecDecoderModelSrc": "TTS_CODEC_DECODER_MOSS_TTS_F16"
        }
      }
    }
  }
}
```

---

## Report per-request NMT translate stats

PR: [#4616](https://github.com/tetherto/qvac/pull/4616)

`POST /qvac/v1/translate` `stats` describes that single request only. A batch has no stats, and neither does the first single input after a batch on the same model.

```json
{
  "object": "translation",
  "model": "ta-en",
  "translations": ["Hello, world."],
  "stats": { "totalTime": 41 }
}
```

---
