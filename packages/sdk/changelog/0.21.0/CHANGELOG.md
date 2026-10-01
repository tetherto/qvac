# Changelog v0.21.0

Release Date: 2026-10-01

## ✨ Features

- Assess a model fit in loadModel's own parameters. (see PR [#4670](https://github.com/tetherto/qvac/pull/4670)) - See [breaking changes](./breaking.md)

## 🔌 API

- Opt-in deferred tool loading and tool_search. (see PR [#4602](https://github.com/tetherto/qvac/pull/4602)) - See [API changes](./api.md)
- Close the SDK gaps against @qvac/bci-whispercpp 0.9.1. (see PR [#4565](https://github.com/tetherto/qvac/pull/4565)) - See [API changes](./api.md)
- Expose ABot-World layer streaming in the SDK. (see PR [#4637](https://github.com/tetherto/qvac/pull/4637)) - See [API changes](./api.md)
- Judge a projected fit against the memory the system reports free. (see PR [#4669](https://github.com/tetherto/qvac/pull/4669)) - See [API changes](./api.md)
- Auto-install addon platform packages for mobile bundles. (see PR [#4688](https://github.com/tetherto/qvac/pull/4688)) - See [API changes](./api.md)
- Check engines.bare against the Bare runtime each host runs. (see PR [#4710](https://github.com/tetherto/qvac/pull/4710)) - See [API changes](./api.md)
- Add SDK-managed RPC servers and discovery. (see PR [#4774](https://github.com/tetherto/qvac/pull/4774)) - See [API changes](./api.md)
- Stage the Audio8 Core ML codec sidecar on Apple and report where the codec ran. (see PR [#4799](https://github.com/tetherto/qvac/pull/4799)) - See [API changes](./api.md)

## 🐞 Fixes

- Stop pinning gpu_layers so the qvac-fabric fit can run. (see PR [#4448](https://github.com/tetherto/qvac/pull/4448))
- Keep hyperdrive model downloads inside the model cache. (see PR [#4624](https://github.com/tetherto/qvac/pull/4624))
- Report per-request NMT translate stats. (see PR [#4616](https://github.com/tetherto/qvac/pull/4616))
- Call loaded deferred tools under the tool-call grammar. (see PR [#4728](https://github.com/tetherto/qvac/pull/4728))
- Align the Bare runtime range with engines.bare. (see PR [#4781](https://github.com/tetherto/qvac/pull/4781))
- Name fused TTS models from registry tags. (see PR [#4795](https://github.com/tetherto/qvac/pull/4795))

## 📦 Models

- Update @qvac/tts-ggml to 0.10.0 and add the MOSS engine. (see PR [#4723](https://github.com/tetherto/qvac/pull/4723)) - See [API changes](./api.md), [model changes](./models.md)
  Added: TTS_DELAY_LLM_MOSS_TTS_F16, TTS_CODEC_DECODER_MOSS_TTS_F16, TTS_CODEC_ENCODER_MOSS_TTS_F16
- Update registry models. (see PR [#4742](https://github.com/tetherto/qvac/pull/4742)) - See [breaking changes](./breaking.md), [model changes](./models.md)
  Added: TERNARY_BONSAI_2_27B_MULTIMODAL_PTQ1_0, TERNARY_BONSAI_2_27B_MULTIMODAL_PQ2_0, AUDIOGEN_ACESTEP_5HZ_LM_0_6B_BF16, AUDIOGEN_ACESTEP_V15_BASE_Q4_K_M, BITNET_0_7B_BASE_TQ2_0 (and 15 more)
  Removed: BITNET_0_7B_INST_TQ2_0, BITNET_1B_INST_TQ2_0, BITNET_B1_58_3B_INST_TQ2_0, LLAMA_TOOL_CALLING_1B_INST_Q4_K, PARAKEET_INDIC_CONFORMER_CTC_F16 (and 2 more)
- Load Parakeet Core ML sidecars through SDK. (see PR [#4776](https://github.com/tetherto/qvac/pull/4776)) - See [model changes](./models.md)

## 🧹 Chores

- Update @qvac/translation-nmtcpp to 0.18.0. (see PR [#4726](https://github.com/tetherto/qvac/pull/4726))
- Bump audio decoder dependency to 0.7.0. (see PR [#4743](https://github.com/tetherto/qvac/pull/4743))
- Update @qvac/audiogen-ggml to 0.5.0. (see PR [#4751](https://github.com/tetherto/qvac/pull/4751))
- Bump bci-whispercpp to 0.10.0. (see PR [#4753](https://github.com/tetherto/qvac/pull/4753))
