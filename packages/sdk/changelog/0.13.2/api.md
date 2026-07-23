# 🔌 API Changes v0.13.2

## Separate TTS language validation per engine

PR: [#2581](https://github.com/tetherto/qvac/pull/2581)

```typescript
import {
  TTS_CHATTERBOX_LANGUAGES, // en, es, fr, de, it, pt, nl, pl, tr, sv, da, fi, no, el, ms, sw, ar, ko
  TTS_SUPERTONIC_LANGUAGES, // en, es, fr, pt, ko
  type TtsChatterboxLanguage,
  type TtsSupertonicLanguage,
} from "@qvac/sdk";

// Chatterbox now accepts all 18 multilingual languages
await loadModel({
  modelSrc: ...,
  modelConfig: { ttsEngine: "chatterbox", language: "tr" },
});
```

---

