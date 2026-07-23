# 🔌 API Changes v0.8.1

## Add RPC health probe and centralize stale-connection cleanup for delegation

PR: [#1149](https://github.com/tetherto/qvac/pull/1149)

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

---

## Add delegated cancellation for inference and remote downloads

PR: [#1153](https://github.com/tetherto/qvac/pull/1153)

```typescript
// Cancel delegated inference (no API change — routes automatically via model registry)
await cancel({ operation: "inference", modelId: "delegated-model-id" });

// Cancel delegated remote download (new: optional delegate field)
await cancel({
  operation: "downloadAsset",
  downloadKey: "download-key",
  delegate: { topic: "topicHex", providerPublicKey: "peerHex" },
});
```

---

