# QVAC CLI v0.15.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/cli/v/0.15.0

QVAC CLI 0.15.0 follows `@qvac/sdk` 0.21.0. `qvac serve` maps `defer_loading` on OpenAI tools and runs `tool_search` itself, `/v1/audio/speech` accepts OpenAI `{ id }` voices and MOSS TTS from `qvac configure`, and `POST /qvac/v1/translate` reports stats for that request alone. `qvac bundle` can install missing mobile addon platform packages; `verify bundle` and `doctor` check `engines.bare` against the Bare runtime each host runs.

Install `@qvac/cli@0.15.0` with `@qvac/sdk@^0.21.0`. Publish this cut after SDK 0.21.0 is on npm.

## New APIs

### Deferred tools on `qvac serve --openai`

`POST /v1/chat/completions` and `POST /v1/responses` accept `defer_loading: true` (and an optional `group`) on a tool entry or on its `function` object. Deferred parameter schemas stay out of the prompt. The server synthesizes `tool_search`, loads matching definitions, and the HTTP response only carries tool calls the client can execute.

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

`tool_choice` naming a deferred tool returns `400 invalid_tool_choice`. Name `tool_search` instead. After a search, the next model round runs without the tool-call grammar unless the request sets a `tool_choice` other than `auto`, so a loaded tool is actually callable. Tools without `defer_loading` are unchanged.

### OpenAI voice objects on `/v1/audio/speech`

`voice` accepts a built-in name (`alloy`, `echo`, …), any other string, or `{ "id": "voice_1234" }`. The object form routes the same way as its `id`. A value that is neither a string nor `{ id }` returns `400 missing_voice`.

```bash
curl -sS http://127.0.0.1:11434/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"my-tts","voice":{"id":"alloy"},"input":"Hello from QVAC."}' \
  --output speech.wav
```

### Mobile addon install on `qvac bundle`

For `android-arm64` and `ios-*`, `qvac bundle` adds missing addon platform packages (for example `@qvac/tts-ggml-android-arm64`) to the project's `package.json`, pinned to the addon's exact version, then bundles again. Pass `--no-install` to skip. A refused or failed install prints the dependencies to add by hand and still writes the bundle.

```bash
qvac bundle --host android-arm64
qvac bundle --host android-arm64 --no-install
```

### `engines.bare` on verify, bundle, and doctor

`qvac verify bundle`, `qvac bundle`, and `qvac doctor` compare each bundled package's `engines.bare` to the Bare version that host actually runs: react-native-bare-kit on Android/iOS, bare-runtime on desktop. A mismatch fails verify and doctor, and warns from bundle, with the `react-native-bare-kit` release to upgrade to and a per-package override. `--offline` skips GitHub and npm lookups.

`--bare-runtime-version` replaces the version read from react-native-bare-kit for every host, so pin it for desktop builds only (for example Electron), not mobile CI.

```bash
qvac verify bundle --addons-source ./node_modules --host android-arm64
qvac verify bundle --addons-source ./node_modules --host darwin-arm64 --offline
qvac doctor --offline
```

### World memory controls in `qvac configure`

A diffusion alias in World mode exposes nested `world.paramsBackend`, `world.maxVram`, `world.streamLayers`, and `world.verbosity`. Those fields land in `serve.models[].config` and pass through on load.

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

### MOSS TTS starter

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

## Bug Fixes

`POST /qvac/v1/translate` `stats` describes that single request only. A batch has no stats, and neither does the first single input after a batch on the same model, whose work the engine cannot separate from the batch.

## Model Changes

### Added

```
TTS_CODEC_DECODER_MOSS_TTS_F16
TTS_CODEC_ENCODER_MOSS_TTS_F16
TTS_DELAY_LLM_MOSS_TTS_F16
```
