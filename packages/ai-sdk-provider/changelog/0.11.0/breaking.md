# 💥 Breaking Changes v0.11.0

## Narrow the optional `@qvac/cli` peer to `^0.17.0`

Managed mode needs `@qvac/cli@^0.17.0`. `@qvac/cli@0.16.0` cannot satisfy that 0.x caret.

**BEFORE:**

```json
{ "peerDependencies": { "@qvac/cli": "^0.16.0" } }
```

**AFTER:**

```json
{ "peerDependencies": { "@qvac/cli": "^0.17.0" } }
```

```bash
npm install @qvac/ai-sdk-provider ai @ai-sdk/openai-compatible @qvac/cli@^0.17.0
```

---
