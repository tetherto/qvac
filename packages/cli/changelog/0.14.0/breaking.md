# 💥 Breaking Changes v0.14.0

## Integrate diffusion layer streaming in the SDK

PR: [#4389](https://github.com/tetherto/qvac/pull/4389)

**BEFORE:**

```typescript
const modelConfig = {
  clip_on_cpu: true,
  vae_on_cpu: true,
  control_net_cpu: true
}
```

**AFTER:**

```typescript
const modelConfig = {
  params_backend: 'te=cpu,vae=cpu',
  backend: 'controlnet=cpu'
}
```

To run the text encoder or VAE graph on CPU, add `te=cpu` or `vae=cpu` to `backend`.

CPU layer streaming requires CPU diffusion parameter residency and graph cutting enabled by `max_vram`:

```typescript
const modelConfig = {
  params_backend: 'diffusion=cpu',
  max_vram: -1,
  stream_layers: true
}
```
