# QVAC CLI v0.14.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/cli/v/0.14.0

QVAC CLI 0.14.0 follows `@qvac/sdk` 0.20.0. `qvac configure` no longer offers the removed diffusion CPU flags, and `qvac verify bundle` looks for TTS host packages next to `@qvac/tts-ggml` instead of under its `prebuilds/` directory.

Install `@qvac/cli@0.14.0` with `@qvac/sdk@^0.20.0`. Publish this cut after SDK 0.20.0 is on npm.

## Breaking Changes

### Diffusion CPU flags in `qvac configure`

`clip_on_cpu`, `vae_on_cpu`, and `control_net_cpu` are gone from the diffusion schema. Configure prompts for `params_backend`, `backend`, `max_vram`, and `stream_layers` instead. Existing configs that still set the old keys fail validation.

**Before:**

```json
{
  "clip_on_cpu": true,
  "vae_on_cpu": true,
  "control_net_cpu": true
}
```

**After:**

```json
{
  "params_backend": "te=cpu,vae=cpu",
  "backend": "controlnet=cpu"
}
```

CPU layer streaming:

```json
{
  "params_backend": "diffusion=cpu",
  "max_vram": -1,
  "stream_layers": true
}
```

## Features

`qvac verify bundle` accepts `@qvac/tts-ggml` 0.9.x, where the native binary lives in a per-platform package (`@qvac/tts-ggml-darwin-arm64` and siblings) beside the meta package.
