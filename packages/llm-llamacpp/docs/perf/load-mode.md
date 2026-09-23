# `load_mode` on each platform and device

What each model-loading mode costs to load and to keep resident, measured per
platform and device. Produced by `benchmarks/performance/load-mode-sweep.js`
(desktop) and the load-mode shards of the mobile benchmark suite, both run by
**Benchmark Performance — LLM Parameter Sweep** with
`sweep_params=load-mode,device=cpu|gpu`.

> Status: **every platform measured.** Every mode on every platform and device
> is either measured or recorded as not comparable with the reason — no row is
> missing and none is inferred. Two version notes apply, both in
> §"Versions measured": win32-x64 and linux-x64 figures come from
> `@qvac/llm-llamacpp@0.53.2`, and `dio` changed meaning in `0.54.0`.

## What the modes are

From `addon/src/model-interface/LoadFitNormalization.cpp` (`kLoadModes`) and
qvac-fabric `v10549.3.0` (`llama-model-loader.cpp`, `llama-mmap.cpp`):

| Mode | Maps the weights | Locks | Direct I/O |
|------|------------------|-------|-----------|
| `auto` | yes, **unless** a selected device reports no mmap support → loads anonymously | no | no |
| `mmap` | yes | no | no |
| `mlock` | **no** — reads anonymously, then locks | yes | no |
| `mmap+mlock` | yes | yes | no |
| `none` | no | no | no |
| `dio` | no | no | **Linux and Android only, from `0.54.0`** — see "`dio`" |

`mlock` is not "`mmap` plus locking". It is the anonymous path plus locking.

**`auto` is the default**, pinned by
`LlamaModelTest.CommonParamsParseLoadModeDefaultsToAuto` since the fabric b10549
sync (#4154). Every margin below is quoted against `auto`, and against `mmap`,
which `auto` resolves to on most devices.

`auto` falls back to the anonymous path when any selected device sets
`mmap_support = false`: OpenCL (`ggml-opencl.cpp`), Hexagon
(`ggml-hexagon.cpp`), Vulkan integrated GPUs (`ggml-vulkan.cpp`,
`!ctx->is_integrated_gpu`) and CUDA integrated GPUs (`ggml-cuda.cu`). On
everything else it maps.

## Verdict per platform and device

"Best" is the lowest median load among rows that ran on the device they asked
for. Where it is within the samples' spread of `auto` it is reported as a tie,
because a ranking inside the noise is not a finding. Memory is the resident
delta across the load; `anon` is the part the system must actually find, and
exists only where `/proc` does (Linux, Android).

| Platform · device | Best mode, margin vs `auto` / vs `mmap` | Memory | Supports a default other than `auto`? |
|---|---|---|---|
| linux-x64 · CPU | tie: `auto` ≡ `mmap` ≡ `mmap+mlock` (all within 5%, inside spread); anonymous modes 15–22% slower | mapped uses 230–470 MiB **less** `anon` | **No** |
| linux-x64 · GPU (RTX 4000 Ada) | tie: `mmap`/`mmap+mlock` −1 to −3% vs `auto`, 0 to −2% vs `mmap`; anonymous 4–13% slower | `anon` identical across modes (weights in VRAM); mapped holds ~200–400 MiB more file-backed | **No** |
| linux-arm64 · CPU | tie: `auto` ≡ `mmap` (±7%, spread ±50–100 ms); anonymous 13–25% slower; `dio` 1.8–3.1× slower | mapped uses 210–420 MiB **less** `anon` | **No** |
| linux-arm64 · GPU | not measurable — no GPU on the runner; every request ran on the CPU and is recorded as such | — | No evidence either way |
| win32-x64 · CPU | mixed: `none` −5.6% vs `auto` on qwen3.5-2b and −5.7% on qwen3-1.7b, +2% on qwen3.5-0.8b | `rss` lower for anonymous, but Windows does not split file-backed from private, so not comparable (§"Reading the memory columns") | **Not yet** — gaps are small and inconsistent across models |
| win32-x64 · GPU (RTX 4000 Ada) | tie: all modes within ±4% | anonymous `rss` 470–1150 MiB lower, same caveat | **Not yet** — would need a private/file split first |
| darwin-x64 · CPU | tie: `auto` ≡ `mmap` (±1.4%); anonymous 5–9% slower | anonymous `rss` 240–720 MiB lower; no split on macOS | **No** |
| darwin-x64 · GPU (Paravirtual Metal) | `mmap` ≡ `auto` (≤2%); **anonymous 7–29× slower** (e.g. 57.0 s vs 2.0 s) | anonymous `rss` 280–760 MiB lower | **No** — `mmap` is decisively right here |
| Android · CPU (Pixel 9 Pro, Galaxy S25/S26 Ultra) | tie: `auto` ≡ `mmap` (±4%); anonymous 5–12% slower | mapped uses 210–240 MiB **less** `anon` | **No** |
| Android · GPU, Adreno (Galaxy S25/S26 Ultra) | `auto` loads anonymously here, as designed; S25 `auto` −12% vs `mmap`, S26 tie (+0.6%) | same total `rss`; `auto` holds ~200 MiB as `anon` that `mmap` holds file-backed | **No** — `auto` already makes the per-device choice |
| Android · GPU, Mali (Pixel 9 Pro) | tie: all within ±8% on one load each | modes indistinguishable (~1.3 GiB file-backed in every mode) | **No** |
| iOS · CPU (iPhone 16, 17) | tie: all within ±7% on one load each | `rss` flat across modes (612–658 MiB) | **No** |
| iOS · GPU, Metal (iPhone 16, 17) | `auto` ≡ `mmap`; anonymous 3–8% slower than `auto` | anonymous `rss` 330–410 MiB **higher** | **No** |

**The evidence does not support a per-platform default other than `auto` on any
platform tested.** Where `auto` and `mmap` coincide (every desktop, Android CPU,
iOS), mapping is faster or level everywhere except Windows CPU, and uses less
of the anonymous memory a system has to find wherever that can be measured. Where they diverge — Adreno
on Android, and the integrated GPU on the developer host below — `auto`'s
anonymous choice was 12% faster than `mmap` on one phone, level on the other,
and ~9% slower on the integrated GPU in exchange for ~200 MiB less resident
memory on a device that shares system RAM. A flat
per-platform `mmap` would override exactly the per-device decision `auto`
exists to make, and a flat `none` loses on load time nearly everywhere and
catastrophically on the darwin-x64 GPU.

Windows is the one open question: anonymous loads were marginally faster on
some models and hold less `rss`, but the gaps are inconsistent and Windows'
working set cannot be split into file-backed and private pages with the
counters the sweep reads today. It does not justify a change; it justifies a
follow-up measurement.

**`dio` is never the right choice.** Where it takes effect (Linux and Android
from `0.54.0`) it bypasses the page cache and loads 1.2–3.1× slower on CPU;
elsewhere it is `none`.

**`mlock` and `mmap+mlock` locked nothing on any CI host or phone that reports
a `locked` counter**, so neither can be recommended on the strength of these
runs; see §"`mlock` locks nothing on a GPU load".

## Versions measured

| Source | Addon | qvac-fabric | Platforms |
|---|---|---|---|
| CI, 2026-09-23, after rebasing onto `0.54.0` | `@qvac/llm-llamacpp@0.54.0` | `v10549.3.0` (`@qvac/fabric` 0.17.0) | linux-arm64, darwin-x64, Android, iOS |
| CI, 2026-09-23, before the rebase | `@qvac/llm-llamacpp@0.53.2` | `v10549.1.0` (`@qvac/fabric` 0.16.1) | linux-x64, win32-x64 |
| Developer host | `@qvac/llm-llamacpp@0.53.2` | `v10549.1.0` | linux-x64 with integrated and discrete GPUs |

- **win32-x64 on `0.54.0` cannot load any model.** Every cell fails with
  "Failed to initialize model", CPU included; llama.cpp logs "no usable GPU
  found" and "failed to load model" on a host with an RTX 4000, so no ggml
  backend is loaded at all. The package's own Windows integration tests fail the
  same way on `0.54.0`, while this sweep's Windows leg measured every cell on
  `0.53.2` earlier the same day. The `0.53.2` figures are therefore the Windows
  evidence.
- **linux-x64** figures are from `0.53.2` because the CI GPU runner was
  unavailable for the `0.54.0` pass.
- **Why `0.53.2` figures still stand.** linux-arm64 ran on both versions. Apart
  from `dio`, every mode's anonymous memory is identical to the MiB and every
  load time is within −8% to +1% (most within 3%), so the version change moved
  nothing but `dio` on the path this sweep observes.
- **`dio`** is ignored on every platform in `0.53.2` and takes effect on Linux
  and Android in `0.54.0`; each `dio` row below is labelled with which applies.

## Results by platform

Medians of five loads per desktop cell, each load its own process; one load
per mobile cell (§"Desktop and mobile do not measure to the same precision").
Memory in MiB. A row that ran on a different device from the one it requested
is labelled and excluded from every margin.

**Hosts.** linux-x64 and win32-x64: self-hosted, NVIDIA RTX 4000 SFF Ada.
linux-arm64: GitHub-hosted `ubuntu-22.04-arm`, no GPU (its Vulkan device is
LLVMpipe). darwin-x64: GitHub-hosted `macos-15-large`, a VM exposing Apple
Paravirtual Metal — a virtual GPU, so its GPU figures describe that runner, not
Intel Macs with a real GPU. Android: Google Pixel 9 Pro (Mali), Samsung Galaxy
S25 Ultra and S26 Ultra (Adreno), all on Vulkan. iOS: iPhone 16 and 17 on Metal.
Models: Qwen3-1.7B, Qwen3.5-0.8B and Qwen3.5-2B on desktop; Qwen3.5-0.8B on
mobile; all Q4_0.

### linux-x64

**cpu · `qwen3-1.7b-Q4_0`**

| mode | status | load ms (median) | ± σ | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | measured | 706.6 | 101.5 | — | +1.0% | 2150 | 1044 | 1106 | 0 |
| `none` | measured | 823.6 | 78.3 | +16.6% | +17.7% | 1421 | 1310 | 111 | 0 |
| `mmap` | measured | 699.8 | 21.5 | -1.0% | — | 2151 | 1044 | 1107 | 0 |
| `mlock` | measured (locked 0) | 834.2 | 36.6 | +18.1% | +19.2% | 1421 | 1310 | 111 | 0 |
| `mmap+mlock` | measured (locked 0) | 703 | 10.7 | -0.5% | +0.5% | 2152 | 1045 | 1107 | 0 |
| `dio` | measured (flag ignored before 0.54.0) | 834.7 | 87 | +18.1% | +19.3% | 1421 | 1309 | 112 | 0 |

**cpu · `qwen3.5-0.8b-Q4_0`**

| mode | status | load ms (median) | ± σ | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | measured | 811.3 | 31.3 | — | -1.8% | 1001 | 416 | 585 | 0 |
| `none` | measured | 931.3 | 106.2 | +14.8% | +12.8% | 761 | 649 | 112 | 0 |
| `mmap` | measured | 825.9 | 108 | +1.8% | — | 1000 | 415 | 585 | 0 |
| `mlock` | measured (locked 0) | 901.8 | 77.2 | +11.2% | +9.2% | 761 | 649 | 112 | 0 |
| `mmap+mlock` | measured (locked 0) | 819 | 59.5 | +0.9% | -0.8% | 999 | 415 | 584 | 0 |
| `dio` | measured (flag ignored before 0.54.0) | 891.4 | 93.8 | +9.9% | +7.9% | 757 | 646 | 112 | 0 |

**cpu · `qwen3.5-2b-Q4_0`**

| mode | status | load ms (median) | ± σ | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | measured | 927 | 30.5 | — | +3.9% | 2111 | 851 | 1260 | 0 |
| `none` | measured | 1086.9 | 36.5 | +17.2% | +21.9% | 1436 | 1324 | 112 | 0 |
| `mmap` | measured | 891.9 | 18.4 | -3.8% | — | 2111 | 851 | 1260 | 0 |
| `mlock` | measured (locked 0) | 1093.4 | 41.3 | +18.0% | +22.6% | 1433 | 1321 | 112 | 0 |
| `mmap+mlock` | measured (locked 0) | 887.6 | 32.7 | -4.3% | -0.5% | 2109 | 849 | 1260 | 0 |
| `dio` | measured (flag ignored before 0.54.0) | 1089.7 | 50.1 | +17.6% | +22.2% | 1435 | 1322 | 112 | 0 |

**gpu · `qwen3-1.7b-Q4_0`**

| mode | status | load ms (median) | ± σ | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | measured | 714.7 | 83.5 | — | +1.3% | 757 | 91 | 666 | 0 |
| `none` | measured | 755.2 | 69.2 | +5.7% | +7.0% | 514 | 91 | 422 | 0 |
| `mmap` | measured | 705.5 | 7 | -1.3% | — | 756 | 91 | 665 | 0 |
| `mlock` | measured (locked 0) | 756.6 | 22 | +5.9% | +7.2% | 513 | 91 | 422 | 0 |
| `mmap+mlock` | measured (locked 0) | 719.2 | 9 | +0.6% | +1.9% | 756 | 91 | 665 | 0 |
| `dio` | measured (flag ignored before 0.54.0) | 759.9 | 66.1 | +6.3% | +7.7% | 513 | 91 | 422 | 0 |

**gpu · `qwen3.5-0.8b-Q4_0`**

| mode | status | load ms (median) | ± σ | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | measured | 859 | 40.3 | — | +2.7% | 715 | 138 | 577 | 0 |
| `none` | measured | 943.3 | 39.2 | +9.8% | +12.7% | 516 | 138 | 378 | 0 |
| `mmap` | measured | 836.8 | 37.6 | -2.6% | — | 715 | 138 | 577 | 0 |
| `mlock` | measured (locked 0) | 915.4 | 22.3 | +6.6% | +9.4% | 517 | 139 | 378 | 0 |
| `mmap+mlock` | measured (locked 0) | 899.7 | 26.7 | +4.7% | +7.5% | 715 | 138 | 577 | 0 |
| `dio` | measured (flag ignored before 0.54.0) | 906.2 | 42.7 | +5.5% | +8.3% | 517 | 138 | 378 | 0 |

**gpu · `qwen3.5-2b-Q4_0`**

| mode | status | load ms (median) | ± σ | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | measured | 1004.6 | 40.9 | — | +0.2% | 1114 | 138 | 976 | 0 |
| `none` | measured | 1040.4 | 26.2 | +3.6% | +3.7% | 716 | 138 | 577 | 0 |
| `mmap` | measured | 1002.9 | 51.2 | -0.2% | — | 1113 | 138 | 975 | 0 |
| `mlock` | measured (locked 0) | 1025.5 | 18.9 | +2.1% | +2.3% | 716 | 139 | 577 | 0 |
| `mmap+mlock` | measured (locked 0) | 980.2 | 24.4 | -2.4% | -2.3% | 1113 | 139 | 974 | 0 |
| `dio` | measured (flag ignored before 0.54.0) | 1053.9 | 14.1 | +4.9% | +5.1% | 716 | 139 | 577 | 0 |

### linux-arm64

**cpu · `qwen3-1.7b-Q4_0`**

| mode | status | load ms (median) | ± σ | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | measured | 957.5 | 18.7 | — | -0.1% | 2266 | 1261 | 1005 | 0 |
| `none` | measured | 1136.5 | 10.3 | +18.7% | +18.6% | 1537 | 1527 | 10 | 0 |
| `mmap` | measured | 958.1 | 15.4 | +0.1% | — | 2266 | 1261 | 1005 | 0 |
| `mlock` | measured (locked 0) | 1131.4 | 4.8 | +18.2% | +18.1% | 1537 | 1527 | 10 | 0 |
| `mmap+mlock` | measured (locked 0) | 960.3 | 14.6 | +0.3% | +0.2% | 2266 | 1261 | 1005 | 0 |
| `dio` | measured (O_DIRECT) | 3489 | 309.8 | +264.4% | +264.2% | 1545 | 1535 | 10 | 0 |

**cpu · `qwen3.5-0.8b-Q4_0`**

| mode | status | load ms (median) | ± σ | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | measured | 1120.8 | 68.1 | — | +5.5% | 1089 | 606 | 483 | 0 |
| `none` | measured | 1266.2 | 71.3 | +13.0% | +19.1% | 823 | 814 | 10 | 0 |
| `mmap` | measured | 1062.7 | 50.8 | -5.2% | — | 1089 | 606 | 483 | 0 |
| `mlock` | measured (locked 0) | 1230.5 | 59.8 | +9.8% | +15.8% | 823 | 814 | 10 | 0 |
| `mmap+mlock` | measured (locked 0) | 1097.3 | 36.5 | -2.1% | +3.3% | 1089 | 606 | 483 | 0 |
| `dio` | measured (O_DIRECT) | 2298.2 | 276.3 | +105.0% | +116.3% | 831 | 822 | 10 | 0 |

**cpu · `qwen3.5-2b-Q4_0`**

| mode | status | load ms (median) | ± σ | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | measured | 1373 | 56.1 | — | -7.2% | 2423 | 1265 | 1158 | 0 |
| `none` | measured | 1716 | 64.9 | +25.0% | +16.0% | 1697 | 1687 | 10 | 0 |
| `mmap` | measured | 1479.4 | 97.5 | +7.7% | — | 2423 | 1265 | 1158 | 0 |
| `mlock` | measured (locked 0) | 1751.9 | 91.4 | +27.6% | +18.4% | 1697 | 1687 | 10 | 0 |
| `mmap+mlock` | measured (locked 0) | 1435.5 | 74.5 | +4.6% | -3.0% | 2423 | 1265 | 1158 | 0 |
| `dio` | measured (O_DIRECT) | 4577 | 328.6 | +233.4% | +209.4% | 1705 | 1695 | 10 | 0 |

**gpu · `qwen3-1.7b-Q4_0`**

| mode | status | load ms (median) | ± σ | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | ran on CPU — not a GPU result | 956.2 | 7.7 | — | — | 2266 | 1261 | 1005 | 0 |
| `none` | ran on CPU — not a GPU result | 1127.8 | 15.9 | — | — | 1537 | 1527 | 10 | 0 |
| `mmap` | ran on CPU — not a GPU result | 955.3 | 15 | — | — | 2266 | 1261 | 1005 | 0 |
| `mlock` | ran on CPU — not a GPU result | 1131.4 | 11 | — | — | 1537 | 1527 | 10 | 0 |
| `mmap+mlock` | ran on CPU — not a GPU result | 961 | 7.2 | — | — | 2266 | 1261 | 1005 | 0 |
| `dio` | ran on CPU — not a GPU result | 3467.5 | 256.5 | — | — | 1545 | 1535 | 10 | 0 |

**gpu · `qwen3.5-0.8b-Q4_0`**

| mode | status | load ms (median) | ± σ | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | ran on CPU — not a GPU result | 1115.8 | 84 | — | — | 1089 | 606 | 483 | 0 |
| `none` | ran on CPU — not a GPU result | 1199.5 | 51.3 | — | — | 823 | 814 | 10 | 0 |
| `mmap` | ran on CPU — not a GPU result | 1076.2 | 43.3 | — | — | 1089 | 606 | 483 | 0 |
| `mlock` | ran on CPU — not a GPU result | 1229.9 | 35.8 | — | — | 823 | 814 | 10 | 0 |
| `mmap+mlock` | ran on CPU — not a GPU result | 1110.5 | 59.7 | — | — | 1089 | 606 | 483 | 0 |
| `dio` | ran on CPU — not a GPU result | 2388 | 354.5 | — | — | 831 | 822 | 10 | 0 |

**gpu · `qwen3.5-2b-Q4_0`**

| mode | status | load ms (median) | ± σ | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | ran on CPU — not a GPU result | 1388.4 | 27.9 | — | — | 2423 | 1265 | 1158 | 0 |
| `none` | ran on CPU — not a GPU result | 1685.6 | 29.3 | — | — | 1697 | 1687 | 10 | 0 |
| `mmap` | ran on CPU — not a GPU result | 1375.1 | 28.7 | — | — | 2423 | 1265 | 1158 | 0 |
| `mlock` | ran on CPU — not a GPU result | 1661 | 29.3 | — | — | 1697 | 1687 | 10 | 0 |
| `mmap+mlock` | ran on CPU — not a GPU result | 1390.5 | 98.3 | — | — | 2423 | 1265 | 1158 | 0 |
| `dio` | ran on CPU — not a GPU result | 4692.8 | 119.4 | — | — | 1705 | 1695 | 10 | 0 |

### win32-x64

**cpu · `qwen3-1.7b-Q4_0`**

| mode | status | load ms (median) | ± σ | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | measured | 961.8 | 57.9 | — | +0.6% | 1812 | — | — | — |
| `none` | measured | 907.4 | 11.3 | -5.7% | -5.1% | 1342 | — | — | — |
| `mmap` | measured | 956.1 | 68.8 | -0.6% | — | 1812 | — | — | — |
| `mlock` | measured (lock unverified) | 930.8 | 12.8 | -3.2% | -2.6% | 1342 | — | — | — |
| `mmap+mlock` | measured (lock unverified) | 1185.4 | 18.3 | +23.2% | +24.0% | 1948 | — | — | — |
| `dio` | measured (flag ignored before 0.54.0) | 886.9 | 4.5 | -7.8% | -7.2% | 1342 | — | — | — |

**cpu · `qwen3.5-0.8b-Q4_0`**

| mode | status | load ms (median) | ± σ | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | measured | 968.9 | 20.2 | — | -1.4% | 687 | — | — | — |
| `none` | measured | 989.7 | 13.3 | +2.1% | +0.7% | 679 | — | — | — |
| `mmap` | measured | 982.7 | 22 | +1.4% | — | 687 | — | — | — |
| `mlock` | measured (lock unverified) | 1016.9 | 31.1 | +5.0% | +3.5% | 679 | — | — | — |
| `mmap+mlock` | measured (lock unverified) | 1120.6 | 19.6 | +15.7% | +14.0% | 756 | — | — | — |
| `dio` | measured (flag ignored before 0.54.0) | 981 | 6.9 | +1.2% | -0.2% | 679 | — | — | — |

**cpu · `qwen3.5-2b-Q4_0`**

| mode | status | load ms (median) | ± σ | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | measured | 1265.3 | 51.1 | — | -4.8% | 1556 | — | — | — |
| `none` | measured | 1194.6 | 76 | -5.6% | -10.2% | 1354 | — | — | — |
| `mmap` | measured | 1329.7 | 128 | +5.1% | — | 1556 | — | — | — |
| `mlock` | measured (lock unverified) | 1366.4 | 88.7 | +8.0% | +2.8% | 1354 | — | — | — |
| `mmap+mlock` | measured (lock unverified) | 1569.1 | 132.3 | +24.0% | +18.0% | 1866 | — | — | — |
| `dio` | measured (flag ignored before 0.54.0) | 1253.1 | 101 | -1.0% | -5.8% | 1354 | — | — | — |

**gpu · `qwen3-1.7b-Q4_0`**

| mode | status | load ms (median) | ± σ | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | measured | 1512.1 | 42.9 | — | +0.1% | 1474 | — | — | — |
| `none` | measured | 1507.5 | 39.3 | -0.3% | -0.2% | 472 | — | — | — |
| `mmap` | measured | 1511 | 25.7 | -0.1% | — | 1474 | — | — | — |
| `mlock` | measured (lock unverified) | 1496.6 | 19.3 | -1.0% | -1.0% | 402 | — | — | — |
| `mmap+mlock` | measured (lock unverified) | 1503 | 13.3 | -0.6% | -0.5% | 1480 | — | — | — |
| `dio` | measured (flag ignored before 0.54.0) | 1514.5 | 15.4 | +0.2% | +0.2% | 472 | — | — | — |

**gpu · `qwen3.5-0.8b-Q4_0`**

| mode | status | load ms (median) | ± σ | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | measured | 1200.6 | 22.4 | — | -0.2% | 917 | — | — | — |
| `none` | measured | 1177.3 | 16.3 | -1.9% | -2.2% | 443 | — | — | — |
| `mmap` | measured | 1203.4 | 15.2 | +0.2% | — | 916 | — | — | — |
| `mlock` | measured (lock unverified) | 1242.8 | 4.2 | +3.5% | +3.3% | 365 | — | — | — |
| `mmap+mlock` | measured (lock unverified) | 1237 | 16.1 | +3.0% | +2.8% | 893 | — | — | — |
| `dio` | measured (flag ignored before 0.54.0) | 1170.1 | 9.3 | -2.5% | -2.8% | 443 | — | — | — |

**gpu · `qwen3.5-2b-Q4_0`**

| mode | status | load ms (median) | ± σ | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | measured | 1631.7 | 144.2 | — | -1.6% | 1822 | — | — | — |
| `none` | measured | 1645.6 | 118.6 | +0.9% | -0.7% | 672 | — | — | — |
| `mmap` | measured | 1658 | 116 | +1.6% | — | 1823 | — | — | — |
| `mlock` | measured (lock unverified) | 1667.5 | 126.7 | +2.2% | +0.6% | 597 | — | — | — |
| `mmap+mlock` | measured (lock unverified) | 1660.5 | 49 | +1.8% | +0.2% | 1833 | — | — | — |
| `dio` | measured (flag ignored before 0.54.0) | 1646.8 | 18.7 | +0.9% | -0.7% | 674 | — | — | — |

### darwin-x64

**cpu · `qwen3-1.7b-Q4_0`**

| mode | status | load ms (median) | ± σ | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | measured | 1478.1 | 74.7 | — | +0.5% | 2055 | — | — | — |
| `none` | measured | 1568 | 145.1 | +6.1% | +6.6% | 1335 | — | — | — |
| `mmap` | measured | 1471.3 | 32.8 | -0.5% | — | 2055 | — | — | — |
| `mlock` | measured (lock unverified) | 1535.7 | 162.9 | +3.9% | +4.4% | 1335 | — | — | — |
| `mmap+mlock` | measured (lock unverified) | 1491.9 | 21.8 | +0.9% | +1.4% | 2055 | — | — | — |
| `dio` | measured (flag ignored on this OS) | 1584.2 | 28.2 | +7.2% | +7.7% | 1335 | — | — | — |

**cpu · `qwen3.5-0.8b-Q4_0`**

| mode | status | load ms (median) | ± σ | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | measured | 1814.9 | 235.5 | — | -1.4% | 916 | — | — | — |
| `none` | measured | 1906 | 18.4 | +5.0% | +3.6% | 672 | — | — | — |
| `mmap` | measured | 1840.5 | 29.3 | +1.4% | — | 919 | — | — | — |
| `mlock` | measured (lock unverified) | 1876.2 | 18.9 | +3.4% | +1.9% | 672 | — | — | — |
| `mmap+mlock` | measured (lock unverified) | 1847.2 | 41.2 | +1.8% | +0.4% | 916 | — | — | — |
| `dio` | measured (flag ignored on this OS) | 1894.3 | 42 | +4.4% | +2.9% | 672 | — | — | — |

**cpu · `qwen3.5-2b-Q4_0`**

| mode | status | load ms (median) | ± σ | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | measured | 2162.6 | 1064.7 | — | +0.4% | 2028 | — | — | — |
| `none` | measured | 2357.9 | 61.3 | +9.0% | +9.5% | 1351 | — | — | — |
| `mmap` | measured | 2153.2 | 5.8 | -0.4% | — | 2028 | — | — | — |
| `mlock` | measured (lock unverified) | 2391.7 | 83.7 | +10.6% | +11.1% | 1351 | — | — | — |
| `mmap+mlock` | measured (lock unverified) | 2247.6 | 18.4 | +3.9% | +4.4% | 2028 | — | — | — |
| `dio` | measured (flag ignored on this OS) | 2381.6 | 55 | +10.1% | +10.6% | 1353 | — | — | — |

**gpu · `qwen3-1.7b-Q4_0`**

| mode | status | load ms (median) | ± σ | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | measured | 3103.7 | 106.2 | — | +0.7% | 1102 | — | — | — |
| `none` | measured | 49543 | 5578 | +1496.3% | +1508.0% | 345 | — | — | — |
| `mmap` | measured | 3081 | 80.3 | -0.7% | — | 1103 | — | — | — |
| `mlock` | measured (lock unverified) | 49322.2 | 1056 | +1489.1% | +1500.9% | 345 | — | — | — |
| `mmap+mlock` | measured (lock unverified) | 3133.3 | 57.2 | +1.0% | +1.7% | 1103 | — | — | — |
| `dio` | measured (flag ignored on this OS) | 49130 | 1085.5 | +1482.9% | +1494.6% | 345 | — | — | — |

**gpu · `qwen3.5-0.8b-Q4_0`**

| mode | status | load ms (median) | ± σ | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | measured | 1839.5 | 38.8 | — | +0.0% | 635 | — | — | — |
| `none` | measured | 12646.1 | 58 | +587.5% | +587.6% | 357 | — | — | — |
| `mmap` | measured | 1839.2 | 55 | -0.0% | — | 635 | — | — | — |
| `mlock` | measured (lock unverified) | 12864.9 | 244.1 | +599.4% | +599.5% | 357 | — | — | — |
| `mmap+mlock` | measured (lock unverified) | 1892.4 | 65 | +2.9% | +2.9% | 633 | — | — | — |
| `dio` | measured (flag ignored on this OS) | 12737.7 | 161.3 | +592.5% | +592.6% | 359 | — | — | — |

**gpu · `qwen3.5-2b-Q4_0`**

| mode | status | load ms (median) | ± σ | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | measured | 2014.2 | 46.7 | — | +1.9% | 1301 | — | — | — |
| `none` | measured | 57003.9 | 953.9 | +2730.1% | +2784.2% | 560 | — | — | — |
| `mmap` | measured | 1976.4 | 47.1 | -1.9% | — | 1308 | — | — | — |
| `mlock` | measured (lock unverified) | 56323.4 | 772.9 | +2696.3% | +2749.8% | 558 | — | — | — |
| `mmap+mlock` | measured (lock unverified) | 2053.2 | 53.7 | +1.9% | +3.9% | 1308 | — | — | — |
| `dio` | measured (flag ignored on this OS) | 57141.2 | 789 | +2736.9% | +2791.2% | 553 | — | — | — |

### Android

**Google Pixel 9 Pro · cpu** (one load per cell)

| mode | backend | status | load ms | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|---------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | cpu | measured | 1506 | — | -1.6% | 1073 | 567 | 505 | 0 |
| `none` | cpu | measured | 1620 | +7.6% | +5.9% | 836 | 810 | 25 | 0 |
| `mmap` | cpu | measured | 1530 | +1.6% | — | 1103 | 597 | 506 | 0 |
| `mlock` | cpu | measured (locked 0) | 1595 | +5.9% | +4.2% | 859 | 826 | 33 | 0 |
| `mmap+mlock` | cpu | measured (locked 0) | 1456 | -3.3% | -4.8% | 1123 | 617 | 506 | 0 |
| `dio` | cpu | measured (O_DIRECT) | 4584 | +204.4% | +199.6% | 837 | 811 | 25 | 0 |

**Samsung Galaxy S25 Ultra · cpu** (one load per cell)

| mode | backend | status | load ms | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|---------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | cpu | measured | 948 | — | +3.6% | 1132 | 622 | 510 | 0 |
| `none` | cpu | measured | 1002 | +5.7% | +9.5% | 866 | 829 | 36 | 0 |
| `mmap` | cpu | measured | 915 | -3.5% | — | 1110 | 606 | 503 | 0 |
| `mlock` | cpu | measured (locked 0) | 1006 | +6.1% | +9.9% | 866 | 829 | 36 | 0 |
| `mmap+mlock` | cpu | measured (locked 0) | 949 | +0.1% | +3.7% | 1132 | 623 | 510 | 0 |
| `dio` | cpu | measured (O_DIRECT) | 1186 | +25.1% | +29.6% | 875 | 837 | 38 | 0 |

**Samsung Galaxy S26 Ultra · cpu** (one load per cell)

| mode | backend | status | load ms | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|---------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | cpu | measured | 785 | — | +1.4% | 1096 | 586 | 510 | 0 |
| `none` | cpu | measured | 865 | +10.2% | +11.8% | 850 | 814 | 37 | 0 |
| `mmap` | cpu | measured | 774 | -1.4% | — | 1096 | 586 | 510 | 0 |
| `mlock` | cpu | measured (locked 0) | 871 | +11.0% | +12.5% | 866 | 830 | 36 | 0 |
| `mmap+mlock` | cpu | measured (locked 0) | 918 | +16.9% | +18.6% | 1132 | 622 | 509 | 0 |
| `dio` | cpu | measured (O_DIRECT) | 1127 | +43.6% | +45.6% | 840 | 804 | 36 | 0 |

**Google Pixel 9 Pro · gpu** (one load per cell)

| mode | backend | status | load ms | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|---------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | vulkan | measured | 1473 | — | +0.3% | 1362 | 82 | 1280 | 0 |
| `none` | vulkan | measured | 1593 | +8.1% | +8.5% | 1380 | 93 | 1288 | 0 |
| `mmap` | vulkan | measured | 1468 | -0.3% | — | 1353 | 74 | 1279 | 0 |
| `mlock` | vulkan | measured (locked 0) | 1476 | +0.2% | +0.5% | 1407 | 114 | 1292 | 0 |
| `mmap+mlock` | vulkan | measured (locked 0) | 1352 | -8.2% | -7.9% | 1404 | 114 | 1290 | 0 |
| `dio` | vulkan | measured (O_DIRECT) | 1457 | -1.1% | -0.7% | 1512 | 98 | 1414 | 0 |

**Samsung Galaxy S25 Ultra · gpu** (one load per cell)

| mode | backend | status | load ms | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|---------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | vulkan | measured | 11071 | — | -12.0% | 363 | 313 | 42 | 0 |
| `none` | vulkan | measured | 11104 | +0.3% | -11.7% | 364 | 314 | 43 | 0 |
| `mmap` | vulkan | measured | 12575 | +13.6% | — | 366 | 116 | 242 | 0 |
| `mlock` | vulkan | measured (locked 0) | 11021 | -0.5% | -12.4% | 364 | 313 | 43 | 0 |
| `mmap+mlock` | vulkan | measured (locked 0) | 10880 | -1.7% | -13.5% | 366 | 117 | 241 | 0 |
| `dio` | vulkan | measured (O_DIRECT) | 11132 | +0.6% | -11.5% | 374 | 324 | 43 | 0 |

**Samsung Galaxy S26 Ultra · gpu** (one load per cell)

| mode | backend | status | load ms | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|---------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | vulkan | measured | 8994 | — | +0.6% | 344 | 295 | 49 | 0 |
| `none` | vulkan | measured | 9006 | +0.1% | +0.7% | 345 | 297 | 49 | 0 |
| `mmap` | vulkan | measured | 8939 | -0.6% | — | 338 | 94 | 244 | 0 |
| `mlock` | vulkan | measured (locked 0) | 9040 | +0.5% | +1.1% | 328 | 298 | 30 | 0 |
| `mmap+mlock` | vulkan | measured (locked 0) | 8778 | -2.4% | -1.8% | 136 | -111 | 248 | 0 |
| `dio` | vulkan | measured (O_DIRECT) | 9074 | +0.9% | +1.5% | 276 | 228 | 48 | 0 |

### iOS

**Apple iPhone 16 · cpu** (one load per cell)

| mode | backend | status | load ms | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|---------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | cpu | measured | 10668 | — | +4.7% | 648 | — | — | — |
| `none` | cpu | measured | 10605 | -0.6% | +4.0% | 648 | — | — | — |
| `mmap` | cpu | measured | 10193 | -4.5% | — | 648 | — | — | — |
| `mlock` | cpu | measured (lock unverified) | 10402 | -2.5% | +2.1% | 649 | — | — | — |
| `mmap+mlock` | cpu | measured (lock unverified) | 10284 | -3.6% | +0.9% | 648 | — | — | — |
| `dio` | cpu | measured (flag ignored on this OS) | 10684 | +0.1% | +4.8% | 648 | — | — | — |

**Apple iPhone 17 · cpu** (one load per cell)

| mode | backend | status | load ms | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|---------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | cpu | measured | 9599 | — | -1.0% | 656 | — | — | — |
| `none` | cpu | measured | 9755 | +1.6% | +0.6% | 618 | — | — | — |
| `mmap` | cpu | measured | 9697 | +1.0% | — | 656 | — | — | — |
| `mlock` | cpu | measured (lock unverified) | 9881 | +2.9% | +1.9% | 658 | — | — | — |
| `mmap+mlock` | cpu | measured (lock unverified) | 9025 | -6.0% | -6.9% | 657 | — | — | — |
| `dio` | cpu | measured (flag ignored on this OS) | 9261 | -3.5% | -4.5% | 612 | — | — | — |

**Apple iPhone 16 · gpu** (one load per cell)

| mode | backend | status | load ms | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|---------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | metal | measured | 10622 | — | -1.4% | 648 | — | — | — |
| `none` | metal | measured | 10930 | +2.9% | +1.5% | 982 | — | — | — |
| `mmap` | metal | measured | 10768 | +1.4% | — | 648 | — | — | — |
| `mlock` | metal | measured (lock unverified) | 11257 | +6.0% | +4.5% | 988 | — | — | — |
| `mmap+mlock` | metal | measured (lock unverified) | 10389 | -2.2% | -3.5% | 648 | — | — | — |
| `dio` | metal | measured (flag ignored on this OS) | 11301 | +6.4% | +4.9% | 981 | — | — | — |

**Apple iPhone 17 · gpu** (one load per cell)

| mode | backend | status | load ms | Δ vs `auto` | Δ vs `mmap` | rss | anon | file | locked |
|------|---------|--------|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| `auto` | metal | measured | 9170 | — | -1.5% | 609 | — | — | — |
| `none` | metal | measured | 9931 | +8.3% | +6.6% | 1006 | — | — | — |
| `mmap` | metal | measured | 9314 | +1.6% | — | 618 | — | — | — |
| `mlock` | metal | measured (lock unverified) | 9799 | +6.9% | +5.2% | 1016 | — | — | — |
| `mmap+mlock` | metal | measured (lock unverified) | 9238 | +0.7% | -0.8% | 623 | — | — | — |
| `dio` | metal | measured (flag ignored on this OS) | 9932 | +8.3% | +6.6% | 989 | — | — | — |

## Mode notes

### `dio`

What `dio` does depends on the fabric version and the platform.

- **Before `0.54.0`** (qvac-fabric `v10549.1.0`) it did nothing anywhere:
  `llama-model-load.cpp` built `llama_file_disk(fname, "rb")` and dropped the
  `use_direct_io` argument, so `dio` loaded exactly as `none`. The developer-host
  tables below and the `0.53.2` CI rows show that — `dio` matches `none` on every
  counter.
- **From `0.54.0`** (qvac-fabric `v10549.3.0`) the argument reaches the file
  open, and `llama-mmap.cpp` opens the model with `O_RDONLY | O_DIRECT` under
  `#ifdef __linux__`. On Linux and Android `dio` now bypasses the page cache; on
  Windows, macOS and iOS the flag is still unused and `dio` is `none`.

Bypassing the page cache is not a speed-up for a warm load, which is what every
figure here is (§"Method"). On linux-arm64 CPU `dio` loaded 1.8–3.1× slower than
`none` — 3489 against 1137 ms on Qwen3-1.7B, five tight samples each — where on
`0.53.2` the two were identical. Android CPU shows 1.2–2.8×. On Android GPU it is
level with `none`, since the weights are uploaded to device memory either way.
Its memory figures track `none`.

Each `dio` row in the tables is labelled with which case applies, and `dio` is
measured and ranked like every other mode: a fixed "inert" label would be wrong
on one side of the version boundary or the other.

### `mlock` locks nothing on a GPU load; `mmap+mlock` does

On the developer host (§"Developer host") `locked` reads 0 MiB for `mlock` on all three GPU device
selections, while `mmap+mlock` locks 198.9 MiB on every one of them. `mlock`
takes the anonymous path and locks host buffers only; with the weights in
device memory there is nothing host-resident left to lock, so its timing and
residency match `none` exactly. `mmap+mlock` locks the mapped file, which stays
host-resident whatever the backend. On a CPU-backend load `mlock` does lock
(231 MiB measured on Llama-3.2-1B-Q4_0).

Locking fails silently: llama.cpp warns and continues when the lock exceeds
`RLIMIT_MEMLOCK`. `ulimit -l` on this host is 7.8 GB. On the CI runners both
locking modes read `locked = 0` on every load, CPU included — consistent with a
stock limit, not with the modes — so the CI tables below cannot say whether
either mode locks when it is allowed to. An Android device will not lock
either, and will not raise an error saying so. The `locked` column is how you
tell, and where there is no `/proc` (Windows, macOS, iOS) there is no such
column: those rows are recorded as "lock unverified", never as 0.

## Reading the memory columns

**`rss` alone ranks the modes wrongly, and which column is decisive depends on
the backend.** Both facts are measured, not theoretical:

- On the **CPU** backend, a mapped load reads *higher* total rss than an
  anonymous one (1484 vs 978 MiB on Llama-3.2-1B-Q4_0) while costing *less*
  anonymous memory (626 vs 857 MiB). The mapped weights are file-backed and
  evictable; the anonymous figure is what the system must actually find. Total
  rss ranks `mmap` worst on exactly the number that matters least.
- On a **GPU** backend, `anon` is flat across all six modes (119-134 MiB) and
  **`file`** carries the whole difference.

- On **Windows** there is no `anon`/`file` split: `rss` is the working set,
  and `llama_mmap` prefetches with `PrefetchVirtualMemory`, which fills the
  standby list without faulting pages into the working set. Windows `rss`
  figures are comparable across modes on Windows only as totals, and not with
  the other platforms. macOS and iOS likewise report `rss` only.

So all three are recorded and none is collapsed into a single "memory" number.
`anon`/`file` come from `/proc/self/status` and are `null` — recorded as
absent, not as zero — on platforms without `/proc`. `rss` is
`bare-os`'s `memoryUsage().rss`, the same counter
`model-fit`'s calibration harness and `asr-ggml`'s `memory-usage.js` use, so
figures stay comparable across packages.

## Developer host: linux-x64 with integrated and discrete GPUs

Host: Intel Core Ultra (Arrow Lake) with **both** an Intel iGPU (`uma: 1`) and
an RTX 5080 Laptop (`uma: 0`) — so one machine measures both sides of `auto`'s
decision. Model: Qwen3.5-0.8B-Q4_0. Addon `@qvac/llm-llamacpp@0.53.2`, fabric
`0.16.1`. One unmeasured warm-up per model, then 5 samples per cell, each in
its own process, with modes rotated between repetitions. All samples are
warm-cache; memory is the mean delta across them.

Figures are **medians of 5 samples**, each sample its own process, modes
rotated within a device group, each device group run as its own pass. Medians
rather than means because the integrated GPU shows an intermittent stall — see
"measurement artifacts" below. Memory is the mean delta; it was stable across
every run.

### Device selection left to the engine (`device: gpu`, no `main-gpu`)

| mode | status | load ms (median) | mean ± σ | Δ vs `auto` | rss | anon | file | locked |
|------|--------|------------------|----------|-------------|-----|------|------|--------|
| `auto` | measured | **774.4** | 777.1 ± 14.5 | — | 489.6 | 130.5 | 359.5 | 0 |
| `mmap` | measured | 781.3 | 793.7 ± 47.3 | +0.9% | 489.5 | 130.5 | 359.5 | 0 |
| `mmap+mlock` | measured | 782.4 | 817.6 ± 73.3 | +1.0% | 491.0 | 132.2 | 359.4 | 198.9 |
| `dio` | ignored (`0.53.2`) | 1903.0 | 1903.6 ± 22.4 | +146% | 325.5 | 132.4 | 193.6 | 0 |
| `none` | measured | 1918.7 | 1944.1 ± 73.5 | **+148%** | 322.4 | 129.0 | 193.6 | 0 |
| `mlock` | measured | 1928.7 | 1935.4 ± 71.6 | +149% | 323.6 | 130.7 | 193.5 | 0 |

`auto`, `mmap` and `mmap+mlock` are tied within their spread.

### Discrete GPU pinned (`main-gpu: dedicated`, RTX 5080)

| mode | status | load ms (median) | mean ± σ | Δ vs `auto` | rss | anon | file | locked |
|------|--------|------------------|----------|-------------|-----|------|------|--------|
| `auto` | measured | **763.8** | 776.6 ± 32.3 | — | 486.5 | 127.2 | 359.7 | 0 |
| `mmap` | measured | 770.1 | 784.3 ± 24.5 | +0.8% | 491.7 | 132.2 | 359.7 | 0 |
| `mmap+mlock` | measured | 772.4 | 790.7 ± 43.7 | +1.1% | 488.3 | 128.9 | 359.7 | 198.9 |
| `mlock` | measured | 1857.5 | 1878.9 ± 92.0 | **+143%** | 324.1 | 130.7 | 193.9 | 0 |
| `none` | measured | 1865.3 | 1861.6 ± 38.4 | +144% | 324.3 | 130.7 | 194.0 | 0 |
| `dio` | ignored (`0.53.2`) | 1875.0 | 1900.6 ± 73.3 | +145% | 324.3 | 130.7 | 193.9 | 0 |

### Integrated GPU pinned (`main-gpu: integrated`, Intel ARL)

| mode | status | load ms (median) | mean ± σ | Δ vs `auto` | rss | anon | file | locked |
|------|--------|------------------|----------|-------------|-----|------|------|--------|
| `mmap+mlock` | measured | **713.3** | 714.3 ± 6.6 | −11.7% | 452.9 | 119.4 | 333.9 | 198.9 |
| `mmap` | measured | 738.2 | 743.7 ± 34.6 | −8.7% | 452.8 | 119.4 | 333.8 | 0 |
| `mlock` | measured | 779.2 | 927.5 ± 322.7 ⚠ | −3.6% | 255.2 | 119.9 | 135.4 | 0 |
| `none` | measured | 786.8 | 937.0 ± 340.6 ⚠ | −2.7% | 254.7 | 119.7 | 135.4 | 0 |
| `dio` | ignored (`0.53.2`) | 806.0 | 828.8 ± 68.6 | −0.3% | 254.7 | 119.8 | 135.2 | 0 |
| `auto` | measured | 808.3 | 1026.6 ± 342.5 ⚠ | — | **255.0** | 119.8 | 135.4 | 0 |

⚠ = at least one stalled sample; read the median.

### Measurement artifacts, and what each one cost

Four confounds were found, each by re-measuring rather than by reasoning, and
each produced numbers that looked like results. For a load-time metric almost
every confound is positional, which is why this could not simply reuse the
throughput suite's method: that suite measures a warmed, resident model in
steady state and is immune to all of them.

| Artifact | What it did | Fix |
|----------|-------------|-----|
| Shared process | `unload()` retains 135–194 MiB, so each later cell's baseline was raised. Five modes read +369/+215/+34/+0.01/−0.4 MiB purely by order | one process per sample |
| Back-to-back repeats | repeats 2–3 inherited an identical load's driver state; the integrated anonymous modes read a tight, wrong ~810 ms ± 15 | rotate modes between repetitions |
| Cross-device interleaving | putting discrete-GPU cells between integrated samples blew those rows out to ~1100 ms ± 500 | one pass per device group |
| Intermittent stall | a multi-hundred-ms stall hits ~1 sample in 3 on the integrated anonymous path, moving between modes run to run | report medians, print every sample, flag mean > 1.15 × median |

The stall is **not** understood and is not a property of any mode — it moved
between `auto`, `none`, `mlock` and `dio` across four runs while their memory
figures stayed identical. It may be the Intel driver, contention with the
discrete card's driver, or the engine; isolating it needs a quiet
single-GPU host and is out of scope here. It is recorded because anyone
shipping to integrated-GPU hosts would want to know, and because it is why this
section quotes medians.

### What the developer host shows

**`auto` selects the right path on every device selection measured.** Its
memory and file-residency figures match `mmap` exactly on the unpinned and
discrete cases (358 MiB file) and match `none` exactly on the integrated one
(136 MiB file). The heuristic fires where it should and nowhere else.

**On a discrete GPU the mapped path is worth ~2.4× the load time.** Every
anonymous mode costs ~1.86–1.93 s against ~0.76–0.78 s mapped, tight on both
sides. `auto` maps there, which is clearly right: ~165 MiB of resident memory is
not worth an extra 1.1 s of load on a host with its own VRAM.

**On an integrated GPU `auto` buys ~198 MiB of system RAM for about 9% of load
time.** Mapped residency is 453 MiB against 255 MiB anonymous, and `auto` takes
the 255 MiB at a median 808 ms against `mmap`'s 738 ms — ~70 ms. A cheap trade,
and the right one: an integrated GPU allocates out of the system RAM it
competes for with everything else on the machine, which is exactly the
condition upstream's `mmap_support = false` flag encodes.

**No flat per-platform default beats `auto` on linux-x64.** A flat `mmap` would
spend 198 MiB on integrated hosts to save ~70 ms; a flat `none` would spend
~145% of load time on discrete ones to save ~165 MiB. Both trades are bad, and
they point in opposite directions on two devices inside the same machine — so
the choice cannot be a platform constant. Nothing here argues for changing the
default.

**`mmap+mlock` is the fastest mode in all three groups** — 770/788/734 ms,
marginally ahead of plain `mmap` each time. The margin is inside or close to the
samples' spread in the unpinned and discrete cases, so it should not be read as
a recommendation; it is reported because an absent row is not the same as a
measured tie.

## Desktop and mobile do not measure to the same precision

Desktop takes five samples per cell, each in its own process, and reports a
median. **Mobile takes one.** A Device Farm shard loads the model once and
runs its generations against that load, so `load_ms` is a single sample
repeated across the cell's rows — there is no spread to report and no median
to protect against an outlier.

That follows from how the mobile harness is built: a shard loads once and
reuses that load for its generations, and shards run against the 20-minute iOS
per-test ceiling. Adding repeated loads would mean reworking the shard, which
this task did not do.

The consequence is that **no mobile load-time margin here is backed by a
spread**, so this document states mobile load times as observed values and
draws no timing verdict from them. The consolidated GitHub report names no
fastest mode on either platform — it keeps one figure per cell and cannot show
the uncertainty a ranking needs — so any interpretation is made here, against
the standalone sweep artifact, which carries the samples and their spread. The
memory figures do not have this problem: they are a property of the load
rather than a timing, and the mapped-versus-anonymous gap is hundreds of MiB.
The mobile verdicts therefore rest on residency where it differs, and treat
load-time gaps inside a few percent as ties.

## Method, and why each measurement is its own process

Every cell is measured in a fresh process. This is load-bearing, not hygiene:

- **`unload()` does not return everything.** On the Vulkan backend it leaves
  135-194 MiB of file-backed residency permanently resident (the
  `retainedAfterUnload` field in the JSONL). The baseline therefore shifts
  after the first load and never returns, so every later delta in the same
  process reads short. The same mode measured three times in one process gave
  +373, +209, +209 MiB.
- **The page cache carries across modes.** Sequential loads in one process ran
  756, 439, 437 ms for the same mode — whichever mode is measured first pays
  for the others.

Measured in sequence inside one process, five modes read +369 / +215 / +34 /
+0.01 / −0.4 MiB, entirely by load order. The same five, one process each, read
+383 / +384 / +203 / +203 / +203 MiB. Any harness that measures load in a
shared process is measuring position, not mode.

**No cold-load figure is reported, because none is measured.** A fresh process
resets process state, not the OS page cache: after the first read of a model
file every later process inherits a warm cache. Calling each cell's first
sample "cold" would report load ordering as a property of the mode. Instead one
unmeasured warm-up per model puts every cell on the same warm footing, and
modes are rotated between repetitions so thermal drift and ordering spread
across modes rather than landing on whichever ran first. A genuine cold-load
comparison would need the page cache dropped between samples, which needs root
and is unavailable on Device Farm; it is not something this ticket asks for.

Each row also records `backendDevice` from one minimal inference taken after
the memory sample. An explicit `main-gpu` naming a device class the host lacks
falls back to the CPU silently, so a row whose backend disagrees with its
requested device is a mislabelled measurement; the renderer flags those rather
than reporting them.

## Reproducing

```
cd packages/llm-llamacpp/benchmarks/performance
node prepare-models.js --target addon --models qwen3.5-0.8b
node load-mode-sweep.js --models qwen3.5-0.8b --load-mode-quantizations Q4_0
```

Every axis narrows from the command line, so a run needs no code edit:
`--load-mode`, `--load-mode-quantizations`, `--load-mode-main-gpu` (`none`
means "do not pin"), `--load-mode-device`, `--load-mode-ctx-size`,
`--load-repeats`, `--addon-source` (`local` or `npm`), `--results-dir`.

Results are written to `results/load-mode/` as a JSONL file (one record per
cell, every sample) and a perf-report JSON that `render-report.js` turns into
the load-mode tables of the run's consolidated report. The sweep renders no
Markdown of its own.

## Coverage

| Platform | Devices | Every mode measured or explained? | Notes |
|----------|---------|-----------------------------------|-------|
| linux-x64 | CPU, GPU | yes | `0.53.2`; developer host adds integrated and discrete GPUs on one machine |
| linux-arm64 | CPU; GPU requested | yes | no GPU on the runner: all 18 GPU requests ran on the CPU and are recorded as not comparable |
| win32-x64 | CPU, GPU | yes | `0.53.2`; `0.54.0` cannot load on Windows (§"Versions measured"). No private/file split, so memory is `rss` only |
| darwin-x64 | CPU, GPU | yes | GPU is Apple Paravirtual Metal on a VM; backend confirmed on every row |
| darwin-arm64 | — | not run | not in the task's platform list; available as a `desktop_platforms` value |
| Android | CPU, GPU on Pixel 9 Pro, Galaxy S25 Ultra, Galaxy S26 Ultra | yes | one load per cell; `anon`/`file`/`locked` from `/proc` |
| iOS | CPU, GPU on iPhone 16, iPhone 17 | yes | one load per cell; `rss` only |

Run it with `sweep_params=load-mode,device=cpu|gpu` on **Benchmark
Performance — LLM Parameter Sweep**, with `desktop_platforms` set to the
platforms wanted: both devices on every platform, 12 mobile shards instead of
86, and no six-hour grid. A GPU request on a host without one is reported as a
backend mismatch rather than silently measured on the CPU.

Mobile runs build the test app from the shared mobile test framework, which
resolves its `bare-*` dependencies at build time. A `bare-*` release that needs
a newer Bare runtime than the framework embeds breaks every Android run before
any test body executes — every shard fails with `ADDON_NOT_FOUND` from
`bare-type/binding.js`. That is a harness failure, not a result for any mode,
and it must not be recorded as one.
