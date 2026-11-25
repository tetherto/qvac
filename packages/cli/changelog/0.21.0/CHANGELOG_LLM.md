# QVAC CLI v0.21.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/cli/v/0.21.0

QVAC CLI 0.21.0 moves to `@qvac/sdk@^0.25.0` and adds `qvac fit`, which tells you from the terminal whether a model or a set of models fits your machine before you download anything. `qvac serve` gains two routes, one that calls custom plugins and one that reports the runtime's capability contracts. Three changes need attention when upgrading: model fit verdicts are stricter on shared memory, `/v1/responses` and `/v1/chat/completions` report tool calls and token usage the way OpenAI clients expect, and vector stores from earlier releases have to be created again.

## Breaking Changes

### A model that overflows shared memory no longer fits

`POST /qvac/v1/models/fit` now applies the shared-pool check to each model on its own. When a model's rows share one memory pool, such as a Metal GPU or an integrated GPU plus the CPU, the model is `does-not-fit` if those rows together take more than 90% of the pool's free memory, even when each row fits. A single model's `verdict` is its `status`, so on a Mac a request that answered `fits` can now answer `does-not-fit`. A row alone in its pool, such as a discrete GPU, keeps the engine's answer. An alias loaded with `modelFitPolicy: 'refuse'` is refused under the same rule.

**Before:**

```jsonc
// POST /qvac/v1/models/fit, one model whose Metal and CPU rows each fit
{ "object": "model_fit", "verdict": "fits", "models": [{ "model": "my-llm", "status": "fits" }] }
```

**After:**

```jsonc
{
  "object": "model_fit",
  "verdict": "does-not-fit",
  "models": [
    {
      "model": "my-llm",
      "status": "does-not-fit",
      "reason": "devices sharing one pool need more than 90% of its free memory: host 19642 MiB of 18104 MiB free"
    }
  ]
}
```

If you relied on the old verdict, lower `ctx_size` or pick a smaller quantization and ask again. `qvac fit <model> --set ctx_size=0` reports the longest context that fits.

### Tool calls on `/v1/responses` are `completed`, and usage counts the whole prompt

These two changes make coding agents that follow the OpenAI shapes work against `qvac serve`.

A `/v1/responses` response in which the model called tools now has `status: "completed"`. It used to be `requires_action`, which is not a Responses API status and stopped the Pi coding agent on its first tool call. The response no longer carries `required_action`. Read the calls from the `function_call` items in `output`.

`usage.prompt_tokens` on `/v1/chat/completions` now counts the whole prompt. On a KV cache hit it used to count only the newly read tokens, so a client that compacts its history on token usage never did. The part the cache already held is reported as `usage.prompt_tokens_details.cached_tokens`, and `/v1/responses` reports it as `usage.input_tokens_details.cached_tokens`.

**Before:**

```jsonc
// POST /v1/responses, model called a tool
{ "status": "requires_action", "required_action": { "type": "submit_tool_outputs" }, "usage": { "input_tokens": 262 } }
// POST /v1/chat/completions, cache hit on a 262-token prompt
{ "usage": { "prompt_tokens": 14, "total_tokens": 20 } }
```

**After:**

```jsonc
{ "status": "completed", "usage": { "input_tokens": 262, "input_tokens_details": { "cached_tokens": 248 } } }
{ "usage": { "prompt_tokens": 262, "prompt_tokens_details": { "cached_tokens": 248 }, "total_tokens": 268 } }
```

To migrate, stop branching on `requires_action` and look for `function_call` items in `output`. If you bill or budget on `prompt_tokens`, subtract `cached_tokens` to get the newly read part.

The message of the `400 context_length_exceeded` error now reads "The request exceeds the context window of this model", which the Pi coding agent recognizes as a signal to compact. The error code is unchanged.

### Vector stores are rebuilt on `@qvac/rag`

The SDK no longer has a RAG API, so `/v1/vector_stores` on `qvac serve --openai` now stores and searches files with the standalone `@qvac/rag` package. The routes and their request and response shapes stay the same, but the data does not carry over.

- Stores created with CLI 0.20.x or earlier are not listed or searched, and a request for one returns `404 vector_store_not_found`. Create the store again with `POST /v1/vector_stores`, upload each file with `POST /v1/files`, and attach it with `POST /v1/vector_stores/{id}/files`. The old data stays in the `rag-hyperdb` and `rag-turbovec` folders next to the cache directory until you delete them.
- Each store now has a folder under `serve/vector-stores` next to the SDK `cacheDirectory`, which is `~/.qvac/serve/vector-stores` by default.
- A store is open in one server at a time. While another server on the same data directory has it open, search, attach and delete return `409 vector_store_in_use`.
- A store is tied to the embedding weights and the `pooling`, `attention` and `embdNormalize` settings it was ingested with, not only to the alias name. Pointing the alias at other weights returns `400 embedding_model_mismatch`.

Two things improve with the move. Every search hit carries the `file_id` and `filename` of the upload it came from, including after a server restart, and attaching the same `file_id` again replaces its chunks. `max_num_results` defaults to 5.

## New APIs

### `qvac fit`: check a model against your machine before downloading it

`qvac fit` answers "will this model, or this set of models, fit my machine" from the terminal. It runs each model's engine fitter against the registry's description of the model, which is tens of KB, or against the model's own files when it is already downloaded. The answer is the one `POST /qvac/v1/models/fit` gives for the same input.

```bash
# One model at 8K context
qvac fit QWEN3_8B_INST_Q4_K_M --set ctx_size=8192

# Two models loaded together, the larger at the longest context that fits
qvac fit QWEN3_8B_INST_Q4_K_M QWEN3_600M_INST_Q4 --set QWEN3_8B_INST_Q4_K_M:ctx_size=0

# A translation model with its language pair
qvac fit BERGAMOT_DE_EN --set engine=Bergamot --set from=de --set to=en

# Every SDK model, language models at the longest context that fits, as JSON
qvac fit --catalog --set llamacpp-completion:ctx_size=0 --json
```

Each model is an SDK model constant name or a `serve.models` alias from the config file. The output shows each model's verdict alone, the context and GPU layers a language model was judged at, and the memory it takes on each device against what is free, followed by the verdict for the set and what it takes from each memory pool.

`--set [target:]key=value` sets the config to judge with and is repeatable. The target is a model, or a model type such as `llamacpp-completion` for every model of that type; without a target the setting applies to every model. A model's own setting wins over its type's, and its type's over one for every model. A dotted key nests (`contextParams.n_ctx=4096`), and a value is read as JSON when it parses and as a string otherwise.

`--json` prints the response shape of the `models/fit` route. `--catalog` judges every SDK model on its own and lists the models with no verdict apart, each with its reason. `-c, --config <path>` names the config file that holds the aliases.

The exit status makes the command usable in scripts: `0` fits, `2` does not fit, `3` unknown, `1` error. `--catalog` exits `0` once every model is judged.

A language model is judged at the SDK's default context of 1024 tokens unless `ctx_size` is set. A model made of several parts needs its engine and companion files in its config: a TTS model needs `ttsEngine`, and a translation model needs its `engine` and language pair. A companion file on its own, such as a projector, VAE or codec, cannot be judged; judge the model that loads it.

### Model fit results say why

Each entry of `models` in the `POST /qvac/v1/models/fit` response can now carry a `reason`. It is present when the model's `status` is `unknown`, and when it is `does-not-fit` because devices sharing one memory pool overflow it. `qvac fit` prints the same reason next to the model.

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

### Call a custom plugin over HTTP

`POST /qvac/v1/plugins/:name/invoke` calls a handler of a custom plugin, which until now was reachable only through the SDK's `invokePlugin()` and `invokePluginStream()`. The route runs whatever the plugin does, so it is admin-only: it answers `403 admin_disabled` unless the server was started with `--enable-admin`, and it refuses browser requests from an origin outside the CORS allowlist.

The plugin must be registered in the worker that serve runs. List it under `plugins` in `qvac.config.*` and run `qvac bundle sdk`, then give the plugin an alias whose `type` is its model type:

```json
{
  "serve": {
    "models": {
      "echo": { "src": "./models/echo.bin", "type": "echo-plugin" }
    }
  }
}
```

```bash
qvac serve --enable-admin
curl -sS http://localhost:11435/qvac/v1/plugins/echo-plugin/invoke \
  -H "Content-Type: application/json" \
  -d '{"model": "echo", "handler": "echo", "params": {"text": "hi"}}'
# { "object": "plugin.invocation", "model": "echo", "handler": "echo", "result": { "text": "hi" } }
```

`:name` is the plugin's model type and `model` is an alias of that type. `params` is passed to the handler as sent, and the plugin validates it. With `stream: true` a streaming handler answers with Server-Sent Events: a `plugin.invocation.chunk` per result, one `plugin.invocation.done`, then `data: [DONE]`.

Built-in model types answer `400 builtin_plugin`, because they have their own endpoints. Plugin errors map to `404 handler_not_found`, `400 invalid_plugin_params`, `400 handler_type_mismatch` and `502 plugin_response_invalid`. A plugin call cannot be cancelled: a client disconnect stops the stream, and the handler runs to the end.

### Ask the runtime which capability contracts it serves

`GET /qvac/v1/runtime/capabilities` lists the capability contracts that the runtime's registered plugins declare, with the major version of each. A client released separately from the server can check that the operations it needs are served before it loads a model. The route reads plugin registration only, so it loads no model and answers while the runtime is suspended.

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

`operations` are implemented by every registered plugin that declares the contract. `partialOperations` are optional operations that only some of those plugins implement. A call uses the plugin of the model it names, so a partial operation can fail for a given model.

### Images are accepted on user messages only

`qvac serve` now passes images to the model only as ordered content parts on user turns, so the model sees each image where the client put it in the message. An `image_url` part on a system, developer or assistant message returns `400 unsupported_image_content` on `POST /v1/chat/completions` and `POST /qvac/v1/chat/batch`. Such a request used to fail inside the engine without a clear error.

## Features

### Malformed tool calls are recovered

With SDK 0.25 the engine repairs tool calls that a model writes slightly wrong, so agent loops against `qvac serve` lose fewer calls. Arguments are repaired against the tool's declared schema before validation, for example an object sent as a JSON string or arguments wrapped in an extra key, and a bare `<function=NAME>` block for a declared tool is read as a call and kept out of the streamed text. In the dialects whose template ends the turn at a call, a call followed by more prose is shown as text instead of being run.

## Bug Fixes

### Serve shows why it downloads a cached model again

When a cached model file failed its size or checksum check, `qvac serve` downloaded it again and printed no reason. Serve now prints the SDK's warnings and errors during a model load, so the log names the file and what was wrong with it:

```
Loading model "classifier" from registry://...
Ignoring cached mobilenetv3_3class_v3_fp16.gguf at ~/.qvac/models/56aaf68e0d8e18d7_mobilenetv3_3class_v3_fp16.gguf: size 29, expected 3084800
Model "classifier" loaded (SDK modelId: 3efb6c6770cd8af0).
```

A cache hit adds no output.

### Uploads are written to private temporary directories

Audio and image uploads that serve writes to disk for the engine used to go into the shared OS temp directory at a guessable path with default permissions. Each upload now gets its own owner-only directory and an owner-only file, and the directory is removed with the file. Other local users can no longer read an upload or plant a file at its path.
