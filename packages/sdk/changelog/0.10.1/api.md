# 🔌 API Changes v0.10.1

## Add harmony tool-call dialect (gpt-oss)

PR: [#1878](https://github.com/tetherto/qvac/pull/1878)

```typescript
import { completion, type ToolDialect } from "@qvac/sdk";

// New dialect value (existing override parameter, fourth enum value).
const result = completion({
  modelId,         // gpt-oss-20b-Q4_K_M auto-routes to "harmony"
  history,
  tools,
  toolDialect: "harmony", // optional explicit override
});

// `ToolDialect` is now "hermes" | "pythonic" | "json" | "harmony".
const dialect: ToolDialect = "harmony";
```

---

