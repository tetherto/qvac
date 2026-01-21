# TTS Benchmark Results: addon

**Implementation:** addon
**Version:** unknown
**Model:** model
**Dataset:** harvard
**Samples:** 70

## Performance Metrics

- **Model Load Time:** 731.03 ms
- **Total Generation Time:** 20216.00 ms
- **Total Audio Duration:** 186.51 s
- **Average RTF:** 9.3479

## RTF Distribution

- **p50 (median):** 9.4742
- **p90:** 10.3626
- **p95:** 10.5583
- **p99:** 10.8532

## Interpretation

**RTF (Real-Time Factor)** = audio_duration / generation_time

- RTF > 1.0 means faster than real-time (good!)
- RTF < 1.0 means slower than real-time (bad)
- Higher RTF is better (more efficient)
- This implementation runs at **9.35x real-time speed**
