# Manual Performance Results

Drop additional Parakeet RTF benchmark JSON files in this directory when you need
to include supported GPU backends that are not available on CI.

The preferred input is the same JSON artifact shape emitted by
`test/benchmark/rtf-benchmark.test.js`, for example:

```json
{
  "platform": "linux-x64",
  "model": {
    "type": "tdt"
  },
  "labels": {
    "device": "local-rocm-box",
    "runner": "manual",
    "backend": "rocm"
  },
  "config": {
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
    }
  }
}
```

File naming convention:

- `rtf-benchmark-<platform>-<model>-<backend>.json`

These files are picked up automatically by:

- `scripts/perf-report/aggregate-parakeet-rtf.js`
- `.github/workflows/benchmark-performance-qvac-lib-infer-parakeet.yml`

Use this directory for results such as:

- Linux ROCm devices
- Windows CUDA-specific runs
- Any other supported backend/device combination that the CI matrix cannot host
