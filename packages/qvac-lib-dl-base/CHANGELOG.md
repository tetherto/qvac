## [0.2.1]

### Changed

- README: removed outdated npm Personal Access Token and `.npmrc` authentication instructions for installing `@qvac/dl-base`.

## [0.2.0]

- fix[bc]: correct `getStream` return type from `Promise<ReadableStream>` to `Promise<AsyncIterable<Buffer>>` to match actual runtime behavior and align with `@qvac/infer-base` Loader interface

## [0.0.1]

- feat: initial structure
