# 💥 Breaking Changes v0.4.1

## Replace setConfig client API with config file

PR: [#269](https://github.com/tetherto/qvac-sdk/pull/269)

**BEFORE:**

```typescript
import { setConfig, loadModel } from "@qvac/sdk";

// Had to manually call setConfig()
await setConfig({
  cacheDirectory: "/custom/cache/path",
});

await loadModel({ modelSrc: LLAMA_3_2_1B_INST_Q4_0, modelType: "llama" });
```

####

**AFTER:**
**Create `qvac.config.json` in your project root:**

```json
{
  "cacheDirectory": "/custom/cache/path",
  "swarmRelays": ["relay-key-1", "relay-key-2"]
}
```

**Use SDK normally - config auto-loaded:**

```typescript
import { loadModel } from "@qvac/sdk";

// Config automatically loaded at initialization
await loadModel({ modelSrc: LLAMA_3_2_1B_INST_Q4_0, modelType: "llama" });
```

### Configuration Resolution

The SDK now searches for config in this order:

1. **`QVAC_CONFIG_PATH` environment variable** - Explicit path to config file
2. **Project root** - Auto-discovers `qvac.config.{ts,js,json}`
3. **SDK defaults** - Fallback if no config found

### Supported Config Formats

- **JSON:** `qvac.config.json`
- **JavaScript:** `qvac.config.js` (with `export default`)
- **TypeScript:** `qvac.config.ts` (fully typed)

```typescript
// qvac.config.ts
import type { QvacConfig } from "@qvac/sdk";

const config: QvacConfig = {
  cacheDirectory: "/custom/cache/path",
  swarmRelays: ["relay-key-1", "relay-key-2"],
};

export default config;
```

### Migration Guide

**Step 1:** Remove all `setConfig()` calls from your code

**Step 2:** Create a config file in your project root

**Step 3 (Optional):** For examples or non-standard locations, use `QVAC_CONFIG_PATH`:

```typescript
// Set BEFORE importing SDK
process.env["QVAC_CONFIG_PATH"] = "/path/to/config/qvac.config.json";

import { loadModel } from "@qvac/sdk";
```

### Available Config Options

| Option           | Type       | Required | Default          | Description                                        |
| ---------------- | ---------- | -------- | ---------------- | -------------------------------------------------- |
| `cacheDirectory` | `string`   | No       | `~/.qvac/models` | Absolute path to model cache directory             |
| `swarmRelays`    | `string[]` | No       | `undefined`      | Hyperswarm relay public keys for P2P NAT traversal |

---

## Fix Linting and Add Multilingual Models

PR: [#293](https://github.com/tetherto/qvac-sdk/pull/293)

**BEFORE:**
\*\*
WHISPER_SMALL
WHISPER_NORWEGIAN_TINY_1 // Duplicate of WHISPER_NORWEGIAN_TINY
WHISPER_TINY_SILERO // Duplicate of WHISPER_TINY
MARIAN_OPUS_EN_FR_Q4_0_1 // Duplicate of MARIAN_OPUS_EN_FR_Q4_0
MARIAN_OPUS_FR_EN_Q4_0_1 // Duplicate of MARIAN_OPUS_FR_EN_Q4_0
MARIAN_OPUS_IT_EN // Duplicate of MARIAN_OPUS_EN_IT

\*\*

**AFTER:**
\*\*
WHISPER_SMALL_Q8 // Renamed with quantization info
// Duplicates removed - use the primary constants instead

**Migration:**

- Replace `WHISPER_SMALL` with `WHISPER_SMALL_Q8`
- Replace duplicate constants with their primary versions (model files are identical)
- All model metadata and hyperdrive keys remain unchanged

---

## Capture SDK Logs Through Unified Logger/Stream

PR: [#295](https://github.com/tetherto/qvac-sdk/pull/295)

**BEFORE:**
\*\*

```typescript
import { loggingStream } from "@qvac/sdk";

for await (const log of loggingStream({ modelId: myModelId })) {
  console.log(log.message);
}
```

\*\*

**AFTER:**
\*\*

```typescript
import { loggingStream } from "@qvac/sdk";

for await (const log of loggingStream({ id: myModelId })) {
  console.log(log.message);
}
```

**Migration:** Change `modelId` → `id` in all `loggingStream()` calls.

---

### 2. `loggingStreamResponse` Property Change

**BEFORE:**

```typescript
for await (const log of loggingStream({ modelId })) {
  console.log(log.modelId); // Property name
}
```

**AFTER:**

```typescript
for await (const log of loggingStream({ id })) {
  console.log(log.id); // Property name changed
}
```

**Migration:** Change `log.modelId` → `log.id` in response handling.

---

### 3. `setGlobalLogLevel()` Removed from Public API

**BEFORE:**

```typescript
import { setGlobalLogLevel } from "@qvac/sdk";

setGlobalLogLevel("debug");
```

**AFTER:**

```typescript
// Use config file instead
// qvac.config.json
{
  "loggerLevel": "debug"
}
```

**Why removed:** Only worked in client process, not server. Config file works in both processes.

**Migration:** Move log level control to config file, or use per-logger `logger.setLevel("debug")`.

---

## Testing

Run enhanced example:

```bash
bun run examples/logging-streaming
```

Example demonstrates:

- SDK server log streaming
- Model-specific log streaming
- All three streams (SDK, LLM, Embed) running simultaneously
- Buffered startup logs

---

---
