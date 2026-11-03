# Changelog v0.9.0

Release Date: 2026-10-27

## Features

- Allow TurboVec index providers to initialize asynchronously during writes, rebuilds, and checkpoint recovery. Existing synchronous providers remain supported. See PR [#5362](https://github.com/tetherto/qvac/pull/5362), [API changes](./api.md), and [breaking changes](./breaking.md).

## Changed

- Add the `@qvac/response` runtime dependency and align development dependencies with the current addon and Bare versions. These dependency changes do not change the RAG API.
