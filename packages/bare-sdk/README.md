# @qvac/bare-sdk

Bare-targeted slim distribution of the QVAC SDK. Designed for consumers assembling their own worker entry on the [Bare runtime](https://bare.pears.com) (Pear apps, bare-expo mobile apps, direct Bare scripts).

> *Part of **QVAC** ecosystem*
>
> [Home](https://qvac.tether.io/)  • 
> [Docs](https://docs.qvac.tether.io/)  • 
> [Support](https://discord.com/channels/1425125849346216029/1445400675189264516)  • 
> [Discord](https://discord.com/invite/tetherdev)

## Why this exists

The default `@qvac/sdk` package ships with the full set of built-in plugin addons so Node and Expo consumers can call any capability out of the box. `@qvac/bare-sdk` exposes the same SDK surface with no built-in addon dependencies, so consumers install only the addons their worker actually registers. Paired with `bare-pack`'s static bundle analysis, the resulting native binary scales with the plugins explicitly assembled in the worker entry.

## Install

```bash
npm install @qvac/bare-sdk @qvac/translation-nmtcpp
```

Replace `@qvac/translation-nmtcpp` with whichever addon packages match the plugins you want to register.

## Worker entry example (NMT-only)

```js
import { plugins } from "@qvac/bare-sdk";
import { nmtPlugin } from "@qvac/bare-sdk/nmtcpp-translation/plugin";

const sdk = plugins([nmtPlugin]);

const result = await sdk.translate({
  modelId: "my-model",
  text: "Hello world",
  sourceLang: "en",
  targetLang: "fr",
});
```

## Capability to addon package


| Plugin subpath                                   | Addon package                    |
| ------------------------------------------------ | -------------------------------- |
| `@qvac/bare-sdk/llamacpp-completion/plugin`      | `@qvac/llm-llamacpp`             |
| `@qvac/bare-sdk/llamacpp-embedding/plugin`       | `@qvac/embed-llamacpp`           |
| `@qvac/bare-sdk/whispercpp-transcription/plugin` | `@qvac/transcription-whispercpp` |
| `@qvac/bare-sdk/parakeet-transcription/plugin`   | `@qvac/transcription-parakeet`   |
| `@qvac/bare-sdk/nmtcpp-translation/plugin`       | `@qvac/translation-nmtcpp`       |
| `@qvac/bare-sdk/onnx-tts/plugin`                 | `@qvac/tts-onnx`                 |
| `@qvac/bare-sdk/onnx-ocr/plugin`                 | `@qvac/ocr-onnx`                 |
| `@qvac/bare-sdk/sdcpp-generation/plugin`         | `@qvac/diffusion-cpp`            |
| `@qvac/bare-sdk/ggml-vla/plugin`                 | `@qvac/vla-ggml`                 |


## Connection lifecycle

`unloadModel` does not close the SDK's connections. The swarm, registry client, and corestore stay up so long-lived workers survive a routine unload across load/unload cycles. Close explicitly when you're done:

```js
import { close } from "@qvac/bare-sdk";

await unloadModel({ modelId });
await close(); // tear down swarm + registry client so the process can exit
```

Or opt into auto-close on the final unload:

```js
await unloadModel({ modelId, autoClose: true });
```

## Relationship to `@qvac/sdk`

`@qvac/bare-sdk` is built by copying compiled output from `@qvac/sdk`. The two packages share the same source, version, and release branch; the only differences are package metadata (slim dependency profile, no default worker entry, explicit assembly API).

Use `@qvac/sdk` for Node and Expo apps that want the full default worker. Use `@qvac/bare-sdk` when you assemble your own worker on Bare.

## Release history

`@qvac/bare-sdk` releases in lockstep with `@qvac/sdk` from the same source tree. For release notes and version history, see the [`@qvac/sdk` changelog](../sdk/CHANGELOG.md).

## Migrating from `@qvac/sdk`

Existing Bare consumers running a custom worker entry can switch packages without changing call sites. Two edits:

**1. Swap the dependency** in the package that owns your worker:

```diff
-"@qvac/sdk": "^0.11.0",
+"@qvac/bare-sdk": "^0.11.0",
```

**2. Rewrite worker imports** — every `@qvac/sdk/...` subpath maps to the same path under `@qvac/bare-sdk`:

```diff
-import { registerPlugin } from "@qvac/sdk/plugins";
-import { nmtPlugin } from "@qvac/sdk/nmtcpp-translation/plugin";
+import { registerPlugin } from "@qvac/bare-sdk/plugins";
+import { nmtPlugin } from "@qvac/bare-sdk/nmtcpp-translation/plugin";
```

If your worker previously relied on the default plugin set (i.e. it never called `registerPlugin`), enumerate the plugins it uses via `plugins([...])` or `registerPlugin(...)` — see [Worker entry example](#worker-entry-example-nmt-only). bare-sdk has no implicit defaults.

## Behavior differences vs `@qvac/sdk`

### Explicit plugin assembly

Consumers register plugins via `plugins([...])` or `registerPlugin(...)`. SDK calls made before any plugin is registered raise `WorkerPluginsNotRegisteredError` with guidance to the assembly API.

### Pear pre-hook

`@qvac/sdk` ships a `pear-pre` script that auto-generates `qvac/worker.pear.entry.mjs` from `qvac.config.{json,mjs}`. `@qvac/bare-sdk` follows the explicit-assembly model, so Pear apps using bare-sdk author the entry file directly.

**Fix:** create `qvac/worker.pear.entry.mjs` in your app root:

```js
import { registerPlugin } from "@qvac/bare-sdk/plugins";
import { nmtPlugin } from "@qvac/bare-sdk/nmtcpp-translation/plugin";

registerPlugin(nmtPlugin);

await import("../worker.js");
```

Then add `"/qvac/worker.pear.entry.mjs"` to `pear.stage.entrypoints` in your `package.json`. A bare-sdk-aware pre-hook is on the roadmap.