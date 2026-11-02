# Changelog v0.22.0

Release Date: 2026-10-16

## ✨ Features

- Migrate the catalog to declarative bodies. (see PR [#4627](https://github.com/tetherto/qvac/pull/4627))
- Move the platform policy into the catalog. (see PR [#4701](https://github.com/tetherto/qvac/pull/4701))
- Run imperative bodies on the Python client. (see PR [#4702](https://github.com/tetherto/qvac/pull/4702))
- Forward the resolved load to the engine's fitter. (see PR [#4842](https://github.com/tetherto/qvac/pull/4842))
- Forward the LavaSR stage paths to the tts fitter. (see PR [#4857](https://github.com/tetherto/qvac/pull/4857))
- Project a diffusion video load instead of refusing it. (see PR [#4861](https://github.com/tetherto/qvac/pull/4861))
- Assess every candidate with its engine and drop the coefficients. (see PR [#4864](https://github.com/tetherto/qvac/pull/4864)) - See [breaking changes](./breaking.md)
- Reduce split addons' binding.js to require('#host-addon'). (see PR [#4938](https://github.com/tetherto/qvac/pull/4938)) - See [breaking changes](./breaking.md)
- Send the full conversation every cached turn. (see PR [#4951](https://github.com/tetherto/qvac/pull/4951)) - See [breaking changes](./breaking.md)
- Link mobile addons with bare-link 4. (see PR [#4978](https://github.com/tetherto/qvac/pull/4978)) - See [breaking changes](./breaking.md)

## 🔌 API

- Add the Python e2e client. (see PR [#4623](https://github.com/tetherto/qvac/pull/4623)) - See [API changes](./api.md)
- Port OCR GPU selection from the updated addon. (see PR [#4797](https://github.com/tetherto/qvac/pull/4797)) - See [API changes](./api.md)
- Support PCM-only SDK bundles with decoder-audio 0.8.0. (see PR [#4819](https://github.com/tetherto/qvac/pull/4819)) - See [API changes](./api.md)
- Add opt-in parallel tool calls. (see PR [#4830](https://github.com/tetherto/qvac/pull/4830)) - See [API changes](./api.md)
- Keep nested JSON Schema in tool parameters. (see PR [#4846](https://github.com/tetherto/qvac/pull/4846)) - See [API changes](./api.md)
- Integrate H3 image-to-video. (see PR [#4852](https://github.com/tetherto/qvac/pull/4852)) - See [API changes](./api.md)
- Carry the engine's per-device rows into the projection. (see PR [#4862](https://github.com/tetherto/qvac/pull/4862)) - See [API changes](./api.md)
- Expose image-max-megapixels in the llm load config. (see PR [#4885](https://github.com/tetherto/qvac/pull/4885)) - See [API changes](./api.md)
- Let a load decide what the engine fitter's verdict does to it. (see PR [#4889](https://github.com/tetherto/qvac/pull/4889)) - See [breaking changes](./breaking.md), [API changes](./api.md)
- Carry past tool calls as structured history. (see PR [#4898](https://github.com/tetherto/qvac/pull/4898)) - See [API changes](./api.md)
- Add generic decision API and System One HTTP support. (see PR [#4910](https://github.com/tetherto/qvac/pull/4910)) - See [API changes](./api.md)
- Expose TTS 0.11 MOSS engines and examples. (see PR [#4982](https://github.com/tetherto/qvac/pull/4982)) - See [API changes](./api.md)
- Expose audiogen-ggml 0.6.0 controls, metadata and MiniMax fit. (see PR [#5000](https://github.com/tetherto/qvac/pull/5000)) - See [API changes](./api.md)
- Expose GPU backend selection for LLM, embeddings, and VLA. (see PR [#5005](https://github.com/tetherto/qvac/pull/5005)) - See [breaking changes](./breaking.md), [API changes](./api.md)
- Assess ocr and translation loads with their engine fitters. (see PR [#5057](https://github.com/tetherto/qvac/pull/5057)) - See [API changes](./api.md)

## 🐞 Fixes

- Call the http and https request paths separately in safe-fetch. (see PR [#4674](https://github.com/tetherto/qvac/pull/4674))
- Declare the bare modules the inference tests import. (see PR [#4675](https://github.com/tetherto/qvac/pull/4675))
- Require Node ^22.21.0 || >=24.9.0 for qvac bundle / bare-pack. (see PR [#4825](https://github.com/tetherto/qvac/pull/4825)) - See [breaking changes](./breaking.md)
- Make the shared catalog green on every leg. (see PR [#4906](https://github.com/tetherto/qvac/pull/4906))
- Authenticate the worker on loopback TCP IPC (Python, Kotlin JVM). (see PR [#4935](https://github.com/tetherto/qvac/pull/4935))
- Await the engine fitter and share in-flight fit markers. (see PR [#5006](https://github.com/tetherto/qvac/pull/5006))
- Emit registry catalog strings as data. (see PR [#5011](https://github.com/tetherto/qvac/pull/5011))
- Pin the bare dev dependency to 1.34.1. (see PR [#5017](https://github.com/tetherto/qvac/pull/5017))
- Support both split-addon layouts in bundle and verify. (see PR [#5050](https://github.com/tetherto/qvac/pull/5050))
- Keep registry engine classification consistent. (see PR [#5084](https://github.com/tetherto/qvac/pull/5084))
- Run step bodies on Electron and define the Snap's resources. (see PR [#5143](https://github.com/tetherto/qvac/pull/5143))

## 📦 Models

- Refresh model constants from registry. (see PR [#4929](https://github.com/tetherto/qvac/pull/4929)) - See [breaking changes](./breaking.md), [model changes](./models.md)
  Added: AUDIOGEN_MOSS_SFX_V2_F16, AUDIOGEN_MOSS_SFX_V2_Q8_0, LAYA_421M_F16, LAYA_421M_Q8_0, LAYA_MULTILINGUAL_322M_F16 (and 7 more)
  Removed: PARAKEET_TDT_MODEL
- Add MOSS ASR and Nemotron diarization support. (see PR [#4945](https://github.com/tetherto/qvac/pull/4945)) - See [API changes](./api.md), [model changes](./models.md)
  Added: MOSS_TRANSCRIBE_DIARIZE_F16, MOSS_TRANSCRIBE_DIARIZE_Q5_0, MOSS_TRANSCRIBE_DIARIZE_Q8_0, PARAKEET_NEMOTRON_3_DIARIZATION_Q8_0

## 📘 Docs

- Document how to raise the RPC init timeout. (see PR [#4673](https://github.com/tetherto/qvac/pull/4673))
- Clarify RPC compatibility and runtime RDMA availability. (see PR [#5054](https://github.com/tetherto/qvac/pull/5054))
- State the fit comments, tests and docs as they are. (see PR [#5092](https://github.com/tetherto/qvac/pull/5092))

## 🧪 Tests

- Cover BCI memory fit from the model and embedder descriptions. (see PR [#4999](https://github.com/tetherto/qvac/pull/4999))
- Drop the multi-GPU e2e tests. (see PR [#5060](https://github.com/tetherto/qvac/pull/5060))

## 🧹 Chores

- Bump bare-signals and bare-module to current majors. (see PR [#4870](https://github.com/tetherto/qvac/pull/4870))
- Update SDK speech addon versions. (see PR [#4974](https://github.com/tetherto/qvac/pull/4974))
- Bump embed addon to 0.46.0 and align Bare runtimes. (see PR [#4987](https://github.com/tetherto/qvac/pull/4987))
- Move the SDK onto the fabric 0.22 addon set. (see PR [#5089](https://github.com/tetherto/qvac/pull/5089)) - See [breaking changes](./breaking.md)

## ⚙️ Infrastructure

- Publish a release train from one branch with nx. (see PR [#4658](https://github.com/tetherto/qvac/pull/4658))
- Run the Python client as its own e2e leg. (see PR [#4694](https://github.com/tetherto/qvac/pull/4694))
- Switch the SDK toolchain from Bun to npm. (see PR [#4859](https://github.com/tetherto/qvac/pull/4859))
- Run Snap e2e from its own workflow. (see PR [#4928](https://github.com/tetherto/qvac/pull/4928))
