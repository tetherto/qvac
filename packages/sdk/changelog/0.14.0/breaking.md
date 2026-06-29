# 💥 Breaking Changes v0.14.0

## Silence SDK and native logs by default, opt in to surface them

PR: [#2653](https://github.com/tetherto/qvac/pull/2653)

**BEFORE:**
```typescript
// SDK and native (llama.cpp / ggml) logs print to the console by default.
await loadModel({ modelSrc: LLAMA_3_2_1B_INST_Q4_0 });
// → console fills with SDK + native output
```

**AFTER:**
```typescript
// Silent by default — no console output.
await loadModel({ modelSrc: LLAMA_3_2_1B_INST_Q4_0 });

// Opt in:
//   qvac.config.json → { "loggerConsoleOutput": true }                          // SDK logs
//   qvac.config.json → { "loggerConsoleOutput": true, "loggerLevel": "debug" }  // + native backend output
//   loggingStream({ id: SDK_LOG_ID })                                           // capture SDK logs programmatically
```

---

## Remove bare-process in favor of Bare primitives

PR: [#2689](https://github.com/tetherto/qvac/pull/2689)

**BEFORE:**
```typescript
// Use process as a global
process.exit(0)
```

**AFTER:**
```typescript
// Use Bare primitives or install bare-process
import process from "bare-process"
process.exit(0)
```

---

## Replace ONNX OCR with GGML-OCR 0.4.0 in SDK

PR: [#2785](https://github.com/tetherto/qvac/pull/2785)

_No code examples provided_

---

