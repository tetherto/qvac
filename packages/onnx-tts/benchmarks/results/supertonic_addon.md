# TTS Benchmark Results: addon

**Implementation:** supertone-onnx-addon
**Version:** unknown
**Model:** supertonic
**Dataset:** harvard
**Samples:** 70

## Quality Metrics (Round-Trip Test)

- **Average WER:** 5.26%
- **Average CER:** 1.94%
- **Min WER:** 0.00%
- **Max WER:** 42.86%
- **Min CER:** 0.00%
- **Max CER:** 31.25%
- **Samples Tested:** 70

## Performance Metrics

- **Model Load Time:** 280.38 ms
- **Total Generation Time:** 24561.32 ms
- **Total Audio Duration:** 197.90 s
- **Average RTF:** 0.1189

## RTF Distribution

- **p50 (median):** 0.1203
- **p90:** 0.1210
- **p95:** 0.1212
- **p99:** 0.1214

## Interpretation

**RTF (Real-Time Factor)** = generation_time / audio_duration

- RTF < 1.0 means faster than real-time (good!)
- RTF > 1.0 means slower than real-time (bad)
- Lower RTF is better (more efficient)
- This implementation runs at **8.41x real-time speed**
