# Performance profiles

`performance_profile` defaults to `auto`. The addon selects only measured
model/GPU/API combinations whose complete profile improved warm generation latency by at least
5%. Set `performance_profile: 'off'` to retain the previous native settings.
Explicit options, including `flash_attn: false`, take precedence.

| Model checkpoint | GPU and API | Automatic change | Fallback |
| --- | --- | --- | --- |
| FLUX.2 Klein 4B Q8_0 | RTX 5090 CUDA, GB10 CUDA | GEMM VAE for single 512×512 or 1024×1024 text-to-image requests, with at least 16 GiB free after loading | Direct convolution for other requests, APIs and GPUs |
| FLUX.2 Klein 4B Q8_0 | Radeon 8060S HIP | GEMM VAE for single 1024×1024 text-to-image requests with the same memory guard | Direct convolution at unvalidated dimensions |
| MiniMax-H3 FL2VA Q4_K | RTX 5090 CUDA/Vulkan, GB10 CUDA, M3 Ultra Metal, Radeon 8060S HIP | Global flash attention | Previous flash-attention setting elsewhere |
| MiniMax-H3 FL2VA Q4_K | RTX 5090 CUDA/Vulkan | Fused SwiGLU and QKV views, together with automatic global flash attention | Original graph elsewhere, including Metal |
| LTX-2.3 22B distilled Q5_K | M3 Ultra Metal | F16 transformer matrices for bounded video contexts with sufficient memory | Original quantized matrices |

Recognition uses GGUF tensor metadata and component sizes, not filenames. It is
deliberately restricted to the researched checkpoints and their companion files.
Unknown layouts, mixed device/module assignments, explicit precision overrides,
graph-cut budgets and layer streaming retain current settings. HIP remains a
source-build configuration; this change does not add a HIP release package.

FLUX keeps direct convolution on Metal and Vulkan, where GEMM was slower.
Automatic GEMM excludes reference/image conditioning, LoRA, tiling and batches. Each
request rechecks its dimensions and free memory, so a later larger request
returns to direct convolution. Reviewed output was visually identical, but not
byte-identical; GEMM used about 4.2 GiB more VRAM in the RTX measurement.

Fit probes return `unknown` for profiles with per-request GEMM changes
or H3 graph changes: the current engine planner cannot represent those graphs.
They never report a fit based on the smaller baseline workspace.
Metadata-only registry descriptions also return `unknown` when their tensors
could select a profile after downloading the full checkpoint. `off` retains
baseline fit planning.

H3's graph changes are local to its context. Explicit `flash_attn`/`fa` prevents
automatic flash attention and the accompanying graph profile; disabling
`diffusion_fa` also retains baseline behavior. The engine itself does not enable
the graph changes by default.
The RTX graph profile requires at least 28 GiB free at load. Below that threshold,
only the independently validated flash-attention change is selected.
Graph changes apply only to 960×544×124 text-to-video requests. Other requests
restore the original graph in the same context, retaining automatic attention.

## Bounded LTX precision

Declare all three limits when loading a video model:

```js
config: {
  performance_profile: 'auto',
  performance_max_width: 512,
  performance_max_height: 320,
  performance_max_frames: 97
}
```

Requests and fit probes above these limits fail before inference. They are output
limits, separate from the existing decoded-input pixel limits. The limits remain
in force even when the precision profile is unavailable or disabled.

The Metal profile requires GPU-resident parameters, at least 96 GiB physical
memory, 76 GiB available host memory and 64 GiB available Metal working-set budget
at load. It converts selected transformer matrices to F16; it does not change
the encoder or VAE precision. The measured improvement was 5.4%, with exact
output pixels and about 26 GiB additional process memory. Unbounded contexts
retain the original precision. Memory availability can change after loading;
callers still need to serialize workloads and handle allocation failures.
Loading is slower: the final pair took 8.7 → 15.8 s to load. Load plus the first
clip was 2.4% slower, despite the warm-generation gain. Use `off` for single-clip
contexts until cold-start validation establishes a benefit for that workload.

## LTX quality tradeoff and residency

The addon already defaults to `temporal_tiling: false` (full-temporal decoding).
Research measured a 7.2% RTX CUDA gain against an explicitly tiled 193-frame
configuration, with small visible texture/contrast differences and exact audio.
That is not an additional improvement over the existing addon default. Profiles
leave temporal tiling unchanged, including explicit `temporal_tiling: true`.

VAE weights already remain on the runtime GPU when no parameter-residency
override is supplied. For an otherwise CPU-resident LTX configuration on RTX
5090 Vulkan, explicitly choosing `params_backend: 'cpu,vae=vulkan0'` improved
latency by 6.8–9.3%, with exact output and about 1.4 GiB additional VRAM. Automatic
profiles do not rewrite a caller's CPU-residency request.

## Validation and extensions

The measured scope is limited to these checkpoints, workloads and accelerators.
Other family members, larger outputs, adapters and devices need paired speed,
memory and quality validation before extending the allowlist. FLUX Metal F16,
H3 Strix Vulkan and LTX GB10 temporal changes remain excluded by the 5% rule.

Hardware classification and selection are grouped in
`addon/src/utils/PerformanceProfiles.cpp`. Add selection and fallback tests when
adding a measured device/API row. The temporary vcpkg overlay carries the two
engine setters until the engine PR and registry repin are merged; remove the
overlay before releasing the addon.

See [implementation validation](performance-profiles-validation.md) for timings,
quality comparisons, memory costs, CI status and remaining release checks.
