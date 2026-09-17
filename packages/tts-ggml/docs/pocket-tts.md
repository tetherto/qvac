# Pocket TTS

Pocket is an English, CPU-only TTS engine implemented in the Fabric speech
library. It streams PCM16 audio through the `@qvac/tts-ggml` addon. Python
is used only to convert weights and benchmark the upstream reference; it is
not needed for native synthesis. Inference plugin and public SDK integration
will follow in a separate change after the addon release.

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
A `run()` AbortSignal also stops native work. Invalid reload options preserve
the loaded model. A valid `reload()` drains native work and releases the old
model before loading its replacement, so two model instances never overlap.
If replacement loading fails, the instance is left unloaded and retains its
last successful configuration; call `load()` to restore it or `reload()` to
retry with new options. Overlapping lifecycle operations are rejected;
`unload()` permits a later load/reload, while `destroy()` is terminal.

When stats are enabled with `opts: { stats: true }`, `firstAudioMs` reports
the native latency to first audio. For `runStream()` and `runStreaming()`,
it preserves the first reported native-job value rather than summing sentence
latencies; it excludes time waiting for incoming text. `chunkIndex` and `isLast`
are optional public output fields. Pocket's `run()` emits a final empty PCM
chunk with `isLast: true`; other engines may omit this metadata.

## Supported controls

English only; CPU only; `threads` defaults to one per worker (two workers).
`seed` accepts unsigned 32-bit integers. `temperature`, `steps`, `nCtx`,
`maxTokens`, `noiseClamp`, `eosThreshold`, `framesAfterEos` and
`outputSampleRate` are validated before native loading. Output resampling
supports 8–192 kHz. Other engines' sampling, emotional, speed, GPU and
LavaSR settings are rejected instead of silently ignored.

Fabric defaults to one sampling step, matching the native CLI and upstream
reference. An explicit `steps: 4` (or
addon `numInferenceSteps: 4`) offers a quality option at additional compute
cost; use `--steps 4` for an equivalent native CLI comparison.

In a listening comparison of six prompts from 0.88 to 70 seconds, the listener
reported an artifact on “speech” only in the one-step render of “Hello! We can
generate speech with Fabric.” The listener also heard the artifact in the
upstream PyTorch one-step reproduction with matching random inputs, while the
four-step render sounded clean. The faster native build and earlier build
produced nearly identical PCM, and matched-noise PyTorch synthesis closely
matched Fabric. These findings support an upstream sampling artifact for this
take, not a Fabric-specific one-step implementation bug. Four steps mitigated
this example; they are not a guarantee against all artifacts or a port fix.

On an Apple M2, the paired renders took about 20–25% longer at four steps,
while remaining faster than playback (the 70-second passage took 16.0 seconds
versus 13.0 seconds with one step, excluding model loading). These were single
renders after warmup, rather than repeated benchmark measurements.

### Why choose four steps for audio quality?

Pocket's flow sampler transforms noise into the next audio latent. One step
predicts a single update over the full interval from 0 to 1. Four steps use
four quarter-interval updates, evaluating the flow network again on the
updated latent each time. This gives the model intermediate refinement
opportunities instead of relying on one full-interval prediction. It is a
mechanistic reason to try additional steps when a take has an artifact, not
proof that the reported sound was caused by a particular numerical error.

The recommendation here is supported by the controlled listening result:
the same text, voice, seed and temperature produced an audible artifact with
one step in both Fabric and upstream, while the four-step take sounded clean
to the listener. Use `steps: 4` when avoiding this artifact matters more than
minimum generation latency. Keep `steps: 1` for the upstream performance
default. The other eleven files in the listening set had no reported artifact;
this is evidence of an improvement for one take, not a general quality score.

Only the flow sampling stage repeats; text/voice conditioning and Mimi audio
decoding are not each run four times. That is why the observed total latency
increase was about 20–25%, rather than fourfold:

| Passage | One-step generation | Four-step generation |
| --- | ---: | ---: |
| Original sentence (2.64 s audio) | 0.46 s | 0.56 s |
| Extended story (69.92 s audio) | 13.03 s | 15.96 s |

## Validation

Build the native addon with `npm run build:native`, then run `npm run lint`
and `npm run test:unit` in `packages/tts-ggml`. Set `QVAC_POCKET_MODEL_DIR`
to the converted bundle and run `npm run test:pocket` for real audio coverage.
Set `QVAC_POCKET_AUDIO_OUTPUT` to save a WAV. The real-model test skips if
its model variable is absent; pass it explicitly when validating synthesis.

The tests cover configuration, native streaming, first-audio statistics for
both streaming APIs, cancellation/recovery, reload, resampling and the
100-frame EOS-tail regression. Declaration tests cover the exported stats
and completion metadata on ordinary `run()` output. Physical iOS/Android
audio and broad subjective quality evaluations remain outside this coverage.

## Native dependencies and measured performance

The manifest requires speech-cpp and ggml-speech `2026-09-15` without changing
`vcpkg-configuration.json`. These registered versions select the merged source
commits `a976c4d63195601fcff8bfc0c2cdf3ef36fba539` (speech-cpp) and
`59a0ca2c2bcd7de36c27d930f79e0c94cc0c2ff3` (ggml-speech).
[Registry #367](https://github.com/tetherto/qvac-registry-vcpkg/pull/367)
contains these packages. Pocket resolves CPU memory planning through the
backend registry, fixing the Linux/Android unresolved `ggml_graph_plan` import.
The native fixes are merged in [ggml #92](https://github.com/tetherto/qvac-ext-ggml/pull/92)
and [speech #251](https://github.com/tetherto/qvac-fabric-speech.cpp/pull/251).

Before the addon-only review revision, these exact native port trees passed
[the full prebuild and integration run](https://github.com/tetherto/qvac/actions/runs/34975293366)
at Fabric `49d864d2e1a2070a4cb9872cd0f62319fdb9e839`: nine platform prebuilds
and seven desktop integration lanes covering CPU, Metal, Vulkan and CUDA.
That run validates the native dependencies; it does not validate subsequent
JavaScript review changes. The same native pins also passed all 10 Pocket
CTests with upstream numerical fixtures, static/dynamic CPU planner tests,
and 116 selected Supertonic Metal operations against CPU. Six paired
old-versus-merged native audio cases produced bit-identical PCM; this is
regression coverage, not proof of artifact-free output.

The recorded September 10 native benchmark linked the exact libraries installed
by the previous speech-cpp 2026-09-10#1 registry pin (`470e678f` source) and
normal addon build. It has not been rerun against the September 15 package;
current validation above covers builds and functional audio checks. It uses Apple M2 CPU, one thread per worker,
two workers, **one sampling step**, one warmup and three measured runs per
prompt, matching Fabric's default. Medians:

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
