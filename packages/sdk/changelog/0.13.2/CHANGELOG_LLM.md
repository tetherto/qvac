# QVAC SDK v0.13.2 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.13.2

A small patch release: TTS language validation is now engine-aware, the Bare
build of the SDK drops two Node-only install dependencies, and the bundled
`@qvac/rag` is updated.

## New APIs

TTS language validation is now specific to each engine instead of sharing a
single four-language list. Chatterbox accepts all 18 of its multilingual
languages, and Supertonic is restricted to the five it actually supports at
runtime (`en`, `es`, `fr`, `pt`, `ko`). Two new constants and their types are
exported so you can reference each engine's language set directly.

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

Supertonic configs no longer accept `de` or `it`. The native engine never
produced valid audio for those languages, so this tightens validation to match
real runtime support rather than removing a working capability.

## Dependency and Packaging Changes

The Bare build (`@qvac/bare-sdk`) no longer declares `bare-runtime` and
`bare-pack` as dependencies. Neither is reachable on Bare — Bare apps already
ship the runtime — and dropping `bare-runtime` avoids pulling roughly 80MB of
per-platform prebuilds at install time. Both packages remain available in
`@qvac/sdk` for the Node host path.

The bundled `@qvac/rag` dependency is updated to `^0.6.4`.
