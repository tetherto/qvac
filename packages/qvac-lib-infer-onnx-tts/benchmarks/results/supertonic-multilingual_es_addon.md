# TTS Benchmark Results: addon

**Implementation:** supertone-onnx-addon
**Version:** unknown
**Model:** supertonic-multilingual
**Dataset:** harvard
**Samples:** 40
**Benchmark language:** es

## Quality Metrics (Round-Trip Test)

- **Average WER:** 28.22%
- **Average CER:** 9.44%
- **Min WER:** 0.00%
- **Max WER:** 100.00%
- **Min CER:** 0.00%
- **Max CER:** 44.00%
- **Samples Tested:** 40

## Performance Metrics

- **Model Load Time:** 387.69 ms
- **Total Generation Time:** 16605.73 ms
- **Total Audio Duration:** 137.72 s
- **Average RTF:** 0.1192

## RTF Distribution

- **p50 (median):** 0.1184
- **p90:** 0.1232
- **p95:** 0.1245
- **p99:** 0.1266

## Interpretation

**RTF (Real-Time Factor)** = generation_time / audio_duration

- RTF < 1.0 means faster than real-time (good!)
- RTF > 1.0 means slower than real-time (bad)
- Lower RTF is better (more efficient)
- This implementation runs at **8.39x real-time speed**

