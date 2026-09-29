# 🔌 API Changes v0.20.1

## Expose llama.cpp placement, MoE, fit and image token load config fields

PR: [#4412](https://github.com/tetherto/qvac/pull/4412)

```typescript
loadModel({
  modelSrc,
  modelType: 'llamacpp-completion',
  modelConfig: {
    threads: 8,
    'threads-batch': 16,
    'cpu-mask': 'ff',
    'override-tensor': 'blk\\.(1[0-9])\\.ffn_(up|down|gate)_exps=CPU',
    'cpu-moe': true,
    'n-cpu-moe': 2,
    'n-cpu-ffn': 4,
    'moe-cache-mib': 2048,
    'batch-size': 1024,
    'ubatch-size': 256,
    'kv-offload': false,
    'prefetch-weights': 'auto',
    'tensor-read-lazy': 'on',
    fit: true,
    'fit-target': '1024,512',
    'fit-ctx': 8192,
    'image-max-tokens': 512,
    'image-min-tokens': 64
  }
})
```

---

## Answer assessModelFit from the engine fitter, not only from coefficients

PR: [#4535](https://github.com/tetherto/qvac/pull/4535)

```ts
const { verdict, evidence } = await assessModelFit({
  models: [{ model: SOME_CATALOG_CONSTANT, workload: { kind: 'llm', contextTokens: 8192 } }]
})
// evidence === 'native-fit' when the registry published a description for it
```

---

