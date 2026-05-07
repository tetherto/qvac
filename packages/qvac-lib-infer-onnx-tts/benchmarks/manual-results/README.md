# Manual Performance Results

Drop additional Supertonic desktop benchmark JSON files in this directory when you need
to include supported GPU backends or devices that are not available on CI.

The preferred input is the same JSON artifact shape emitted by the Supertonic benchmark
client, for example:

```json
{
  "benchmark": "supertonic-rtf",
  "platform": "linux-x64",
  "implementation": {
    "key": "addon",
    "name": "supertone-onnx-addon"
  },
  "labels": {
    "device": "local-rocm-box",
    "runner": "manual",
    "backend": "rocm"
  },
  "requested": {
    "useGPU": true
  },
  "dataset": {
    "language": "en"
  },
  "model": {
    "variant": "supertonic-v1"
  },
  "summary": {
    "rtf": {
      "mean": 0.42,
      "p50": 0.41,
      "p95": 0.46
    },
    "generationMs": {
      "mean": 812
    },
    "loadTimeMs": {
      "mean": 245
    }
  },
  "quality": {
    "wer": {
      "mean": 0.031
    },
    "cer": {
      "mean": 0.012
    }
  }
}
```

These files are picked up automatically by:

- `scripts/perf-report/aggregate-supertonic-rtf.js`
- `.github/workflows/benchmark-performance-qvac-lib-infer-onnx-tts.yml`

Use this directory for results such as:

- Linux ROCm devices
- Windows CUDA-specific runs
- Any other supported backend or desktop device combination that the CI matrix cannot host
