# Changelog v0.15.0

Release Date: 2026-10-01

## 🔌 API

- Opt-in deferred tool loading and tool_search. (see PR [#4602](https://github.com/tetherto/qvac/pull/4602)) - See [API changes](./api.md)
- Type the OpenAI voice field on /v1/audio/speech. (see PR [#4635](https://github.com/tetherto/qvac/pull/4635)) - See [API changes](./api.md)
- Expose ABot-World layer streaming in the SDK. (see PR [#4637](https://github.com/tetherto/qvac/pull/4637)) - See [API changes](./api.md)
- Auto-install addon platform packages for mobile bundles. (see PR [#4688](https://github.com/tetherto/qvac/pull/4688)) - See [API changes](./api.md)
- Check engines.bare against the Bare runtime each host runs. (see PR [#4710](https://github.com/tetherto/qvac/pull/4710)) - See [API changes](./api.md)

## 🐞 Fixes

- Report per-request NMT translate stats. (see PR [#4616](https://github.com/tetherto/qvac/pull/4616)) - See [API changes](./api.md)
- Call loaded deferred tools under the tool-call grammar. (see PR [#4728](https://github.com/tetherto/qvac/pull/4728))

## 📦 Models

- Update @qvac/tts-ggml to 0.10.0 and add the MOSS engine. (see PR [#4723](https://github.com/tetherto/qvac/pull/4723)) - See [API changes](./api.md), [model changes](./models.md)
  Added: TTS_DELAY_LLM_MOSS_TTS_F16, TTS_CODEC_DECODER_MOSS_TTS_F16, TTS_CODEC_ENCODER_MOSS_TTS_F16

## 🧹 Chores

- Move shared serve stores and completion draining into serve/core. (see PR [#4636](https://github.com/tetherto/qvac/pull/4636))

## ⚙️ Infrastructure

- Stop CI npm installs running dependency lifecycle scripts. (see PR [#4641](https://github.com/tetherto/qvac/pull/4641))
