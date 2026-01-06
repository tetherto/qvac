# TTS Benchmark Results: python-native

**Implementation:** python-native
**Version:** piper-1.2.0
**Model:** model
**Dataset:** harvard
**Samples:** 70

## Performance Metrics

- **Model Load Time:** 388.22 ms
- **Total Generation Time:** 4941.39 ms
- **Total Audio Duration:** 151.34 s
- **Average RTF:** 30.9694

## RTF Distribution

- **p50 (median):** 31.0629
- **p90:** 32.3989
- **p95:** 32.7163
- **p99:** 33.0915

## Interpretation

**RTF (Real-Time Factor)** = audio_duration / generation_time

- RTF > 1.0 means faster than real-time (good!)
- RTF < 1.0 means slower than real-time (bad)
- Higher RTF is better (more efficient)
- This implementation runs at **30.97x real-time speed**
