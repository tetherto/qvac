# Manual Performance Results

Drop additional RTF benchmark JSON files here when you need to include
supported GPU backends that are not available on CI. Results are organized
per engine:

- `whisper/` — Whisper RTF artifacts (shape emitted by
  `test/benchmark/rtf-benchmark.test.js`; see `whisper/README.md`)
- `parakeet/` — Parakeet RTF artifacts (shape emitted by
  `test/benchmark/parakeet-rtf-benchmark.test.js`; see `parakeet/README.md`)

Files may carry an optional top-level `"engine"` field
(`"whisper" | "parakeet"`). When absent, the aggregator resolves the engine
from the report shape (`model.type` present ⇒ parakeet, else whisper), so
pre-merge artifacts remain valid without edits.

File naming convention:

- `rtf-benchmark-<platform>-<model>-<backend>.json`

These files are picked up automatically (recursively) by:

- `scripts/perf-report/aggregate-asr-ggml-rtf.js`
- `.github/workflows/benchmark-performance-asr-ggml.yml`
- the `combine-unified-performance-report` job in
  `.github/workflows/on-pr-asr-ggml.yml`

Use this directory for results such as:

- Linux ROCm devices
- Adreno OpenCL Android devices not in the Device Farm pool
- Any other supported backend/device combination that the CI matrix cannot host
