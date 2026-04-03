# QVAC SDK v0.8.1 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.8.1

This release introduces a heartbeat mechanism for proactive provider health monitoring in delegated inference, and adds RPC health probes with delegated cancellation support. Several stability fixes address RPC progress throttling, registry download progress accuracy, and security alerts.

---

## 💥 Breaking Changes

### Heartbeat Replaces Ping

The `ping()` function has been replaced by `heartbeat()`, which extends health checking to support delegated (remote) providers. Local usage is a straightforward rename, while the new delegated mode lets consumers verify provider connectivity before initiating model loads or inference.

**Before:**

```typescript
import { ping } from "@qvac/sdk";
const pong = await ping();
```

**After:**

```typescript
import { heartbeat } from "@qvac/sdk";

// Local heartbeat (replaces ping)
await heartbeat();

// Delegated heartbeat — verify a remote provider is reachable
await heartbeat({
  delegate: { topic: "topicHex", providerPublicKey: "peerHex", timeout: 3000 },
});
```

---

## 🔌 New APIs

### RPC Health Probe for Delegation

Delegated model loading now supports an optional `healthCheckTimeout` parameter. When set, the SDK performs an RPC-level health probe before attempting the load, and stale connections are cleaned up centrally rather than per-caller.

```typescript
await loadModel({
  modelSrc: LLAMA_3_2_1B_INST_Q4_0,
  modelType: "llm",
  delegate: {
    topic: topicHex,
    providerPublicKey,
    timeout: 30_000,
    healthCheckTimeout: 2000, // optional, defaults to 1500ms
  },
});
```

### Delegated Cancellation

Cancel operations now route automatically to remote providers when the target model is delegated. Inference cancellation requires no API change — the SDK detects delegation from the model registry. Remote download cancellation accepts an optional `delegate` field.

```typescript
// Cancel delegated inference (routes automatically via model registry)
await cancel({ operation: "inference", modelId: "delegated-model-id" });

// Cancel delegated remote download
await cancel({
  operation: "downloadAsset",
  downloadKey: "download-key",
  delegate: { topic: "topicHex", providerPublicKey: "peerHex" },
});
```

---

## 🐞 Bug Fixes

- **IndicTrans model type unblocked** — The NMT translation plugin no longer incorrectly blocks IndicTrans models from loading, restoring multi-engine translation support.
- **Accurate download progress** — Registry downloads now report progress from the network layer instead of disk I/O polling, giving real-time progress that reflects actual bytes received.
- **RPC progress throttling** — Progress frames sent over RPC are now throttled to prevent call stack overflow when large models produce rapid progress updates.
- **VLM addon classification** — The model registry has been regenerated to correctly classify VLM (Vision-Language Model) addons, fixing misrouted model loads.
- **Security alerts resolved** — Code scanning alerts across SDK pod packages have been addressed.

---

## 📘 Documentation

- All SDK READMEs now reference the `@qvac` npm namespace instead of the legacy `@tetherto` scope.

---

## 🧪 Testing

- New E2E tests cover parallel download scenarios and cancel isolation to prevent race conditions between concurrent operations.
- The mobile E2E test executor has been refactored to an asset-based architecture for more reliable cross-platform testing.
