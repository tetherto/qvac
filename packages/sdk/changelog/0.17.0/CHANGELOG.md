# Changelog v0.17.0

Release Date: 2026-08-06

## ✨ Features

- Integrate unified ASR addon into SDK. (see PR [#3586](https://github.com/tetherto/qvac/pull/3586))

## 🔌 API

- Count emitted tokens for usage, keep decode count for length. (see PR [#3573](https://github.com/tetherto/qvac/pull/3573)) - See [API changes](./api.md)
- Add backend diagnostics contract. (see PR [#3663](https://github.com/tetherto/qvac/pull/3663)) - See [API changes](./api.md)
- Add opt-in profiler resource gauges. (see PR [#3664](https://github.com/tetherto/qvac/pull/3664)) - See [API changes](./api.md)
- Add DSML tool call support for DeepSeek V3.2/V4. (see PR [#3668](https://github.com/tetherto/qvac/pull/3668)) - See [API changes](./api.md)

## 🐞 Fixes

- Make clearPlugins resilient to a throwing plugin releaseLogger. (see PR [#3577](https://github.com/tetherto/qvac/pull/3577))
- Bound automatic KV cache disk usage. (see PR [#3617](https://github.com/tetherto/qvac/pull/3617))

## 📦 Models

- Add AudioGen support to SDK. (see PR [#3506](https://github.com/tetherto/qvac/pull/3506)) - See [API changes](./api.md), [model changes](./models.md)
  Added: AUDIOGEN_ACESTEP_5HZ_LM_0_6B_Q8_0, AUDIOGEN_ACESTEP_V15_SFT_Q8_0, AUDIOGEN_ACESTEP_V15_TURBO_Q4_K_M, AUDIOGEN_ACESTEP_V15_TURBO_Q8_0, AUDIOGEN_QWEN3_EMBEDDING_0_6B_Q8_0 (and 1 more)
- Refresh registry model list (+10 models). (see PR [#3683](https://github.com/tetherto/qvac/pull/3683)) - See [model changes](./models.md)
  Added: ABOT_WORLD_0_5B_LF_VAE, ABOT_WORLD_0_5B_LF_VAE_F16, ABOT_WORLD_0_5B_Q8_0, DEEPSEEK_V4_304B_INST_UD_IQ2_M_SHARD, GROOT_Q5_VF16_1 (and 5 more)

## 📘 Docs

- Correct remove_thinking_from_context description for recurrent-model support. (see PR [#3650](https://github.com/tetherto/qvac/pull/3650))

## 🧪 Tests

- Adopt consumer-owned e2e queue. (see PR [#3545](https://github.com/tetherto/qvac/pull/3545))
- Add e2e coverage for qwen3.5 finetuning. (see PR [#3550](https://github.com/tetherto/qvac/pull/3550))
- Stabilize multi-turn completion e2e prompt. (see PR [#3600](https://github.com/tetherto/qvac/pull/3600))

## 🧹 Chores

- Remove stale release-notes folder from translation-nmtcpp. (see PR [#3570](https://github.com/tetherto/qvac/pull/3570))
- Adopt vla-ggml 0.16.2 in SDK. (see PR [#3579](https://github.com/tetherto/qvac/pull/3579))
- Bump addon versions to use same fabric. (see PR [#3588](https://github.com/tetherto/qvac/pull/3588))
- Adopt translation-nmtcpp 8.3.0 in SDK. (see PR [#3603](https://github.com/tetherto/qvac/pull/3603))
- Bump @qvac/bci-whispercpp to 0.6.0. (see PR [#3626](https://github.com/tetherto/qvac/pull/3626))
- Override vulnerable sdk install transitive deps. (see PR [#3628](https://github.com/tetherto/qvac/pull/3628))

## ⚙️ Infrastructure

- Gate resource collector packaging. (see PR [#3558](https://github.com/tetherto/qvac/pull/3558))

