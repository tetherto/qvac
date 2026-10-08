# Configuration

The configuration schema lives in `src/schemas/config.ts`; resolution and runtime
state live in their neighboring configuration and runtime modules. The SDK consumes
the exported inference surface rather than maintaining an independent schema.

- Resolve and validate configuration before exposing it to handlers.
- Keep runtime configuration immutable unless a public API explicitly defines a
  reload operation.
- Add a field to its schema, resolved state, public type surface, and focused tests
  together.
- Use cross-platform path and environment handling compatible with Bare and the SDK
  hosts.
- Never put credentials or machine-specific values in committed defaults or
  examples.

Read the current source before documenting defaults; configuration fields and
defaults are intentionally not duplicated here.

`includeAudioDecoder` is a bundle-time option consumed by the SDK. Set it to
`false` for workers that only process raw PCM or streaming audio, and list the
required plugins explicitly. `audiogen-ggml` can also produce PCM or WAV without
FFmpeg. Compressed audio file decoding and compressed audiogen output formats
require `bare-ffmpeg` to be bundled.

Diffusion memory fit forwards the same ESRGAN configuration as loading. In
`mode: 'upscale'`, the primary model is the ESRGAN checkpoint. In image diffusion
mode, the resolved upscaler checkpoint is included alongside the generation
models. Load-time fit projects one upscaler pass at the addon's default image
dimensions and accounts for full-image RAM buffers as well as tiled compute
memory. Direct addon fit requests can specify dimensions and repeated passes.
Video mode ignores the image upscaler configuration, matching its loader.

ABot world-session fit needs both `taehvModelSrc` and a pre-built `sceneSrc`.
The scene header supplies the walk resolution and reference slots. Set
`world.fitSteps` to the intended number of walk steps; the default is 100.
This setting affects only the pre-load memory estimate. It does not stop the
walk or discard retained frames. The estimate includes the DiT, taehv decoder,
attention caches, retained latent history and decoded frame buffers. Creating
a scene with umT5 and the Wan VAE is a separate operation; when no scene pack
is available yet, world-session fit reports `unsupported-config`.
