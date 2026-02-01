# TTS Benchmark Results: python-native

**Implementation:** python-native
**Version:** piper-1.2.0
**Model:** model
**Dataset:** harvard
**Samples:** 70

## Performance Metrics

- **Model Load Time:** 870.69 ms
- **Total Generation Time:** 10904.01 ms
- **Total Audio Duration:** 171.57 s
- **Average RTF:** 20.3232

## RTF Distribution

- **p50 (median):** 19.8120
- **p90:** 29.7919
- **p95:** 30.4244
- **p99:** 31.0378

## Interpretation

**RTF (Real-Time Factor)** = audio_duration / generation_time

- RTF > 1.0 means faster than real-time (good!)
- RTF < 1.0 means slower than real-time (bad)
- Higher RTF is better (more efficient)
- This implementation runs at **20.32x real-time speed**
