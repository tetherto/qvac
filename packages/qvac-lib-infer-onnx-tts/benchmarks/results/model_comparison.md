# TTS Benchmark Comparison: Addon vs Python Native

**Model:** model
**Dataset:** harvard
**Samples:** 70

## Round-Trip Quality Test (TTS → Whisper → Text)

Tested 70 samples using Whisper transcription across 1 run(s):

### Overall Quality Comparison (Run 1)

**Word Error Rate (WER):**

| Implementation | Average | Min | Max |
|----------------|---------|-----|-----|
| TTS Addon | 6.98% | 0.00% | 37.50% |
| Python Native | 5.72% | 0.00% | 37.50% |

**Character Error Rate (CER):**

| Implementation | Average | Min | Max |
|----------------|---------|-----|-----|
| TTS Addon | 2.60% | 0.00% | 21.43% |
| Python Native | 1.63% | 0.00% | 17.95% |

✅ **Good audio quality** - both implementations produce clear speech (WER < 10%)
✅ **Implementations produce similar quality audio** (WER difference < 2%)

## Performance Comparison

| Metric | TTS Addon | Python Native | Difference |
|--------|-----------|---------------|------------|
| Model Load Time | 370.90 ms | 388.22 ms | -4.5% ✅ |
| Avg RTF | 12.9544 | 30.9694 | -58.2% ⚠️ |
| Total Generation | 12730.21 ms | 4941.39 ms | +157.6% ⚠️ |
| Real-time Speed | 12.95x | 30.97x | Addon is 0.39x slower |

## RTF Distribution

| Percentile | Addon | Python | Difference |
|------------|-------|--------|------------|
| p50 (median) | 12.9573 | 31.0629 | -58.3% |
| p90 | 13.8345 | 32.3989 | -57.3% |
| p95 | 14.1130 | 32.7163 | -56.9% |
| p99 | 14.7187 | 33.0915 | -55.5% |

## Summary

⚠️ **Addon is 2.58x slower** than Python native implementation

### Key Findings:

- Model loading: Addon is **4.5% faster**
- Average RTF: Addon is **58.2% worse**
- Total generation: Addon is **157.6% slower**

## Interpretation

**RTF (Real-Time Factor)** = audio_duration / generation_time

- RTF > 1.0 means faster than real-time
- RTF < 1.0 means slower than real-time
- Higher RTF is better (more efficient)
- Positive percentage difference in RTF means addon is better
