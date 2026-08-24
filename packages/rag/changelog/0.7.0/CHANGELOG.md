# Changelog v0.7.0

Release Date: 2026-08-24

## 🔌 API

- Expose @qvac/rag/errors subpath for consumers. (see PR [#2303](https://github.com/tetherto/qvac/pull/2303)) - See [API changes](./api.md)

## 🐞 Fixes

- Load RAG hard deps with require() for Pear/CJS compatibility. (see PR [#2284](https://github.com/tetherto/qvac/pull/2284))
- Validate RAG query before logging it. (see PR [#3729](https://github.com/tetherto/qvac/pull/3729))

## 📘 Docs

- Update npm package homepage metadata. (see PR [#2810](https://github.com/tetherto/qvac/pull/2810))

## 🧹 Chores

- Switch @qvac/rag to Lunte and Prettier. (see PR [#2801](https://github.com/tetherto/qvac/pull/2801))
- Unify lint/format/typecheck across SDK-pod packages. (see PR [#3040](https://github.com/tetherto/qvac/pull/3040))
- Convert @qvac/rag to TypeScript ESM. (see PR [#3718](https://github.com/tetherto/qvac/pull/3718)) - See [breaking changes](./breaking.md)
