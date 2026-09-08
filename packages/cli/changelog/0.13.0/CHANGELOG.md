# Changelog v0.13.0

Release Date: 2026-09-04

## 🔌 API

- Configurable worker RPC init timeout and typed startup failure cause. (see PR [#4159](https://github.com/tetherto/qvac/pull/4159)) - See [API changes](./api.md)
- Serve text translation on /qvac/v1/translate. (see PR [#4165](https://github.com/tetherto/qvac/pull/4165)) - See [API changes](./api.md)
- Surface modelConfig descriptions for every model type in qvac configure. (see PR [#4172](https://github.com/tetherto/qvac/pull/4172)) - See [API changes](./api.md)

## 🐞 Fixes

- Assemble CLI workspace SDK against local inference. (see PR [#4043](https://github.com/tetherto/qvac/pull/4043))
- Drop removed isDelegated check in serve tool-dialect. (see PR [#4117](https://github.com/tetherto/qvac/pull/4117))
- Surface preload failure cause and refuse to start when all preloads fail. (see PR [#4129](https://github.com/tetherto/qvac/pull/4129))
- Cancel model load on client disconnect, not request-body end. (see PR [#4130](https://github.com/tetherto/qvac/pull/4130))

## 🧹 Chores

- Mount the serve surfaces as extensions. (see PR [#4164](https://github.com/tetherto/qvac/pull/4164)) - See [breaking changes](./breaking.md)
- Build the cli with tsc-alias and use @ imports. (see PR [#4187](https://github.com/tetherto/qvac/pull/4187))
- Typecheck the whole cli test tree. (see PR [#4188](https://github.com/tetherto/qvac/pull/4188))
- Split the cli entry into per-command modules. (see PR [#4189](https://github.com/tetherto/qvac/pull/4189))
- Bump @fastify/swagger-ui to 6 to clear @fastify/static HIGH CVE. (see PR [#4219](https://github.com/tetherto/qvac/pull/4219))
