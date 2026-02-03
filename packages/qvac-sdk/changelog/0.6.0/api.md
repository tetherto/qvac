# 🔌 API Changes v0.6.0

## Add Support for Sharded Pattern-Based URLs Model Downloads

PR: [#305](https://github.com/tetherto/qvac-sdk/pull/305)

```bash
bun run examples/llamacpp-sharded.ts
```

---

## Add Support for Archive-Based Sharded Models

PR: [#311](https://github.com/tetherto/qvac-sdk/pull/311)

```typescript
await loadModel({
  modelSrc: "https://huggingface.co/user/model/resolve/main/model.tar.gz",
  modelType: "llm",
});
```

```typescript
await loadModel({
  modelSrc: "./downloads/model.tar.gz",
  modelType: "llm",
});
```

```
URL/Path → Archive (.tar.gz, .tar, .tgz)?
  → Download/locate → Extract → Validate shards → Generate tensors.txt → Return first shard for addon loading
```

---

## Add OCR addon

PR: [#312](https://github.com/tetherto/qvac-sdk/pull/312)

```typescript
import {
  loadModel,
  ocr,
  OCR_CRAFT_LATIN_RECOGNIZER,
} from "@qvac/sdk";

// Load OCR model - detector is auto-derived from same hyperdrive key
const modelId = await loadModel({
  modelSrc: OCR_CRAFT_LATIN_RECOGNIZER,
  modelType: "ocr",
  modelConfig: {
    langList: ["en"],
  },
  // detectorModelSrc: CUSTOM_DETECTOR, // Optional: override auto-derived detector
});

// Non-streaming (default) - get all blocks at once
const { blocks, done } = ocr({ modelId, image: "/path/to/image.png" });
const result = await blocks;
await done;

// Streaming - process blocks as they arrive
const { blockStream, done } = ocr({ modelId, image: imageBuffer, stream: true });
for await (const blocks of blockStream) {
  console.log(blocks);
}
await done;

// OCRTextBlock type
type OCRTextBlock = {
  text: string;
  bbox?: [number, number, number, number]; // [minX, minY, maxX, maxY]
  confidence?: number;
};
```

---

## Unify model type naming with canonical engine-usecase format

PR: [#384](https://github.com/tetherto/qvac-sdk/pull/384)

```typescript
// new modelType: preferred
loadModel({modelType: "onnx-ocr", ... })
// old modelType: still valid, outputs warning in client logs.
loadModel({modelType: "ocr", ... })
// logs:
[sdk:client] Model type "ocr" is an alias and will be deprecated. Use "onnx-ocr" instead.
```

---

## Add runtime context, model config per device/brand/platform

PR: [#389](https://github.com/tetherto/qvac-sdk/pull/389)

```js
// qvac.config.js in target project
{
    "deviceDefaults": [
        {
            "name": "All Google android devices",
            "match": {
                "platform": "android",
                "deviceBrand": "google"
            },
            "defaults": {
                "llamacpp-completion": {
                    "device": "cpu"
                },
                "llamacpp-embedding": {
                    "device": "cpu"
                }
            }
        }
    ]
}
```

---

