# 🔌 API Changes v0.21.0

## Add qvac fit

PR: [#5861](https://github.com/tetherto/qvac/pull/5861)

`qvac fit [models...]` checks whether SDK model constants or `serve.models` aliases fit this machine's memory when loaded together, before anything is downloaded. It gives the answer `POST /qvac/v1/models/fit` gives for the same input.

```bash
# One model at 8K context
qvac fit QWEN3_8B_INST_Q4_K_M --set ctx_size=8192

# Two models loaded together, the larger at the longest context that fits
qvac fit QWEN3_8B_INST_Q4_K_M QWEN3_600M_INST_Q4 --set QWEN3_8B_INST_Q4_K_M:ctx_size=0

# A translation model with its language pair, as JSON
qvac fit BERGAMOT_DE_EN --set engine=Bergamot --set from=de --set to=en --json

# Every SDK model on its own, language models at the longest context that fits
qvac fit --catalog --set llamacpp-completion:ctx_size=0 --json
```

- `--set [target:]key=value` sets the config to judge with, and is repeatable. The target is a model or a model type such as `llamacpp-completion`; without one the setting applies to every model. A model's own setting wins over its type's, and its type's over one for every model. A dotted key nests, and a value is read as JSON when it parses.
- `--json` prints the response shape of the `models/fit` route. `--catalog` judges every SDK model on its own and lists the models with no verdict apart, each with its reason.
- `-c, --config <path>` names the config file with the `serve.models` aliases. The default is to auto-detect `qvac.config.*`.
- Exit status: `0` fits, `2` does not fit, `3` unknown, `1` error. `--catalog` exits `0` once every model is judged.

---

## Judge model fit on shared memory and report why a fit is unknown

PR: [#5860](https://github.com/tetherto/qvac/pull/5860)

Each entry of `models` in the `POST /qvac/v1/models/fit` response can carry a `reason`. It is present when `status` is `unknown`, and when `status` is `does-not-fit` because devices that share one memory pool overflow it.

```jsonc
// POST /qvac/v1/models/fit, models[] entry
{
  "model": "TTS_EN_SUPERTONIC_Q8_0",
  "status": "unknown",
  "devices": [],
  "stats": {},
  "reason": "the engine fitter could not size this load"
}
```

---

## Serve custom plugin invoke behind --enable-admin

PR: [#5533](https://github.com/tetherto/qvac/pull/5533)

`POST /qvac/v1/plugins/:name/invoke` calls a handler of a custom plugin registered in the worker that serve runs. `:name` is the plugin's model type, and `model` names a `serve.models` alias of that `type`. The route is admin-only: it answers `403 admin_disabled` unless the server was started with `--enable-admin`.

```bash
qvac serve --enable-admin
curl -sS http://localhost:11435/qvac/v1/plugins/echo-plugin/invoke \
  -H "Content-Type: application/json" \
  -d '{"model": "echo", "handler": "echo", "params": {"text": "hi"}}'
# { "object": "plugin.invocation", "model": "echo", "handler": "echo", "result": { "text": "hi" } }
```

- `stream: true` calls a streaming handler and answers with Server-Sent Events: a `plugin.invocation.chunk` per result, one `plugin.invocation.done`, then `data: [DONE]`.
- Built-in model types answer `400 builtin_plugin`; use their own endpoints.
- Plugin errors map to `404 handler_not_found`, `400 invalid_plugin_params`, `400 handler_type_mismatch` and `502 plugin_response_invalid`.
- A plugin call cannot be cancelled. A client disconnect stops the stream, and the handler runs to the end.

---

## Report the runtime's capability contracts and major versions

PR: [#5851](https://github.com/tetherto/qvac/pull/5851)

`GET /qvac/v1/runtime/capabilities` lists the capability contracts that the runtime's registered plugins declare, with the major version of each. It reads plugin registration only, so it loads no model and answers while the runtime is suspended.

```bash
curl -sS http://localhost:11435/qvac/v1/runtime/capabilities
```

```json
{
  "object": "list",
  "data": [
    {
      "id": "transcription",
      "version": 1,
      "operations": ["transcribe"],
      "partialOperations": ["transcribeStream"]
    }
  ]
}
```

`operations` are implemented by every registered plugin that declares the contract. `partialOperations` are optional operations that only some of those plugins implement, so one can fail for a given model.

---

## Deprecate history attachments in favor of ordered content parts

PR: [#5858](https://github.com/tetherto/qvac/pull/5858)

`qvac serve` now passes images to the SDK only as ordered content parts on user turns, so the model sees each image where the client put it. An `image_url` part on a system, developer or assistant message returns `400 unsupported_image_content` on `POST /v1/chat/completions` and `POST /qvac/v1/chat/batch`. Such a request used to fail inside the engine.

```jsonc
// POST /v1/chat/completions: images belong on user messages
{
  "model": "my-vlm",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "Compare " },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } },
        { "type": "text", "text": " with " },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
      ]
    }
  ]
}
```

---
