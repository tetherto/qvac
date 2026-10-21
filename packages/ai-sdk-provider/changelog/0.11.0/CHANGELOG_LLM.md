# QVAC AI SDK Provider v0.11.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.11.0

QVAC AI SDK Provider 0.11.0 follows `@qvac/cli` 0.17.0 and `@qvac/sdk` 0.23.0. The optional `@qvac/cli` peer is now `^0.17.0`. External mode and the model catalog are unchanged.

## Breaking Changes

### Managed mode requires `@qvac/cli` 0.17

Managed mode needs `@qvac/cli@^0.17.0`. `@qvac/cli@0.16.0` cannot satisfy that 0.x caret.

**Before:**

```json
{ "peerDependencies": { "@qvac/cli": "^0.16.0" } }
```

**After:**

```json
{ "peerDependencies": { "@qvac/cli": "^0.17.0" } }
```

```bash
npm install @qvac/ai-sdk-provider ai @ai-sdk/openai-compatible @qvac/cli@^0.17.0
```

## Dependency Floors

The provider now requires `@ai-sdk/provider@^4.0.10` and `@ai-sdk/provider-utils@^5.0.35`. Both stay on the same major as before.
