# TTS Benchmark Results: addon

**Implementation:** addon
**Version:** unknown
**Model:** model
**Dataset:** harvard
**Samples:** 70

## Performance Metrics

- **Model Load Time:** 731.15 ms
- **Total Generation Time:** 15441.10 ms
- **Total Audio Duration:** 165.06 s
- **Average RTF:** 10.7074

## RTF Distribution

- **p50 (median):** 10.9308
- **p90:** 11.3687
- **p95:** 11.4592
- **p99:** 11.5603

## Interpretation

**RTF (Real-Time Factor)** = audio_duration / generation_time

- RTF > 1.0 means faster than real-time (good!)
- RTF < 1.0 means slower than real-time (bad)
- Higher RTF is better (more efficient)
- This implementation runs at **10.71x real-time speed**
