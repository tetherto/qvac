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

The pinned sglang-cpp server still refuses image parts, because this HTTP path
has no vision adapter. The addon forwards the image and surfaces that server
error.

Build the native module after the host toolchain from `@qvac/sglang` is on the
environment:

```sh
source packages/sglang/.toolchain/env.sh
corepack pnpm --filter @qvac/llm-sglang build
```

`config.baseUrl` skips launching a server and talks to one that is already up.
