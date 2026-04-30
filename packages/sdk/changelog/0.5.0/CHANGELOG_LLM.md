# QVAC SDK v0.5.0 Release Notes

This release introduces a streamlined configuration system, powerful new APIs for batch embeddings and MCP tool integration, and a unified logging experience across all SDK components. We've also improved Android compatibility and fixed several critical audio processing issues.

---

## Breaking Changes

### Configuration is Now File-Based

The SDK now uses a config file instead of the `setConfig()` API. This simplifies initialization—create a `qvac.config.json` in your project root and the SDK handles the rest automatically.

**Before:**

```typescript
import { setConfig, loadModel } from "@qvac/sdk";

await setConfig({
  cacheDirectory: "/custom/cache/path",
});

await loadModel({ modelSrc: LLAMA_3_2_1B_INST_Q4_0, modelType: "llama" });
```

**After:**

```json
// qvac.config.json
{
  "cacheDirectory": "/custom/cache/path",
  "swarmRelays": ["relay-key-1", "relay-key-2"]
}
```

```typescript
import { loadModel } from "@qvac/sdk";

// Config automatically loaded at initialization!
await loadModel({ modelSrc: LLAMA_3_2_1B_INST_Q4_0, modelType: "llama" });
```

#### Config Resolution Order

The SDK searches for configuration in this order:

1. **`QVAC_CONFIG_PATH` environment variable** — Explicit path to config file
2. **Project root** — Auto-discovers `qvac.config.{ts,js,json}`
3. **SDK defaults** — Fallback if no config found

#### Supported Formats

| Format     | Filename           | Notes                        |
| ---------- | ------------------ | ---------------------------- |
| JSON       | `qvac.config.json` | Simplest option              |
| JavaScript | `qvac.config.js`   | Use `export default`         |
| TypeScript | `qvac.config.ts`   | Fully typed with `QvacConfig` |

**TypeScript example:**

```typescript
// qvac.config.ts
import type { QvacConfig } from "@qvac/sdk";

const config: QvacConfig = {
  cacheDirectory: "/custom/cache/path",
  swarmRelays: ["relay-key-1", "relay-key-2"],
};

export default config;
```

#### Migration Steps

1. Remove all `setConfig()` calls from your code
2. Create a config file in your project root
3. *(Optional)* For non-standard locations, set `QVAC_CONFIG_PATH` before importing the SDK

---

### Model Constant Cleanup

Some model constants have been renamed for clarity, and duplicate constants have been removed.

**Changes:**

| Before                     | After                                             |
| -------------------------- | ------------------------------------------------- |
| `WHISPER_SMALL`            | `WHISPER_SMALL_Q8`                                |
| `WHISPER_NORWEGIAN_TINY_1` | *(removed — use `WHISPER_NORWEGIAN_TINY`)*        |
| `WHISPER_TINY_SILERO`      | *(removed — use `WHISPER_TINY`)*                  |
| `MARIAN_OPUS_EN_FR_Q4_0_1` | *(removed — use `MARIAN_OPUS_EN_FR_Q4_0`)*        |
| `MARIAN_OPUS_FR_EN_Q4_0_1` | *(removed — use `MARIAN_OPUS_FR_EN_Q4_0`)*        |
| `MARIAN_OPUS_IT_EN`        | *(removed — use `MARIAN_OPUS_EN_IT`)*             |

All model metadata and hyperdrive keys remain unchanged—only the constant names were affected.

---

### Unified Logging API

The logging stream API has been simplified with consistent naming.

#### Parameter Change

**Before:**

```typescript
for await (const log of loggingStream({ modelId: myModelId })) {
  console.log(log.message);
}
```

**After:**

```typescript
for await (const log of loggingStream({ id: myModelId })) {
  console.log(log.message);
}
```

#### Response Property Change

The response object property also changed from `log.modelId` to `log.id`.

#### Global Log Level Moved to Config

`setGlobalLogLevel()` has been removed from the public API. It only worked in the client process, not the server. Use the config file instead:

```json
{
  "loggerLevel": "debug"
}
```

Or use per-logger control: `logger.setLevel("debug")`.

---

## New APIs

### Config Hot-Reload

You can now update a model's configuration without unloading it. Pass the existing `modelId` to `loadModel()` with new config options—the model stays loaded with zero downtime.

```typescript
// Load model with initial config
const modelId = await loadModel({
  modelSrc: "pear://.../whisper.gguf",
  modelType: "whisper",
  modelConfig: { language: "en" },
});

// Hot-reload with new config (same modelId, no reload delay)
await loadModel({
  modelId,
  modelType: "whisper",
  modelConfig: { language: "es" },
});
```

---

### MCP Tool Integration

The SDK now supports the Model Context Protocol (MCP) for tool integration. Pass MCP clients directly to `completion()` and use `call()` to execute tool calls.

**Using MCP clients:**

```typescript
import { completion } from "@qvac/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

// Create and connect your MCP client
const mcpClient = new Client({ name: "my-app", version: "1.0.0" });
await mcpClient.connect(transport);

// Pass MCP clients to completion
const result = completion({
  modelId,
  history,
  mcp: [{ client: mcpClient }],
});

// Execute tool calls
for (const toolCall of await result.toolCalls) {
  const response = await toolCall.call();
}

// Clean up when done
await mcpClient.close();
```

**Using inline tools with handlers:**

```typescript
import { z } from "zod";

const result = completion({
  modelId,
  history,
  tools: [
    {
      name: "get_weather",
      description: "Get weather for a city",
      parameters: z.object({ city: z.string() }),
      handler: async (args) => {
        return await fetchWeather(args.city);
      },
    },
  ],
});

for (const toolCall of await result.toolCalls) {
  const response = await toolCall.call(); // Executes your handler
}
```

---

### Batch Embeddings

The `embed()` function now accepts arrays, enabling efficient batch processing. Return types are automatically inferred based on input.

```typescript
// Single text → returns number[]
const embedding = await embed({ modelId, text: "hello" });

// Batch texts → returns number[][]
const embeddings = await embed({ modelId, text: ["a", "b", "c"] });
```

Batch processing uses a default batch size of 1024 for optimal throughput.

---

### Addon Log Streaming

C++ addon logs from llama.cpp, whisper.cpp, and other native libraries are now streamed through the SDK's unified logging system.

**Key features:**

- Logs broadcast to all active SDK loggers per namespace (`llamacpp:llm`, `llamacpp:embed`)
- Automatic buffering during `loadModel()` — logs are flushed when `loggingStream()` connects
- Memory-safe: 100 log limit with 30s expiry
- Console output control via `enableConsole` option

**Run the example:**

```bash
bun run examples/logging-streaming
```

---

## Features

### Unified Addon Logging

All native addons (Whisper, TTS, NMT) now use the same logging infrastructure, providing consistent log output across the entire SDK.

### Android 16KB Page Size Compatibility

Dependencies have been upgraded to comply with Android's 16KB page size requirement, ensuring compatibility with newer Android devices.

### bare-ffmpeg Decoder

The SDK now uses `bare-ffmpeg` for audio decoding, improving compatibility and performance.

### Developer Experience Improvements

- **Changelog generator** with commit/PR validation keeps release notes consistent
- **Non-blocking model update checks** in pre-commit hooks don't slow down your workflow

---

## Bug Fixes

### Audio Processing Fixes

- **Corrupted audio files no longer hang** — The SDK now properly handles malformed audio instead of blocking indefinitely
- **Decoder exit handling** — Fixed process hanging due to decoder not exiting properly
- **Decoder bump** — Updated to latest decoder version

### Whisper Improvements

- **Prompt state isolation** — Whisper prompt state no longer leaks between transcriptions, ensuring consistent results

### Android Compatibility

- **Flash Attention disabled on Android for Embeddings** — Prevents crashes on Android devices that don't support Flash Attention

---

## Documentation & Infrastructure

### Documentation

- Standardized documentation format across all guides
- New `docs:gen-pages` script for building documentation
- New `docs:gen-api` script for API reference generation
- Updated PR template, contributing guide, and README

### Infrastructure

- Automatic git tagging after npm publish
- Publish workflow for `npm-patch-*` branches
- Removed npm lockfile, standardized on Bun
