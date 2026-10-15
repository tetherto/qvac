# Changelog

## [0.1.0] - Unreleased

### Added

- Initial release: the `IdMapIndex` and `IdMapIndexFilter` vector index
  from `@qvac/embed-llamacpp`, with the same API, error names and
  `.tvim`/`.tvid` snapshot formats: `f32`, `q8`, `q4`, `turbovec-q4` and
  `turbovec-q2` storage, filtered and IVF search, mmap loading and delta
  logs. `@qvac/embed-llamacpp` drops its copy in 0.47.0; replace
  `@qvac/embed-llamacpp/idMapIndex` with `@qvac/turbovec-ggml/idMapIndex`, or
  import the class from the package root.
- C++ unit tests for the native wrapper.
