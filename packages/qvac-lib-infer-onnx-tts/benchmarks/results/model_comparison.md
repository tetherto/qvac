# TTS Benchmark Comparison: Addon vs Python Native

**Model:** model
**Dataset:** harvard
**Samples:** 70

## Performance Comparison

| Metric | TTS Addon | Python Native | Difference |
|--------|-----------|---------------|------------|
| Model Load Time | 731.03 ms | 870.69 ms | -16.0% ✅ |
| Avg RTF | 9.3479 | 20.3232 | -54.0% ⚠️ |
| Total Generation | 20216.00 ms | 10904.01 ms | +85.4% ⚠️ |
| Real-time Speed | 9.35x | 20.32x | Addon is 0.54x slower |

## RTF Distribution

| Percentile | Addon | Python | Difference |
|------------|-------|--------|------------|
| p50 (median) | 9.4742 | 19.8120 | -52.2% |
| p90 | 10.3626 | 29.7919 | -65.2% |
| p95 | 10.5583 | 30.4244 | -65.3% |
| p99 | 10.8532 | 31.0378 | -65.0% |

## Summary

⚠️ **Addon is 1.85x slower** than Python native implementation

### Key Findings:

- Model loading: Addon is **16.0% faster**
- Average RTF: Addon is **54.0% worse**
- Total generation: Addon is **85.4% slower**

## Interpretation

**RTF (Real-Time Factor)** = audio_duration / generation_time

- RTF > 1.0 means faster than real-time
- RTF < 1.0 means slower than real-time
- Higher RTF is better (more efficient)
- Positive percentage difference in RTF means addon is better
