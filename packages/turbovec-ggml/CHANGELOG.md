# Changelog

## [0.3.1] - 2026-10-29

### Changed

- `@qvac/fabric` dependency bumped `^0.24.0` -> `^0.25.0`, which carries
  `qvac-fabric` `11259.1.0` -> `11259.2.0`
  ([#5435](https://github.com/tetherto/qvac/pull/5435)): a bound on the PNG
  zlib decode, an RPC server graph-cache fix, DeepSeek V4.1 Flash and CUDA
  top-k fixes. A caret on a `0.x` version locks the minor, so `^0.24.0` would
  not have resolved `0.25.0` on its own. The mobile dev dependencies
  `@qvac/fabric-android-arm64` / `@qvac/fabric-ios` move to `^0.25.0` with it.
- `@qvac/fabric` 0.25.0 changes the layout of `common_params` and
  `common_chat_msg`, so every addon loaded in one process must resolve the
  same `@qvac/fabric` minor. Mobile apps must move `@qvac/fabric` and
  `@qvac/fabric-android-arm64` or `@qvac/fabric-ios` to `0.25.0` together.
- None of these fabric changes touch this package's code paths; the bump keeps
  it on the current shared runtime. No API change for this package.

## [0.3.0] - 2026-10-27

### Changed

- `@qvac/fabric` dependency bumped `^0.23.1` -> `^0.24.0`, which carries
  `qvac-fabric` `11259.0.1` -> `11259.1.0`
  ([#5374](https://github.com/tetherto/qvac/pull/5374)): an opt-in deferred
  gated delta net state commit for Qwen3.5 / Qwen3.5-MoE speculative decoding
  and the two ggml ops it adds. A caret on a `0.x` version locks the minor, so
  `^0.23.1` would not have resolved `0.24.0` on its own. The mobile dev
  dependencies `@qvac/fabric-android-arm64` / `@qvac/fabric-ios` move to
  `^0.24.0` with it.
- Mobile apps must move `@qvac/fabric` and `@qvac/fabric-android-arm64` or
  `@qvac/fabric-ios` to `0.24.0` together.
- No API change for this package.

## [0.2.1] - 2026-10-26

### Changed

- `@qvac/fabric` dependency bumped `^0.23.0` -> `^0.23.1`, which carries
  `qvac-fabric` `11259.0.0` -> `11259.0.1`
  ([#5339](https://github.com/tetherto/qvac/pull/5339)). `@qvac/fabric` 0.23.1
  requires the matching `@qvac/fabric-android-arm64` / `@qvac/fabric-ios`, so
  the mobile dev dependencies move to `^0.23.1`. They now take a caret, so a
  later fabric patch no longer needs a manifest change.
- Mobile apps must move `@qvac/fabric` and `@qvac/fabric-android-arm64` or
  `@qvac/fabric-ios` to `0.23.1` together.
- No API change for this package.

## [0.2.0] - 2026-10-20

### Changed

- `@qvac/fabric` dependency bumped `^0.22.0` -> `^0.23.0`, which carries
  `qvac-fabric` `11018.2.0` -> `11259.0.0`, a rebase onto upstream llama.cpp
  b11259 ([#5171](https://github.com/tetherto/qvac/pull/5171)). A caret on a
  `0.x` version locks the minor, so `^0.22.0` would not have resolved `0.23.0`
  on its own. The native API changes, so the native addon is rebuilt against
  the 0.23.0 headers.
- Mobile apps must move `@qvac/fabric` and `@qvac/fabric-android-arm64` or
  `@qvac/fabric-ios` to `0.23.0` together.
- No API change for this package.

## [0.1.1] - 2026-10-15

### Fixed

- On Windows, the addon now binds the delay-loaded `@qvac/fabric` runtime
  when it loads, so a first fabric call on a worker thread cannot fail with
  `0xC06D007E` ([#5121](https://github.com/tetherto/qvac/pull/5121)). Loading throws an error naming the fabric
  module if the bind fails.

## [0.1.0] - 2026-10-15

### Added

- Initial release: the `IdMapIndex` and `IdMapIndexFilter` vector index
  from `@qvac/embed-llamacpp`, with the same API, error names and
  `.tvim`/`.tvid` snapshot formats: `f32`, `q8`, `q4`, `turbovec-q4` and
  `turbovec-q2` storage, filtered and IVF search, mmap loading and delta
  logs. `@qvac/embed-llamacpp` drops its copy in 0.47.0; replace
  `@qvac/embed-llamacpp/idMapIndex` with `@qvac/turbovec-ggml/idMapIndex`, or
  import the class from the package root.
- C++ unit tests for the native wrapper.
