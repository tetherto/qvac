# Changelog v0.16.0

Release Date: 2026-10-16

## ✨ Features

- Reduce split addons' binding.js to require('#host-addon'). (see PR [#4938](https://github.com/tetherto/qvac/pull/4938)) - See [breaking changes](./breaking.md)
- Send the full conversation every cached turn. (see PR [#4951](https://github.com/tetherto/qvac/pull/4951)) - See [breaking changes](./breaking.md)

## 🔌 API

- Keep nested JSON Schema in tool parameters. (see PR [#4846](https://github.com/tetherto/qvac/pull/4846)) - See [API changes](./api.md)
- Let a load decide what the engine fitter's verdict does to it. (see PR [#4889](https://github.com/tetherto/qvac/pull/4889)) - See [breaking changes](./breaking.md), [API changes](./api.md)
- Carry past tool calls as structured history. (see PR [#4898](https://github.com/tetherto/qvac/pull/4898)) - See [API changes](./api.md)
- Add generic decision API and System One HTTP support. (see PR [#4910](https://github.com/tetherto/qvac/pull/4910)) - See [API changes](./api.md)
- Expose TTS 0.11 MOSS engines and examples. (see PR [#4982](https://github.com/tetherto/qvac/pull/4982)) - See [API changes](./api.md)
- Expose GPU backend selection for LLM, embeddings, and VLA. (see PR [#5005](https://github.com/tetherto/qvac/pull/5005)) - See [API changes](./api.md)
- Let serve clients verify the listener before sending the key. (see PR [#5022](https://github.com/tetherto/qvac/pull/5022)) - See [API changes](./api.md)
- Forward parallel_tool_calls from qvac serve. (see PR [#4923](https://github.com/tetherto/qvac/pull/4923)) - See [API changes](./api.md)

## 🐞 Fixes

- Require Node ^22.21.0 || >=24.9.0 for qvac bundle / bare-pack. (see PR [#4825](https://github.com/tetherto/qvac/pull/4825)) - See [breaking changes](./breaking.md)
- Keep the translate batch cap's code on zod 4.6.6. (see PR [#4986](https://github.com/tetherto/qvac/pull/4986))
- Keep registry engine classification consistent. (see PR [#5084](https://github.com/tetherto/qvac/pull/5084))

## 📦 Models

- Add MOSS ASR and Nemotron diarization support. (see PR [#4945](https://github.com/tetherto/qvac/pull/4945)) - See [API changes](./api.md), [model changes](./models.md)
  Added: MOSS_TRANSCRIBE_DIARIZE_F16, MOSS_TRANSCRIBE_DIARIZE_Q5_0, MOSS_TRANSCRIBE_DIARIZE_Q8_0, PARAKEET_NEMOTRON_3_DIARIZATION_Q8_0

## ⚙️ Infrastructure

- Switch the SDK toolchain from Bun to npm. (see PR [#4859](https://github.com/tetherto/qvac/pull/4859))
