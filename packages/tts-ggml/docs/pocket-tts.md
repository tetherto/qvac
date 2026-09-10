# Pocket TTS

Pocket is an English, CPU-only TTS engine implemented in the Fabric speech
library. It streams PCM16 audio through the existing addon, inference plugin
and public SDK APIs. Python is used only to convert weights and benchmark the
upstream reference; it is not needed for synthesis in Fabric.

## Model bundle

Convert the supported Kyutai English 2026-04 checkpoint using
`engines/tts/scripts/convert-pocket-to-gguf.py` in qvac-fabric-speech.cpp.
The bundle contains `flow-lm.gguf`, `mimi.gguf`, `frontend.json` and `voice.gguf`.
The native repository's `engines/tts/docs/pocket-tts.md` documents conversion,
asset revisions, validation, CLI usage and the benchmark scripts.

The public checkpoint without voice cloning works with a prepared voice
embedding. Reference-WAV conditioning requires weights with a functioning
Mimi encoder; the public checkpoint with zero encoder weights is rejected
for that operation. Do not advertise voice cloning from those weights.

## Addon usage

```js
const TTSGgml = require('@qvac/tts-ggml')
const model = new TTSGgml({
  engine: 'pocket',
  files: { modelDir: '/absolute/path/to/pocket-bundle' },
  config: { language: 'en', useGPU: false },
  threads: 1,
  seed: 1234,
  temperature: 0.3,
  steps: 1
})
try {
  await model.load()
  const response = await model.run({ input: 'Hello from Pocket TTS in Fabric.' })
  for await (const chunk of response.iterate()) {
    // chunk.outputArray: Int16Array; chunk.sampleRate defaults to 24000.
    // Feed samples to an audio device or collect them in a WAV file.
  }
} finally {
  await model.destroy()
}
```

`npm run example:pocket -- /absolute/bundle "Hello from Fabric." /tmp/pocket.wav`
saves a playable WAV. The addon also accepts explicit `files.pocketFlowModel`,
`files.pocketMimiModel`, `files.pocketFrontend` and `files.pocketVoice` paths.

`run()` streams native chunks without sentence splitting, including when
`streamOutput: true` is requested. `runStream()` explicitly splits sentences;
`runStreaming()` accepts incremental text. `cancel()` invalidates pending text
and waits for native completion before another request is admitted.
A `run()` AbortSignal also stops native work. Invalid reload options or failed
replacement activation preserve the previously loaded model. Overlapping
lifecycle operations are rejected; `unload()` permits a later load/reload,
while `destroy()` is terminal.

## Public SDK usage

```js
import { loadModel, textToSpeech, unloadModel, close } from '@qvac/sdk'
const root = '/absolute/path/to/pocket-bundle'
const modelId = await loadModel({
  modelType: 'tts-ggml',
  modelSrc: `${root}/flow-lm.gguf`,
  modelConfig: {
    ttsEngine: 'pocket',
    language: 'en',
    useGPU: false,
    mimiModelSrc: `${root}/mimi.gguf`,
    frontendSrc: `${root}/frontend.json`,
    voiceSrc: `${root}/voice.gguf`,
    threads: 1,
    seed: 1234,
    outputSampleRate: 24000
  }
})
try {
  const response = textToSpeech({ modelId, text: 'Hello from Fabric.', stream: false })
  const pcm = await response.buffer
  await response.done
  // pcm contains PCM16 samples at the configured output sample rate.
} finally {
  await unloadModel({ modelId, autoClose: false })
  await close()
}
```

Companion sources use the standard model-source resolver, including local paths
and descriptors. For reference conditioning supply `referenceAudioSrc` instead
of `voiceSrc`. The schema requires exactly one. Each model admits one active
TTS request; queued requests wait until cancellation and native callbacks drain.

## Supported controls

English only; CPU only; `threads` defaults to one per worker (two workers).
`seed` accepts unsigned 32-bit integers. `temperature`, `steps`, `nCtx`,
`maxTokens`, `noiseClamp`, `eosThreshold`, `framesAfterEos` and
`outputSampleRate` are validated before native loading. Output resampling
supports 8–192 kHz. Other engines' sampling, emotional, speed, GPU and
LavaSR settings are rejected instead of silently ignored.

## Validation

Build native prebuilds using the package's pinned vcpkg registry, then build
TypeScript in `@qvac/tts-ggml`, `@qvac/inference` and `@qvac/sdk`.
Set `QVAC_POCKET_MODEL_DIR` to the converted bundle for real-model tests:

- In the addon: `npm run test:pocket`; set `QVAC_POCKET_AUDIO_OUTPUT` to save WAV.
- In inference: `npm run test:pocket` (schema, lifecycle and real-plugin tests).
- In SDK: `npm run test:pocket:node` (public APIs over a real Bare worker/socket).

The SDK test requires model assets rather than skipping. Its owned temporary
configuration, cache and worker are bounded by a process supervisor. The
inference and addon real-model tests skip when their model variable is absent;
pass it explicitly when validating synthesis.

The current macOS port passes eight native Pocket tests, 282 addon unit tests,
the real addon and inference tests, and four public SDK transport tests. The
current pinned iOS Simulator Bare Kit worklet also passes 58 assertions and
generates a valid WAV (Bare 1.29.4, iOS 18.6).
Adversarial review covered native math/asset validation in the speech repository
and addon request/lifecycle races, cancellation, reload and test cleanup here.
Audio checks cover sample validity, clipping and automated transcription;
these are not subjective naturalness ratings.

The full current inference TypeScript build has existing errors in safe-fetch,
AudioGen and sdcpp. Focused Pocket compilation uses `noEmitOnError` and passes;
the current SDK compiles. Physical iOS / Android audio validation and mobile
SDK transport validation remain outside the measured coverage. Native CI
builds succeed for Android and iOS; Linux/Windows compile but the unchanged
`test-supertonic-fit-params` fails its CPU-refusal expectation.


## Dependency pins and measured performance

This change pins the registry baseline and Git reference to
`7a70a0c301c155beb85e985c542f8b0ccd090e10`, selecting speech-cpp
2026-09-10#1 and ggml-speech 2026-09-09#1. The explicit `reference` makes
the version database available before its registry PR merges; baseline alone
only selects minimum versions and otherwise vcpkg reads the default branch's
version database. See the [vcpkg registry reference documentation](https://learn.microsoft.com/en-us/vcpkg/reference/vcpkg-configuration-json#registry-reference).
The source and registry changes are draft PRs
[qvac-fabric-speech.cpp#240](https://github.com/tetherto/qvac-fabric-speech.cpp/pull/240)
and [qvac-registry-vcpkg#364](https://github.com/tetherto/qvac-registry-vcpkg/pull/364).

The final native benchmark links the exact libraries installed by the pinned
registry and normal addon build. It uses Apple M2 CPU, one thread per worker,
two workers, one warmup and three measured runs per prompt. Medians:

| Prompt | Upstream generation | Fabric generation | Upstream / Fabric audio length |
| --- | ---: | ---: | ---: |
| Short | 0.94 s | 0.98 s | 5.52 / 5.52 s |
| Numbers | 1.23 s | 1.42 s | 7.36 / 7.44 s |
| Punctuation | 1.18 s | 1.24 s | 6.88 / 6.72 s |
| Accented names | 1.23 s | 1.38 s | 7.20 / 7.36 s |
| Long | 6.16 s | 6.55 s | 36.32 / 36.48 s |

Fabric RTF is 0.178–0.191 (about 5.2–5.6× real time), versus upstream
0.167–0.172. Generation time is 5–16% above upstream across these prompts.
First audio arrives in 74–116 ms in Fabric versus 53–69 ms upstream.
Loading takes 0.23–0.31 seconds during the matrix; an earlier first launch
measured 9.61 seconds, so warmed launch timings do not establish cold-cache
startup performance. The previous manual development build was slower; these
final numbers supersede its approximately 2× slowdown.
These are native steady-state measurements; public SDK startup/IPC latency
is additional. Seeds do not produce equivalent randomness across the two
implementations at temperature 0.3. All ten WAVs pass signal checks. ASR
recovers short and punctuation prompts exactly, shares the long prompt's
single assistance/assistants mismatch, and finds a contraction difference in
the accented-name prompt. The earlier zero-temperature follow-up resolves
that contraction and gives matching transcriptions. No subjective listening
score or equal-naturalness claim is made.


To reproduce the packaged iOS worklet after building the simulator prebuild,
run `python3 scripts/run-pocket-ios-worklet.py --help`. The runner needs a
booted arm64 simulator, the bundle, Bare Kit, bare-pack >= 2 and bare-link >= 3.
It resolves pnpm package paths canonically, uses the actual TTS framework,
and leaves a fresh output directory containing logs, result JSON and WAV.
It neither boots/shuts down a simulator nor edits an app checkout. Functional
coverage runs with brittle's optional Node-only coverage reporter deferred.
