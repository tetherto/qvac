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
    "rtf": { "mean": 0 },
    "memory": {
      "avgRssMb": 318.4,
      "peakRssMb": 402.9,
      "rssAfterLoadMb": 300.1,
      "rssAfterUnloadMb": 128.6,
      "reclaimedMb": 171.5
    }
  },
  "source": "manual"
}
```

The optional `summary.memory` block captures process resident-set-size (RSS)
usage for the model/platform/backend under test:

- `avgRssMb` — average RSS sampled during inference.
- `peakRssMb` — peak RSS observed across all runs (never below the post-load footprint).
- `reclaimedMb` — memory returned to the OS after the model is unloaded
  (`rssAfterLoadMb - rssAfterUnloadMb`, clamped at 0).

Rows without a `memory` block render as `n/a` in the aggregated report, so older
artifacts remain valid.
