# Changelog

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
