# QVAC SDK

**QVAC SDK** is the canonical entry point to develop AI applications with QVAC.

> _Part of **QVAC** ecosystem_
> <br>
> <sup>
> <a href="https://qvac.tether.io/" >Home</a> &nbsp;•&nbsp;
> <a href="https://docs.qvac.tether.io/" >Docs</a> &nbsp;•&nbsp;
> <a href="https://discord.com/channels/1425125849346216029/1445400675189264516" >Support</a> &nbsp;•&nbsp;
> <a href="https://discord.com/invite/tetherdev" >Discord</a>

**QVAC SDK** is the main entry point for developing applications with QVAC. It is type-safe and exposes all QVAC capabilities through a unified interface. It runs on Node.js and [Expo](https://expo.dev).

See [https://docs.qvac.tether.io/sdk/getting-started](https://docs.qvac.tether.io/sdk/getting-started) for the comprehensive QVAC documentation.

For AI/LLM tools, use [https://docs.qvac.tether.io/llms-full.txt](https://docs.qvac.tether.io/llms-full.txt) as the consolidated plaintext documentation export.

> **In-process Bare:** use [`@qvac/inference`](../inference/README.md). `@qvac/bare-sdk` is deprecated; last release is 0.18.2.

## Supported environments and installation

See https://docs.qvac.tether.io/sdk/getting-started/installation

On Node.js, the SDK starts its own Bare worker with the Bare that `bare-sidecar` installs.
When upgrading the SDK, reinstall dependencies with the existing lockfile so the
package manager can replace an older, incompatible `bare-sidecar`. Remove any override
or resolution that forces it below the SDK's range; installing a newer global `bare`
executable does not change the SDK's worker.

For mobile apps that use only raw PCM streaming transcription, list the required audio plugins and set `"includeAudioDecoder": false` in `qvac.config.*` before bundling or running Expo prebuild. You can also use `qvac bundle sdk --defer bare-ffmpeg`. Both options leave `bare-ffmpeg` out of the worker bundle. Bundle FFmpeg when the app decodes compressed audio files or asks `audiogen-ggml` for a compressed output format; PCM and WAV output need no FFmpeg.

## Quickstart

1. Create the examples workspace:

```bash
mkdir qvac-examples
cd qvac-examples
npm init -y && npm pkg set type=module
```

2. Install the SDK:

```bash
npm install @qvac/sdk
```

3. Create the quickstart script:

```js
import { loadModel, LLAMA_3_2_1B_INST_Q4_0, completion, unloadModel } from '@qvac/sdk'
try {
  // Load a model into memory
  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    onProgress: (progress) => {
      console.log(progress)
    }
  })
  // You can use the loaded model multiple times
  const history = [
    {
      role: 'user',
      content: 'Explain quantum computing in one sentence'
    }
  ]
  const result = completion({ modelId, history, stream: true })
  for await (const token of result.tokenStream) {
    process.stdout.write(token)
  }
  // Unload model to free up system resources
  await unloadModel({ modelId })
} catch (error) {
  console.error('❌ Error:', error)
  process.exit(1)
}
```

4. Run the quickstart script:

```bash
node quickstart.js
```

## Documentation

The [QVAC SDK documentation](https://docs.qvac.tether.io/sdk/) covers each
capability with its configuration and examples. See the
[API reference](https://docs.qvac.tether.io/sdk/reference/api/) for the full API
and the [release notes](https://docs.qvac.tether.io/sdk/reference/release-notes/)
for what changed in each release.

TranscribePsy (`PARAKEET_TRANSCRIBEPSY_250M_Q8_0`, eight European
languages) has a separate Core ML distribution instead of a sidecar:
`PARAKEET_TRANSCRIBEPSY_250M_COREML_Q8_0` is an encoder-less GGUF whose
encoder and decoder bundles the SDK stages beside it, so both stages run on
the Neural Engine. It loads on macOS and iOS only; elsewhere the load is
refused up front with the ggml constant to use instead. See
[`examples/asr/parakeet-transcribepsy-filesystem.ts`](examples/asr/parakeet-transcribepsy-filesystem.ts),
which also shows the `longFormWindowFrames` / `longFormContextFrames` knobs
that bound the offline encoder window on long recordings.

## Examples

The [`examples`](./examples) directory has scripts covering every SDK capability.
To run one, set up the SDK from source as described in
[`CONTRIBUTING.md`](./CONTRIBUTING.md), then from `packages/sdk`:

```bash
# Compiled output
node dist/examples/path/to/example.js

# Straight from source, with the tsx dev dependency
npx tsx examples/path/to/example.ts
```

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for building from source, commit and
PR title format, and changelog generation, and [`TESTING.md`](./TESTING.md) for
where new tests belong.
