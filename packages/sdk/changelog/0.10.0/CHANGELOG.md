# Changelog v0.10.0

Release Date: 2026-05-01

## ✨ Features

- Add real-time voice assistant example. (see PR [#1631](https://github.com/tetherto/qvac/pull/1631))
- Add parallel orchestration, download dedupe, and generic companion-set support. (see PR [#1636](https://github.com/tetherto/qvac/pull/1636)) - See [breaking changes](./breaking.md)
- Unified CompletionEvent stream as canonical completion API. (see PR [#1673](https://github.com/tetherto/qvac/pull/1673)) - See [breaking changes](./breaking.md)
- Add Bergamot NMT companion-set grouping and path-based vocab resolution. (see PR [#1707](https://github.com/tetherto/qvac/pull/1707))
- Switch delegation to direct DHT connect, drop topic end-to-end. (see PR [#1729](https://github.com/tetherto/qvac/pull/1729)) - See [breaking changes](./breaking.md)

## 🔌 API

- Update SDK nmtcpp plugin for @qvac/translation-nmtcpp 2.0.1. (see PR [#1563](https://github.com/tetherto/qvac/pull/1563)) - See [API changes](./api.md)
- Add sentence-level streaming for onnx text-to-speech. (see PR [#1590](https://github.com/tetherto/qvac/pull/1590)) - See [API changes](./api.md)
- Support the new llm addon cache api in sdk. (see PR [#1633](https://github.com/tetherto/qvac/pull/1633)) - See [API changes](./api.md)
- Add img2img support to SDK diffusion API. (see PR [#1662](https://github.com/tetherto/qvac/pull/1662)) - See [API changes](./api.md)
- Harden suspend with lifecycle gate and add state() api. (see PR [#1691](https://github.com/tetherto/qvac/pull/1691)) - See [API changes](./api.md)
- Propagate whisper per-segment metadata to SDK users. (see PR [#1701](https://github.com/tetherto/qvac/pull/1701)) - See [API changes](./api.md)
- Make auto KV-cache reuse completed turn history. (see PR [#1705](https://github.com/tetherto/qvac/pull/1705)) - See [API changes](./api.md)
- Propagate registry download retries and expose stream timeout. (see PR [#1743](https://github.com/tetherto/qvac/pull/1743)) - See [API changes](./api.md)
- Improve model type & capability system. (see PR [#1748](https://github.com/tetherto/qvac/pull/1748)) - See [breaking changes](./breaking.md), [API changes](./api.md)
- Add responseFormat for structured output. (see PR [#1768](https://github.com/tetherto/qvac/pull/1768)) - See [API changes](./api.md)
- Sdk "dynamic" tools mode. (see PR [#1779](https://github.com/tetherto/qvac/pull/1779)) - See [API changes](./api.md)
- Pre-terminate cleanup hook + stabilise mobile smoke. (see PR [#1797](https://github.com/tetherto/qvac/pull/1797)) - See [API changes](./api.md)
- Add native tool-call dialect routing (hermes, pythonic, json) with override. (see PR [#1802](https://github.com/tetherto/qvac/pull/1802)) - See [API changes](./api.md)

## 🐞 Fixes

- Add timeout to RPC initialization in Node runtime. (see PR [#1550](https://github.com/tetherto/qvac/pull/1550))
- Enable corestoreOpts: { wait: true } for registry client. (see PR [#1699](https://github.com/tetherto/qvac/pull/1699))
- Skip kv-cache savedCount on cancelled or zero-token turns. (see PR [#1737](https://github.com/tetherto/qvac/pull/1737))
- Scope kv-cache invalidation to deleted key on RPC delete-cache. (see PR [#1740](https://github.com/tetherto/qvac/pull/1740))
- Strip __profiling envelope in delegate transport before zod validation. (see PR [#1767](https://github.com/tetherto/qvac/pull/1767))
- Replace z.xor with z.union, bump zod floor to ^4.3.0. (see PR [#1790](https://github.com/tetherto/qvac/pull/1790))
- Deterministic decoding for LLM translate. (see PR [#1808](https://github.com/tetherto/qvac/pull/1808))
- Handle inflight delegation rejection cleanup chain. (see PR [#1811](https://github.com/tetherto/qvac/pull/1811))

## 📦 Models

- Regenerate model registry with companion-set metadata. (see PR [#1700](https://github.com/tetherto/qvac/pull/1700)) - See [model changes](./models.md)
  Added: NMT_Q0F16 through NMT_Q0F16_9, NMT_Q4_0 through NMT_Q4_0_12+
  Removed: MARIAN_OPUS_*

## 📘 Docs

- Content update - SDK - diffusion - add img2img gen. (see PR [#1796](https://github.com/tetherto/qvac/pull/1796))

## 🧪 Tests

- Fix android sharded-model-resume scudo oom. (see PR [#1831](https://github.com/tetherto/qvac/pull/1831))

## 🧹 Chores

- Migrate SDK plugins to new addon constructor shape. (see PR [#1688](https://github.com/tetherto/qvac/pull/1688)) - See [breaking changes](./breaking.md)
- Refresh tests-qvac docs, tooling, and workflow job names. (see PR [#1712](https://github.com/tetherto/qvac/pull/1712))
- Scope down DataLoader cleanup to packages/rag. (see PR [#1754](https://github.com/tetherto/qvac/pull/1754))

## ⚙️ Infrastructure

- Add suite filtering and PR-triggered e2e test workflows for SDK. (see PR [#1653](https://github.com/tetherto/qvac/pull/1653))

