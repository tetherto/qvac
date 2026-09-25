# Pocket TTS

Pocket synthesizes English speech on CPU through `@qvac/tts-ggml`. Use an addon
release containing the Pocket engine; the previously published npm 0.9.2 does
not contain it. When developing from this monorepo, build the workspace addon
and its native prebuild before building inference and the SDK.

Convert the matching upstream weights, tokenizer and prepared voice into a
[Pocket bundle](../../tts-ggml/docs/pocket-tts.md#model-bundle). The bundle has
`flow-lm.gguf`, `mimi.gguf`, `frontend.json` and `voice.gguf`.

```js
import { loadModel, textToSpeech, unloadModel, close } from '@qvac/sdk'

const root = '/absolute/path/to/pocket-bundle'
try {
  const modelId = await loadModel({
    modelType: 'tts-ggml',
    modelSrc: `${root}/flow-lm.gguf`,
    modelConfig: {
      ttsEngine: 'pocket',
      mimiModelSrc: `${root}/mimi.gguf`,
      frontendSrc: `${root}/frontend.json`,
      voiceSrc: `${root}/voice.gguf`,
      steps: 4
    }
  })
  const result = textToSpeech({ modelId, text: 'Hello from QVAC.', stream: true })
  for await (const sample of result.bufferStream) {
    // Signed PCM16 samples. Feed them to an audio sink or collect into a WAV.
  }
  console.log(await result.sampleRate, await result.stopReason)
  await unloadModel({ modelId })
} finally {
  await close()
}
```

`stream: false` exposes `await result.buffer` for the complete PCM.
`textToSpeechStream` accepts incremental text using the existing duplex API.
`cancel({ modelId, kind: 'tts' })` stops active synthesis; drain the stream and
check `result.stopReason` for `cancelled` before starting another request.

For in-process Bare, register `ttsPlugin` from
`@qvac/inference/tts-ggml/plugin` and use the same configuration through
`@qvac/inference`. Python clients receive the same load configuration through
the generated SDK contract.

Pocket supports English only, CPU only, and load-time sampling controls.
The preset explicitly chooses four steps because the reported artifact in a
one-step take also reproduced upstream and disappeared in the four-step take.
Four steps repeat the flow sampler, not the whole synthesis pipeline; see the
[paired timing and listening results](../../tts-ggml/docs/pocket-tts.md#why-choose-four-steps-for-audio-quality).
Omitting `steps` preserves the native default of one; four steps are a quality
option, not a guarantee that every take is artifact-free.

The public without-voice-cloning checkpoint works with prepared voices. It has
disabled encoder weights and cannot synthesize a voice from a reference WAV.
Only a checkpoint with a working Mimi encoder can use `referenceAudioSrc`
instead of `voiceSrc`; providing both is rejected.

## CLI

Choose Pocket in `qvac configure`'s speech engine prompt and replace the bundle
paths in the generated template. `qvac serve` exposes the configured model at
`POST /v1/audio/speech`; see the [Pocket serve example](../../cli/docs/serve/openai.md#pocket-tts).

## Validation

After building `@qvac/tts-ggml`, `@qvac/inference`, and `@qvac/sdk`, run:

```sh
QVAC_POCKET_MODEL_DIR=/absolute/path/to/pocket-bundle npm run test:pocket:node
```

This uses the public Node client and a spawned Bare worker with the TTS plugin.
It verifies batch/stream PCM, audio before duplex input ends, cancellation,
recovery, and worker shutdown. Missing model assets fail this test explicitly.
Inference's `npm run test:pocket` also checks configuration and artifact mapping;
its synthesis case needs the same environment variable.
