# @qvac/inference

The Bare-only engine of the QVAC SDK. It runs inference directly on the [Bare runtime](https://bare.pears.com) in a single process without a worker or subprocess. Native GGML RPC is available as an opt-in distributed GPU path. You register the inference engines you need and call the same API surface as `@qvac/sdk`, in-process.

> _Part of the **QVAC** ecosystem_
>
> [Home](https://qvac.tether.io/) •
> [Docs](https://docs.qvac.tether.io/) •
> [Support](https://discord.com/channels/1425125849346216029/1445400675189264516) •
> [Discord](https://discord.com/invite/tetherdev)

## Why this exists

`@qvac/inference` is the pure-Bare layer of the SDK, written in TypeScript: the client API, the request engine, and the plugin system, all running in one Bare process. `@qvac/sdk` builds on top of it to reach Node, Electron, Expo, and Pear by launching this engine as a worker; on Bare you use it directly. It replaces the deprecated `@qvac/bare-sdk` package (last release 0.18.2).

`@qvac/inference` ships no plugins by default and has no required model or RPC server addon dependencies. Model addons are optional peers; RPC serving uses an explicitly registered provider. You install only the addon packages your app registers, so the resulting binary scales with the engines and services you actually assemble.

## Requirements

- A Bare runtime (see the `bare` version in `engines`). The package ships compiled JavaScript with type declarations; when working from source, run `npm run build` first.

## Install

```bash
npm install @qvac/inference @qvac/translation-nmtcpp
```

Replace `@qvac/translation-nmtcpp` with the addon packages backing the plugins you register (see the table below).

## Usage

Assemble an explicit plugin set with `plugins([...])`, which returns the API bound to those engines:

```js
import { plugins } from '@qvac/inference'
import { nmtPlugin } from '@qvac/inference/nmtcpp-translation/plugin'

const sdk = plugins([nmtPlugin])

const result = await sdk.translate({
  modelId: 'my-model',
  text: 'Hello world',
  sourceLang: 'en',
  targetLang: 'fr'
})
```

Or register plugins imperatively and import the operations directly:

```js
import { registerPlugin, loadModel, completion, LLAMA_3_2_1B_INST_Q4_0 } from '@qvac/inference'
import { llmPlugin } from '@qvac/inference/llamacpp-completion/plugin'

registerPlugin(llmPlugin)

const modelId = await loadModel({ modelSrc: LLAMA_3_2_1B_INST_Q4_0 })
const run = completion({ modelId, history: [{ role: 'user', content: 'Hi' }] })
```

Model operations require a registered model plugin. RPC discovery needs no model plugin or server provider; serving requires an explicitly registered server provider.

## Capability to addon package

| Plugin subpath                                        | Addon package                    |
| ----------------------------------------------------- | -------------------------------- |
| `@qvac/inference/llamacpp-completion/plugin`          | `@qvac/llm-llamacpp`             |
| `@qvac/inference/llamacpp-embedding/plugin`           | `@qvac/embed-llamacpp`           |
| `@qvac/inference/whispercpp-transcription/plugin`     | `@qvac/transcription-whispercpp` |
| `@qvac/inference/bci-whispercpp-transcription/plugin` | `@qvac/bci-whispercpp`           |
| `@qvac/inference/parakeet-transcription/plugin`       | `@qvac/transcription-parakeet`   |
| `@qvac/inference/nmtcpp-translation/plugin`           | `@qvac/translation-nmtcpp`       |
| `@qvac/inference/tts-ggml/plugin`                     | `@qvac/tts-ggml`                 |
| `@qvac/inference/ggml-ocr/plugin`                     | `@qvac/ocr-ggml`                 |
| `@qvac/inference/sdcpp-generation/plugin`             | `@qvac/diffusion-cpp`            |
| `@qvac/inference/ggml-vla/plugin`                     | `@qvac/vla-ggml`                 |
| `@qvac/inference/ggml-classification/plugin`          | `@qvac/classification-ggml`      |

## Configuration

The engine resolves a `qvac.config.js` or `qvac.config.json` from the current working directory, or from the path in `QVAC_CONFIG_PATH`. The resolved config applies on the first API call.

## System resource diagnostics

Use `getSystemResources` to inspect locally observed CPU, system-memory, GPU, and driver capabilities. Pass `sample: true` only when you also need a fresh usage sample. Register a model plugin or RPC server provider before requesting diagnostics:

```js
import { registerPlugin, getSystemResources } from '@qvac/inference'
import { llmPlugin } from '@qvac/inference/llamacpp-completion/plugin'

registerPlugin(llmPlugin)

const resources = await getSystemResources({ sample: true })

if (resources.capabilities.memory.totalBytes.status === 'supported') {
  console.log('System memory:', resources.capabilities.memory.totalBytes.value)
}

if (resources.sample?.cpu.status === 'supported') {
  console.log('CPU utilization:', resources.sample.cpu.value)
}
```

Every metric reports `supported`, `unavailable`, `unverified`, or `failed`. Supported values include their source and scope. These values are diagnostics; they do not reserve memory or guarantee that a model can be loaded.

## Connection lifecycle

`unloadModel` releases a model but leaves the shared infrastructure — swarm, registry client, corestore — running so a long-lived process survives load/unload cycles. Tear it down explicitly when you are done:

```js
import { close, unloadModel } from '@qvac/inference'

await unloadModel({ modelId })
await close() // release the swarm, registry client, storage-root lock, and registered plugins
```

`close()` clears model plugin and RPC server provider registrations after successful cleanup. Register the capabilities you need again before reusing the engine. RPC discovery needs no registration.

## Distributed GPU inference

RPC serving is separate from model plugins. Install a compatible
`@qvac/ggml-rpc-server` build only in applications that serve devices, then
register its adapter explicitly:

```js
import { registerRpcServerProvider, startRpcServer, stopRpcServer } from '@qvac/inference'
import { ggmlRpcServerProvider } from '@qvac/inference/ggml-rpc-server/provider'

registerRpcServerProvider(ggmlRpcServerProvider)
const server = await startRpcServer()
await stopRpcServer({ serverId: server.serverId })
```

A server-only process needs no model plugin. Calling `startRpcServer()` without a
provider throws `RpcServerOperationError`. Discovery works without either a
provider or a model plugin. Initiators need only the LLM plugin and its addon;
remote inference does not require the server addon.

Custom adapters implement `RpcServerProvider`, exported from
`@qvac/inference/rpc-server-provider`. The engine owns each returned handle,
readiness checks, discovery announcements, rollback, and shutdown. Registration
is local to the Bare runtime. Successful `close()` clears the provider; register
again before restarting serving. A failed close retains it for cleanup retries.

`close()` withdraws announcements, cancels active discovery and readiness probes,
and attempts to stop every owned server. Failed stops remain owned for a retry
and cause `close()` to reject. Native stop can wait indefinitely; the engine does
not report a stalled stop as successful. Model unload does not stop serving
instances.

## Custom plugins

Author an engine with `definePlugin` / `defineHandler` and register it like any built-in:

```js
import { definePlugin, defineHandler, registerPlugin } from '@qvac/inference'

const myPlugin = definePlugin({
  /* modelType, addonPackage, loadConfigSchema, createModel, handlers */
})

registerPlugin(myPlugin)
```

## License

Apache-2.0
