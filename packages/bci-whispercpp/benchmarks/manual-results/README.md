# BCI manual benchmark results

Drop hand-collected BCI throughput results here as `*.json` to fold them into the
consolidated report produced by `scripts/perf-report/aggregate-bci-rtf.js`.

Each file may be a single record or an array of records shaped like the CI
`rtf-benchmark-*.json` artifacts (see `test/benchmark/rtf-benchmark.test.js`):

```json
{
  "platform": "linux-x64",
  "platformName": "linux",
  "model": { "name": "ggml-bci-windowed.bin" },
  "labels": { "device": "manual-rig", "backend": "vulkan" },
  "requested": { "useGPU": true, "backendHint": "vulkan" },
  "summary": {
    "tokensPerSecond": { "mean": 0, "stddev": 0, "p50": 0, "p95": 0 },
    "wallMs": { "mean": 0 },
    "rtf": { "mean": 0 }
  },
  "source": "manual"
}
```
