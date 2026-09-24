# QVAC SDK v0.20.1 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.20.1

QVAC SDK 0.20.1 is a patch on 0.20.0. It exposes the remaining llama.cpp load-time placement, MoE, fit, and image-token fields, and `assessModelFit` now runs the engine fitter on a registry fit stub instead of coefficients alone.

Install `@qvac/sdk` and `@qvac/inference` together at 0.20.1.

## New APIs

### llama.cpp placement, MoE, fit, and image-token load fields

`loadModel` for `llamacpp-completion` accepts the rest of the llama.cpp load config that 0.20.0 left off the schema: CPU placement (`threads`, `threads-batch`, `cpu-mask`, `override-tensor`), MoE offload (`cpu-moe`, `n-cpu-moe`, `n-cpu-ffn`, `moe-cache-mib`), batch sizes, KV offload, weight prefetch, tensor-read laziness, `fit` / `fit-target` / `fit-ctx`, and image token caps.

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

### `assessModelFit` uses the engine fitter

When the registry has published a fit description for a model, `assessModelFit` runs the engine fitter on that stub and returns `evidence: 'native-fit'`. Coefficient-only projection remains the fallback when no stub is available.

```typescript
const { verdict, evidence } = await assessModelFit({
  models: [{ model: SOME_CATALOG_CONSTANT, workload: { kind: 'llm', contextTokens: 8192 } }]
})
// evidence === 'native-fit' when the registry published a description for it
```

The engine depends on `@qvac/registry-client` `^0.7.0` so `fitBlobBinding` on those stubs decodes. `@qvac/sdk` no longer depends on `@qvac/registry-client`.
