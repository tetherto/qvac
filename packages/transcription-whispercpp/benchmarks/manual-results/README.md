# Manual Performance Results

Drop additional Whisper RTF benchmark JSON files in this directory when you need
to include supported GPU backends that are not available on CI.

The preferred input is the same JSON artifact shape emitted by
`test/benchmark/rtf-benchmark.test.js`, for example:

```json
{
  "platform": "linux-x64",
  "model": {
    "name": "ggml-tiny.bin"
  },
  "labels": {
    "device": "local-rocm-box",
    "runner": "manual",
    "backend": "rocm"
  },
  "requested": {
    "useGPU": true
  },
  "summary": {
    "rtf": {
      "mean": 0.42,
      "p50": 0.41,
      "p95": 0.46
    },
    "wallMs": {
      "mean": 1234
    },
    "tokensPerSecond": {
      "mean": 98.7
    },
    "memory": {
      "avgRssMb": 318.4,
      "peakRssMb": 402.9,
      "rssAfterLoadMb": 300.1,
      "rssAfterUnloadMb": 128.6,
      "reclaimedMb": 171.5
    }
  }
}
```

The optional `summary.memory` block captures process resident-set-size (RSS)
usage for the model/platform/quantization under test:

- `avgRssMb` — average RSS sampled during inference.
- `peakRssMb` — peak RSS observed across all runs (never below the post-load footprint).
- `reclaimedMb` — memory returned to the OS after the model is unloaded
  (`rssAfterLoadMb - rssAfterUnloadMb`, clamped at 0).

Rows without a `memory` block render as `n/a` in the aggregated report, so older
artifacts remain valid.

File naming convention:

- `rtf-benchmark-<platform>-<model>-<backend>.json`

These files are picked up automatically by:

- `scripts/perf-report/aggregate-whisper-rtf.js`
- `.github/workflows/benchmark-performance-transcription-whispercpp.yml`

Use this directory for results such as:

- Linux ROCm devices
- Adreno OpenCL Android devices not in the Device Farm pool
- Any other supported backend or device combination that the CI matrix cannot host
