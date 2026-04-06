# 💥 Breaking Changes v0.8.1

## Add heartbeat for proactive provider status checks

PR: [#1160](https://github.com/tetherto/qvac/pull/1160)

**BEFORE:**
**
```typescript
import { ping } from "@qvac/sdk";
const pong = await ping();
```

**

**AFTER:**
**
```typescript
import { heartbeat } from "@qvac/sdk";

// Local heartbeat (replaces ping)
await heartbeat();
// Delegated heartbeat (new)
await heartbeat({
  delegate: { topic: "topicHex", providerPublicKey: "peerHex", timeout: 3000 },
});
```

## 🧪 How was it tested?
- Delegated heartbeat tested end-to-end: consumer pings provider before `loadModel`, provider responds with pong, model loads via delegation, second ping confirms connection still alive, clean shutdown

---

