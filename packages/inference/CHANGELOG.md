# Changelog

## [Unreleased]

### Fixed

- LLM loads no longer inject `gpu_layers: 99`. Pinning it made every load look
  user-configured to qvac-fabric, so its automatic GPU/CPU placement aborted
  with `n_gpu_layers already set by user to 99` and a model larger than VRAM was
  offloaded whole and spilled back to host memory by the driver — 2.5 tok/s on
  the reported box against 22 tok/s for the placement the fit would have chosen.
  `gpu_layers` is now unset by default, which hands the addon fabric's own `-1`
  sentinel — already "every layer" whenever the fit does not run, so the
  placement is unchanged in every case where the fit would not have helped, and
  strictly better for a model with more than 99 layers, which `99` silently
  truncated. Setting `gpu_layers` explicitly still pins the layer count and
  still disables the fit (QVAC-25039).

## [0.17.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/inference/v/0.17.0

First public release of `@qvac/inference`, the Bare-only in-process engine aligned with `@qvac/sdk` 0.17.0. Same inference API surface as the SDK, without the RPC/worker layer — register the plugins you need and run directly on Bare.
