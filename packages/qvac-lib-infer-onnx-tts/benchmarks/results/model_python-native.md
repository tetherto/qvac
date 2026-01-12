# TTS Benchmark Results: python-native

**Implementation:** python-native
**Version:** piper-1.2.0
**Model:** model
**Dataset:** harvard
**Samples:** 70

## Performance Metrics

- **Model Load Time:** 510.04 ms
- **Total Generation Time:** 12253.04 ms
- **Total Audio Duration:** 274.81 s
- **Average RTF:** 22.6658

## RTF Distribution

- **p50 (median):** 22.2928
- **p90:** 25.0791
- **p95:** 26.9517
- **p99:** 27.8968

## Interpretation

**RTF (Real-Time Factor)** = audio_duration / generation_time

- RTF > 1.0 means faster than real-time (good!)
- RTF < 1.0 means slower than real-time (bad)
- Higher RTF is better (more efficient)
- This implementation runs at **22.67x real-time speed**
