# 🔌 API Changes v0.14.0

## Expose KV-cache reclaim over serve

PR: [#4249](https://github.com/tetherto/qvac/pull/4249)

```bash
curl -X DELETE http://localhost:11434/qvac/v1/kv_cache
```

```json
{ "object": "kv_cache.reclaim", "deleted": true }
```

---

## Integrate MiniMax-H3 video generation across inference and SDK

PR: [#4351](https://github.com/tetherto/qvac/pull/4351)

`POST /v1/videos` accepts MiniMax-H3 fields on the OpenAI-shaped video job (H3 text-encoder / video VAE / audio VAE sources via `serve.models`). Poll `GET /v1/videos/{id}` then fetch bytes from `GET /v1/videos/{id}/content`.

---

## Close the SDK gaps against @qvac/tts-ggml 0.8.x

PR: [#4414](https://github.com/tetherto/qvac/pull/4414)

`POST /v1/audio/speech` passes through the TTS load options that 0.8.x exposed (CosyVoice3, Chatterbox, Supertonic, Parler).

---

## Update @qvac/tts-ggml to 0.9.1

PR: [#4428](https://github.com/tetherto/qvac/pull/4428)

```bash
# tts-ggml 0.9.0 installs the host's binaries next to the meta package
node_modules/@qvac/tts-ggml/                    # JavaScript only: addon: true, no prebuilds/
node_modules/@qvac/tts-ggml-darwin-arm64/       # os/cpu filtered optionalDependency
  addon/package.json                            # { "name": "@qvac/tts-ggml", "addon": true }
  addon/prebuilds/darwin-arm64/qvac__tts-ggml.bare

# Passes on this branch; on main it reports missing-prebuild for every host
qvac verify bundle --addons-source ./node_modules --host darwin-arm64
```

```text
@qvac/tts-ggml@0.9.0 is missing a prebuild for linux-x64
(expected …/@qvac/tts-ggml/prebuilds/linux-x64/*.bare).
No per-platform package @qvac/tts-ggml-linux-x64 is installed alongside it either.
```

---

## Accept tool_choice on the serve OpenAI routes

PR: [#4524](https://github.com/tetherto/qvac/pull/4524)

`POST /v1/chat/completions` and `POST /v1/responses` accept `tool_choice`: `"auto"` | `"none"` | `"required"` | a named-tool object. Chat uses `{ type: "function", function: { name } }`; Responses flattens to `{ type: "function", name }`. A demanding choice with no matching tool returns `400 invalid_tool_choice`. Parse failures are dropped from the OpenAI response and logged as `toolError` events.

```bash
curl http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "my-llm",
    "messages": [{"role": "user", "content": "What is the weather in London?"}],
    "tools": [{ "type": "function", "function": { "name": "get_weather" } }],
    "tool_choice": "required"
  }'
```

---
