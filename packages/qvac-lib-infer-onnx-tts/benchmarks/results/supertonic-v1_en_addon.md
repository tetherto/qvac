# TTS Benchmark Results: addon

**Implementation:** supertone-onnx-addon
**Version:** unknown
**Model:** supertonic-v1
**Dataset:** harvard
**Samples:** 70
**Benchmark language:** en


## Quality Metrics (Round-Trip Test)

- **Average WER:** 6.81%
- **Average CER:** 2.92%
- **Min WER:** 0.00%
- **Max WER:** 40.00%
- **Min CER:** 0.00%
- **Max CER:** 25.00%
- **Samples Tested:** 70

## Performance Metrics

- **Model Load Time:** 464.07 ms
- **Total Generation Time:** 24123.53 ms
- **Total Audio Duration:** 197.90 s
- **Average RTF:** 0.1173

## RTF Distribution

- **p50 (median):** 0.1178
- **p90:** 0.1190
- **p95:** 0.1190
- **p99:** 0.1191

## Interpretation

**RTF (Real-Time Factor)** = generation_time / audio_duration

- RTF < 1.0 means faster than real-time (good!)
- RTF > 1.0 means slower than real-time (bad)
- Lower RTF is better (more efficient)
- This implementation runs at **8.52x real-time speed**
