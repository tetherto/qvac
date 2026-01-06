# TTS Benchmark Results: addon

**Implementation:** addon
**Version:** unknown
**Model:** model
**Dataset:** harvard
**Samples:** 70

## Performance Metrics

- **Model Load Time:** 370.90 ms
- **Total Generation Time:** 12730.21 ms
- **Total Audio Duration:** 165.00 s
- **Average RTF:** 12.9544

## RTF Distribution

- **p50 (median):** 12.9573
- **p90:** 13.8345
- **p95:** 14.1130
- **p99:** 14.7187

## Interpretation

**RTF (Real-Time Factor)** = audio_duration / generation_time

- RTF > 1.0 means faster than real-time (good!)
- RTF < 1.0 means slower than real-time (bad)
- Higher RTF is better (more efficient)
- This implementation runs at **12.95x real-time speed**
