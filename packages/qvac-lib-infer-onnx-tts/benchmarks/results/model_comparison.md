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
| TTS Addon | 58.47% | 16.67% | 100.00% |
| Python Native | 33.61% | 14.29% | 100.00% |

**Character Error Rate (CER):**

| Implementation | Average | Min | Max |
|----------------|---------|-----|-----|
| TTS Addon | 19.55% | 2.94% | 69.70% |
| Python Native | 7.23% | 2.33% | 37.21% |

❌ **Audio quality issues** - high transcription error rates (WER > 20%)
⚠️ **Python produces noticeably better audio quality** (WER difference 24.86%)

## Performance Comparison

| Metric | TTS Addon | Python Native | Difference |
|--------|-----------|---------------|------------|
| Model Load Time | 426.89 ms | 510.04 ms | -16.3% ✅ |
| Avg RTF | 16.5792 | 22.6658 | -26.9% ⚠️ |
| Total Generation | 14881.82 ms | 12253.04 ms | +21.5% ⚠️ |
| Real-time Speed | 16.58x | 22.67x | Addon is 0.82x slower |

## RTF Distribution

| Percentile | Addon | Python | Difference |
|------------|-------|--------|------------|
| p50 (median) | 16.5575 | 22.2928 | -25.7% |
| p90 | 18.6053 | 25.0791 | -25.8% |
| p95 | 18.7887 | 26.9517 | -30.3% |
| p99 | 19.3740 | 27.8968 | -30.6% |

## Summary

⚠️ **Addon is 1.21x slower** than Python native implementation

### Key Findings:

- Model loading: Addon is **16.3% faster**
- Average RTF: Addon is **26.9% worse**
- Total generation: Addon is **21.5% slower**

## Interpretation

**RTF (Real-Time Factor)** = audio_duration / generation_time

- RTF > 1.0 means faster than real-time
- RTF < 1.0 means slower than real-time
- Higher RTF is better (more efficient)
- Positive percentage difference in RTF means addon is better
