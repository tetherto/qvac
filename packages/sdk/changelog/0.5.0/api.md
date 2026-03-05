# 🔌 API Changes v0.4.1

## Add Config HotReload

PR: [#279](https://github.com/tetherto/qvac-sdk/pull/279)

```typescript
// Load model
const modelId = await loadModel({
  modelSrc: "pear://.../whisper.gguf",
  modelType: "whisper",
  modelConfig: { language: "en" }
});

// Hot-reload config (same modelId, zero downtime)
await loadModel({
  modelId,
  modelType: "whisper",
  modelConfig: { language: "es" }
});

```

---

## Add MCP adapter for tool integration

PR: [#290](https://github.com/tetherto/qvac-sdk/pull/290)

```typescript
import { completion } from "@qvac/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

// User creates & manages MCP client
const mcpClient = new Client({ name: "my-app", version: "1.0.0" });
await mcpClient.connect(transport);

// Pass MCP clients directly to completion
const result = completion({
  modelId,
  history,
  mcp: [{ client: mcpClient }],
});

// Execute tool calls with call()
for (const toolCall of await result.toolCalls) {
  const response = await toolCall.call();
}

// User cleans up
await mcpClient.close();
```

```typescript
import { z } from "zod";

const result = completion({
  modelId,
  history,
  tools: [
    {
      name: "get_weather",
      description: "Get weather",
      parameters: z.object({ city: z.string() }),
      handler: async (args) => {
        return await fetchWeather(args.city);
      },
    },
  ],
});

for (const toolCall of await result.toolCalls) {
  const response = await toolCall.call(); // Calls your handler
}
```

---

## Batch Embeddings

Accept string | string[] as embed input
Function overloads to return number[] for single text, number[][] for batch
Added --batch_size\t1024 to default embed config

Usage:
```js
//Single - inferred as number[]
const emb = await embed({ modelId, text: "hello" });

//Batch - inferred as number[][]
const embs = await embed({ modelId, text: ["a", "b", "c"] });
```

---

## Addon log streaming

*Addon Logging Bridge* (logging/addon.ts)

Broadcast C++ logs to all active SDK loggers per namespace (llamacpp:llm, llamacpp:embed)
Map C++ priority levels (0-4) to SDK LogLevel types
Register/unregister loggers per model for proper cleanup
Lazy Buffering (logging-stream-registry.ts)

*Buffer logs during loadModel* (before stream subscription)
Flush buffered logs when loggingStream connects
Auto-clear buffer 5s after load if no subscription
Memory-safe: 100 log limit (FIFO), 30s expiry, explicit cleanup
Console Output Control

*Added enableConsole option to LoggerOptions*
Base logger conditionally outputs to console based on enableConsole
Stream loggers default to enableConsole: false - prevents duplicate output
Regular loggers default to enableConsole !== false - console output by default
User-overridable if needed
Verbosity Constants Fix

Corrected to match addon's actual accepted values: ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3
Removed invalid SILENT: -1 (addon rejects with "Invalid verbosity value")
Updated 5 example files: VERBOSITY.SILENT → VERBOSITY.ERROR
API & Documentation

*Export loggingStream from main SDK*
Simplified README Logging section: removed code examples, added clear feature bullets
Renamed examples for clarity: addon-log-streaming.ts → logging-streaming.ts, llamacpp-file-logging.ts → logging-file-transport.ts
