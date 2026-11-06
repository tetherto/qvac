# @qvac/llm-sglang

Experimental addon on the `sglang` branch. It is not wired into CI or the SDK
release flow.

`LlmSglang` implements the same load / run / unload shape as
`@qvac/llm-llamacpp` for text prompts and image messages. `load()` starts the
server from `@qvac/sglang` unless `config.baseUrl` already points at one.
`run()` posts the prompt to `POST /v1/chat/completions` and streams
`delta.content` tokens through a `QvacResponse`.

```js
const { LlmSglang } = require('@qvac/llm-sglang')

const model = new LlmSglang({
  files: { model: ['/path/to/checkpoint'] },
  config: { port: 30000 }
})
await model.load()
const response = model.run([{ role: 'user', content: 'Hello' }])
for await (const token of response.iterate()) {
  process.stdout.write(token)
}
await model.unload()
```

An image uses the llamacpp media message: `{ role: 'user', type: 'media', content }`
where `content` is a file path or `Uint8Array`. The addon sends it as an
OpenAI `image_url` part. Audio and video are rejected.

The addon forwards images; the server may reject them when the selected model
and configuration have no qualified image serving path.

Build the native HTTP client with the repository's Bare build tools. This addon
does not link CUDA or LibTorch; those are required by the server package.

```sh
corepack pnpm --filter @qvac/llm-sglang build
```

`config.baseUrl` skips launching a server and talks to one that is already up.
The native client accepts `http://host:port` URLs. `config.apiKey` sends Bearer
authentication to that server and also configures authentication when starting
a managed server.

## HTTP integration validation

From this package directory, run:

```sh
npm run test:integration
```

This builds the native addon and runs it in Bare against a local Node HTTP
mock. Bare must be on `PATH`, or set `BARE_BIN` to its executable. The mock's
request and response fixtures follow the pinned QVAC Grid server's chat API.
The tests exercise the public `load()` / `run()` / `unload()` path and real
native sockets: request serialization, generation parameters, fragmented
chunked SSE and UTF-8, reasoning and usage events, HTTP and streaming errors,
missing completion markers, cancellation, repeated requests, and API keys.
They need no GPU, model checkpoint, or server process; they validate transport
and the chat contract rather than model inference.
