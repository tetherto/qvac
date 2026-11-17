# Performance profiles

`performance_profile` defaults to `auto`. The addon selects only measured
model/GPU/API combinations selected by the November 4–5 measurements (at least
5% faster warm generation on the engine used then). Those timings are historical;
paired performance and quality checks against the merged 2026-11-01 engine are
still required before release. Set `performance_profile: 'off'` to retain the
current engine settings.
Explicit options, including `flash_attn: false`, take precedence.

| Model checkpoint | GPU and API | Automatic change | Fallback |
| --- | --- | --- | --- |
| FLUX.2 Klein 4B Q8_0 | RTX 5090 CUDA, GB10 CUDA | GEMM VAE for single 512×512 or 1024×1024 text-to-image requests, with at least 16 GiB free after loading | Direct convolution for other requests, APIs and GPUs |
| FLUX.2 Klein 4B Q8_0 | Radeon 8060S HIP | None: repeated-output validation found an inconsistent GEMM output | Direct convolution; explicit GEMM remains experimental |
| MiniMax-H3 FL2VA Q4_K | RTX 5090 CUDA/Vulkan, GB10 CUDA, M3 Ultra Metal, Radeon 8060S HIP | Global flash attention | Previous flash-attention setting elsewhere |
| LTX-2.3 22B distilled Q5_K | M3 Ultra Metal | F16 transformer matrices for bounded video contexts with sufficient memory | Original quantized matrices |

Recognition uses GGUF tensor metadata and component sizes, not filenames. It is
deliberately restricted to the researched checkpoints and their companion files.
Unknown layouts, mixed device/module assignments, explicit precision overrides,
graph-cut budgets and layer streaming retain current settings. HIP remains a
source-build configuration; this change does not add a HIP release package.

FLUX keeps direct convolution on Metal and Vulkan, where GEMM was slower, and
on HIP, where a repeated-output quality check did not pass.
Automatic GEMM excludes reference/image conditioning, LoRA, tiling and batches. Each
request rechecks its dimensions and free memory, so a later larger request
returns to direct convolution. Reviewed output was visually identical, but not
byte-identical; GEMM used about 4.2 GiB more VRAM in the RTX measurement.

Fit probes return `unknown` only when the requested dimensions and tiling can
select GEMM: the current engine planner cannot represent that per-request
convolution change. Other shapes, tiled FLUX requests and H3 retain baseline
graph planning.
Metadata-only registry descriptions use the measured tensor-data sizes and
companion layouts to select the same profile as the full files. Header size may
change when the registry removes tokenizer tables. Static flash-attention and
F16 settings are passed to the planner; different quantizations or mismatched
companions retain baseline settings. `off` retains baseline fit planning.

H3 fused SwiGLU and QKV views are enabled by the 2026-11-01 engine by default.
The addon preserves that graph for all workloads, GPUs and profile modes,
including `off`; it does not impose the old RTX-only 28 GiB/960×544×124 graph
policy. H3's automatic change is global flash attention only. Explicit
`flash_attn`/`fa` prevents automatic attention selection; disabling
`diffusion_fa` also retains current engine behavior. The old combined graph and
attention timings cannot establish the gain from attention on this new baseline.

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
adding a measured device/API row. `stable-diffusion-cpp` resolves to registry
revision `2026-11-01#1`, containing merged
[engine #64](https://github.com/tetherto/qvac-ext-stable-diffusion.cpp/pull/64)
(`bc53357484bc5d2ba08fbe5301dae192e5b9a176`). A scoped Git registry entry pins
the branch in [registry #496](https://github.com/tetherto/qvac-registry-vcpkg/pull/496)
at `c33611a32161c01324d961cd72c5ee400262415a`; the addon carries no port overlay.
Other dependencies retain their existing registry baselines. After the registry
change merges, switch this entry's reference to `main`, pin a baseline containing
the merged revision, and verify dependency resolution before merging or releasing
the addon.

See [implementation validation](performance-profiles-validation.md) for timings,
quality comparisons, memory costs, CI status and remaining release checks.
