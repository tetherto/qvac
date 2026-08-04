# 💥 Breaking Changes v0.9.0

## Migrate AI SDK provider to v7

PR: [#3370](https://github.com/tetherto/qvac/pull/3370)

**BEFORE:**

```json
{
  "engines": { "node": ">=20.0.0" },
  "peerDependencies": {
    "ai": "^6.0",
    "@ai-sdk/openai-compatible": "^2.0"
  }
}
```

**AFTER:**

```json
{
  "engines": { "node": ">=22.0.0" },
  "peerDependencies": {
    "ai": "^7.0",
    "@ai-sdk/openai-compatible": "^3.0"
  }
}
```

## Testing

- Provider: format; lint with zero warnings; typecheck; build; 81 unit tests passed and 2 managed integration tests skipped; package dry-run and ESM export smoke passed.
- Provider behavior: language, embedding, and image methods; callable and explicit language-model selectors; file upload/reference round trip; structured error metadata; header propagation; speech and transcription request/response handling; managed-mode surface.
- CLI: format; lint; typecheck; build; all 417 unit tests passed.
- CLI benchmark harness: benchmark typecheck and all 85 harness tests passed.
- CLI files HTTP suite: all 7 tests passed, covering exact bytes, MIME header, private cache control, metadata, listing, and missing files.

The request-scoped `tools_compact` / dynamic-tools changes were removed from this PR following maintainer feedback. This PR no longer changes the SDK or `llm-llamacpp` addon.

---
