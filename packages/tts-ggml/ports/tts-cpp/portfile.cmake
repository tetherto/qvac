# tts-cpp -- PACKAGE-LOCAL OVERLAY PORT (release line 0.6.x).
#
# Copy of qvac-registry-vcpkg ports/tts-cpp, re-pinned at the
# qvac-ext-lib-whisper.cpp master commit carrying PR #121 (CosyVoice3 + Parler
# iOS memory-peak fix). Build options are identical to the registry port; only
# REF / SHA512 differ. It exists because 0.6.3 ships that one fix on top of
# 0.6.2: the registry has not published this pin yet, and reaching it through a
# baseline bump would also drag qvac-lib-inference-addon-cpp, qvac-lint-cpp and
# ggml-speech forward, which this release must not do. The ggml-speech floor
# below stays at the 2026-08-03 that 0.6.2 already resolves, so the tts-cpp
# source pin is the only thing this release changes.
#
# Remove this overlay (and the `overlay-ports` entry in
# vcpkg-configuration.json) once the registry publishes the pin and the addon
# consumes it through vcpkg.json.
#
# tts-cpp: Resemble Chatterbox + Supertonic + CosyVoice3 + Parler-TTS in pure
# C++/ggml. Sourced from the engines/tts subfolder of qvac-ext-lib-whisper.cpp;
# consumes the ggml-speech port.
#
# [TTS GGML] CosyVoice3 + Parler iOS memory-peak fix
# (qvac-ext-lib-whisper.cpp PR #121): both engines loaded weights into dirty ggml
# backend buffers (no mmap) -- dirty anon RAM iOS jetsam counts against the app
# memory limit -- so the CPU model loads OOM-killed on non-entitled Device Farm
# iPhones (crashed:true). Numerically identical output.
#   CosyVoice3: (1) map-in-place -- mmap the GGUF and back each CPU/host weight
#   tensor with its mapped pointer via ggml_backend_cpu_buffer_from_ptr (bounds +
#   32B-align guarded, alloc+upload fallback), so weights are clean, file-backed,
#   evictable pages; (2) sequential lazy stage loading -- create() reads
#   voice.gguf (then frees it) + the tokenizer, and run() loads llm -> free ->
#   flow -> free -> hift -> free one at a time, dropping peak resident weight
#   memory from the ~2.4 GB sum to the largest single stage (flow ~1.3 GB).
#   Parler: map-in-place the ctx_w verbatim weights on the CPU backend (same
#   ggml_backend_cpu_buffer_from_ptr path), so the indic-q8 CPU load fits on the
#   tighter Device Farm iPhone. GPU path byte-identical for both. Engine-side
#   only; no new ggml-speech requirement.
#
# [TTS GGML] Parler-TTS Vulkan on ARM Mali
# (qvac-ext-lib-whisper.cpp PR #119):
# lets the validated Parler pipeline select Vulkan on Mali instead of silently
# falling back to CPU when GPU execution is requested. Verified end-to-end on
# a Pixel 9a (Mali-G715). Engine-side only; no new ggml-speech requirement.
#
# [TTS GGML] CosyVoice3 on the GPU (OpenCL / Adreno)
# (qvac-ext-lib-whisper.cpp PR #118): CosyVoice3 landed CPU-only --
# cosyvoice_load_gguf() hardcoded a CPU backend, all six graphs computed through
# it directly, and n_gpu_layers / backends_dir were declared but never read.
# This adds the GPU path and removes what blocked it: mish() built log(exp(x)+1)
# around a host-only `one` tensor (null deref on the first ggml_cl_add, and
# GGML_OP_LOG has no ggml-opencl kernel) and is replaced by ggml_softplus,
# bit-identical over 960001 samples spanning x in [-120,120]; two weights read
# via ggml_get_data() now stay host-resident, since ggml-opencl's
# buffer_get_base() returns a sentinel (a segfault, not a slow read) -- which
# also keeps 545 MB of embed_tokens off the device. Measured on an Adreno 740:
# 2.04-2.15x faster than the same device's CPU, thermally gated and equal-work
# on every leg. This also completes PR #117's dl-safety fix -- removing the
# `one` tensor drops the last ggml_new_f32 call, which #117 left in the
# standalone cosyvoice_flow.cpp and which fails to link under GGML_BACKEND_DL.
# CPU output is byte-identical.
#
# [TTS GGML] CosyVoice3 dl-safe backend init
# (qvac-ext-lib-whisper.cpp PR #117): the CosyVoice3 engine
# (cosyvoice_pipeline.cpp) called ggml_backend_cpu_init() and ggml_new_f32()
# directly, which are unresolvable under GGML_BACKEND_DL=ON (per-arch CPU dlopen
# variants on aarch64 Linux / Android) -- the @qvac/tts-ggml addon prebuild
# failed verify-prebuild-symbols on linux-arm64 + android-arm64. Route CPU init
# through tts_cpp::detail::init_cpu_backend() and build the scalar constant with
# ggml-base ops instead. CPU output byte-identical (flow parity cosine 1.0);
# statically-linked arches were unaffected.
#
# [TTS GGML] Parler-TTS: bounded DAC decode memory + always-sampling
# (qvac-ext-lib-whisper.cpp PR #114): fixes the iOS e2e failure
# `parler: DAC decode failed`, which had two compounding causes.
#   1. The DAC compute arena was unbounded in output length
#      (~13.6 + 1.957 * n_frames MiB). iOS backs Metal buffers with
#      posix_memalign, where macOS uses vm_allocate and effectively never
#      fails at these sizes -- so it was fatal on device and invisible on a
#      Mac. Streaming also re-decoded the whole code prefix on every chunk:
#      O(n^2) work and ~10 growing allocations up to 837 MiB. Decoding now
#      runs in fixed 128-frame windows that consult the surrounding frames as
#      convolution context, so each window is bit-identical to slicing a
#      whole-sequence decode. Peak DAC memory is O(1) in output length and
#      streaming got 2.2-2.5x faster.
#   2. Argmax decoding is degenerate for this model family: the LM collapses
#      into a silence attractor after the first word, and EOS is gated on
#      codebook 0 emitting EOS *as its argmax*, so generation never terminates
#      and runs to the frame cap. The Engine now always samples -- greedy and
#      top_k = 1 are repaired to the model's sampled defaults with a warning
#      naming the trigger. Output is bit-identical to the previous pin for
#      configurations that already sampled.
# No new ggml-speech requirement: this is engine-side only.
#
# [TTS GGML] Parler-TTS on Vulkan
# (qvac-ext-lib-whisper.cpp PR #110): runs the full Parler pipeline
# -- T5 encoder, delay-pattern decoder LM, DAC vocoder -- on Vulkan for the
# mini / large / Indic families. The GPU gate becomes a validated-backend
# allowlist (Metal + Vulkan) instead of a Metal-only check, and T5 / DAC now
# declare GGML_PREC_F32 on the matmuls that need it. Requires ggml-speech
# >= 2026-07-29, which is what makes that precision request effective on the
# GPU backends (qvac-ext-ggml PR #46); the floor below is a hard dependency,
# not a courtesy bump. Unvalidated backends still fall back to CPU.
#
# [TTS GGML] Parler-TTS Metal GPU support
# (qvac-ext-lib-whisper.cpp PR #103): adds Metal GPU offload to the
# Parler engine (EngineOptions::n_gpu_layers) -- flash-attention plus fused
# QKV / LM-head matmuls on the decode hot path and a conv_transpose_1d matmul
# reformulation for the DAC -- ~2.25x faster than CPU on indic-parler q8_0
# (Apple M5). All GPU work is gated: n_gpu_layers=0 (the default) keeps the CPU
# reference path byte-exact. Also lands native windowed-DAC streaming for
# Parler. Metal is the validated GPU backend; other backends fall back to CPU.
#
# [TTS GGML] CosyVoice3 native C++/ggml TTS engine
# (qvac-ext-lib-whisper.cpp PR #99): adds the Fun-CosyVoice3-0.5B
# engine (public API tts-cpp/cosyvoice/engine.h) -- Qwen2.5 LM (text -> speech
# tokens) + DiT conditional-flow-matching (tokens -> mel) + CausalHiFT vocoder
# (mel -> 24 kHz PCM), all on the ggml-speech backend, CPU. Validated
# bit-for-bit against the PyTorch reference (flow mel cosine 1.0, LM greedy
# trajectory 200/200, HiFT waveform corr 0.92). Instruct2 mode (dialect / accent
# / emotion / speed / volume) via EngineOptions::instruct_text; baked-voice
# timbre via voice_gguf_path. Additive: Chatterbox / Supertonic outputs are
# byte-identical to the prior 2026-07-21 pin. Two commits ahead of the 88b690c
# pin (it carries #100 Parakeet Core ML + #101 long-form windowed encoder,
# neither of which touches the tts-cpp target). This is the engine the
# @qvac/tts-ggml addon wires for CosyVoice3.
#
# [TTS GGML] Chatterbox S3Gen configurable CFG rate
# (qvac-ext-lib-whisper.cpp PR #88): exposes the S3Gen
# classifier-free-guidance rate as a caller option (EngineOptions::s3gen_cfg_rate
# and s3gen_synthesize_opts::cfg_rate; sentinel -1 keeps the model's GGUF-baked
# rate, 0 disables CFG -- skipping the cond+uncond batch-2 pass and roughly
# halving S3Gen compute -- and >0 overrides). Adds a --cfg-rate CLI flag and a
# pure apply_cfg_rate_env_override helper (strtod-validated, sentinel-respecting)
# with unit tests. Backward compatible: with the -1 sentinel the output is
# byte-identical to the prior pin.
#
# [TTS GGML] LavaSR enhancer on a ggml compute graph (GPU + faster CPU)
# (qvac-ext-lib-whisper.cpp PR #82): runs the LavaSR Vocos enhancer's ConvNeXt
# backbone + ISTFT spec head through a ggml compute graph instead of the scalar
# C++ core -- on a GPU backend (Vulkan on Windows/Linux, Metal on Apple, CUDA,
# OpenCL) when EnhancerOptions::use_gpu is set, otherwise on the ggml-CPU backend
# (still markedly faster than, and validated bit-comparable to, the scalar core,
# which is kept as the correctness oracle + last-resort fallback). New
# Enhancer::backend_name()/backend_device() report the resolved backend; the
# companion denoiser stays on CPU (its recurrent GRU topology does not map onto an
# efficient ggml graph). Backward compatible: default options keep the enhancer on
# the CPU backend, and with no enhancer config the output is byte-identical to the
# prior pin.
#
# [TTS GGML] T3 per-op GPU->CPU fallback via shared sched_dispatch
# (qvac-ext-lib-whisper.cpp PR #81): closes the last GPU-unsupported-op
# abort gap in T3 (Chatterbox Turbo/MTL); folds S3Gen/Supertonic onto the
# same shared helper.
#
# [TTS GGML] LavaSR denoiser forward (UL-UNAS)
# (qvac-ext-lib-whisper.cpp PR #78): implements the second LavaSR stage scaffolded
# in PR #76 -- the UL-UNAS GRU U-Net denoiser that cleans noisy speech before the
# Vocos enhancer bandwidth-extends it. tts_cpp::lavasr::Denoiser::load() +
# denoise() now run the full CPU/GGML forward: ERB-band feature encoder, grouped
# depthwise-separable conv encoder/decoder with affine PReLU, a DPGRNN dual-path
# grouped-GRU bottleneck, and causal time-frequency attention, wrapped by the
# StftProcessor STFT/ISTFT + 63-frame / 21-hop squared-Hann overlap-add pipeline.
# Ships the f32 + f16 GGUF loader, the ONNX->GGUF converter (now with fail-fast
# topology + source-md5 provenance checks), and onnxruntime parity tests at both
# the neural-core (spec->spec) and full-pipeline (pcm->pcm) levels. Backward
# compatible: with no denoiser config the output is byte-identical to the prior
# pin. This activates the denoiser slot the tts-ggml addon already wires.
#
# [TTS GGML] Chatterbox MTL Chinese (zh) support
# (qvac-ext-lib-whisper.cpp PR #77): add "zh" to
# mtl_tokenizer::supported_languages() so Chatterbox MTL accepts Chinese
# instead of rejecting it at load ("language 'zh' not in the multilingual
# tokenizer's tier-1 set"). Chinese now flows through the existing Cangjie
# (hanzi -> code) preprocessing path; encode() throws a clear error if zh is
# enabled without a Cangjie5_TC TSV (cangjie_tsv_path / CHATTERBOX_CANGJIE_TSV),
# so misconfiguration fails loudly rather than silently degrading. Test-only
# CMake wiring registers the zh multilingual synth case when the Cangjie TSV is
# present. Zero behaviour change for the other languages / non-zh callers.
#
# [TTS GGML] LavaSR denoiser stage (scaffold)
# (qvac-ext-lib-whisper.cpp PR #76): lands the file/API structure for the second
# LavaSR stage -- the UL-UNAS GRU U-Net denoiser that cleans noisy input before
# the Vocos enhancer bandwidth-extends it. New public API
# tts_cpp::lavasr::Denoiser (include/tts-cpp/lavasr/denoiser.h) plus the
# _core/_gguf/_api translation units and the ONNX->GGUF converter skeleton,
# mirroring the shipped enhancer. Skeleton only: Denoiser::load() throws "not yet
# implemented" until the forward math lands, so there is zero runtime behaviour
# change -- with no denoiser config the output is byte-identical to the prior
# pin. This publishes the symbols so the tts-ggml addon can wire the denoiser
# slot ahead of the implementation.
#
# [TTS GGML] output-frequency selection
# (qvac-ext-lib-whisper.cpp PR #69): EngineOptions::output_sample_rate on both
# the Chatterbox and Supertonic engines (plus the public tts_cpp resampler and
# CLI flags). The vocoder still emits at the model's native rate; when a
# positive rate is requested the engine resamples the final PCM once (batch) or
# drives a single utterance-spanning OutputResampler (streaming) so the streamed
# output is bit-identical to the batch resample -- no per-chunk seams or length
# drift. 0 keeps the native rate (zero behaviour change). This is the engine API
# the tts-ggml addon calls to honour the SDK output-rate option.
#
# [TTS GGML] MeCab support for Chatterbox MTL Japanese
# (qvac-ext-lib-whisper.cpp PR #72): tts-cpp detects vcpkg's include/mecab
# header layout, guards MSVC builds against Windows min/max macros, and links
# the mecab CMake target so static Windows builds propagate the right MeCab
# compile definitions.
#
# [TTS GGML] LavaSR neural speech enhancement
# (qvac-ext-lib-whisper.cpp PR #68): opt-in CPU/GGML post-process that
# bandwidth-extends synthesized PCM to 48 kHz via the LavaSR Vocos enhancer
# (ConvNeXt backbone + ISTFT spec head), converted to a single GGUF. New public
# API tts_cpp::lavasr::Enhancer (include/tts-cpp/lavasr/enhancer.h), DSP core
# (resampler / STFT-ISTFT / Slaney mel / FastLR merge), GGUF loader (f32 + f16),
# and onnxruntime-parity tests. Backward compatible: with no enhancer config the
# output is byte-identical to the prior pin. The denoiser stage is a follow-up.
#
# [TTS GGML] S3TokenizerV2 host-mirror elimination
# (qvac-ext-lib-whisper.cpp PR #65): the voice-conditioning bake loaded the
# S3TokenizerV2 encoder weights (~458 MB F32) into a host std::vector mirror AND
# the backend (Metal) weight buffer at once (~900 MB dual-resident), the
# dominant contributor to the chatterbox first-synth peak that jetsam-killed the
# iOS SDK e2e.  build_encoder_ctx now streams each encoder tensor straight from
# the GGUF into its backend tensor (8 MiB chunks, no host mirror); weights are
# bit-identical.  On-device the chatterbox first-test peak drops 3184 -> 2772 MB
# (under the ~3 GB budget); warm tests unchanged.
#
# Pinned at tetherto/qvac-ext-lib-whisper.cpp@master HEAD 4456c59b (PR #121).
# Relative to the 1823ab31 pin that @qvac/tts-ggml 0.6.2 shipped, this adds the
# iOS memory-peak fix above, Parler's Android Mali backend selection (PR #119)
# plus its shared policy documentation, and a README refresh (PR #120).
# whisper-cpp, parakeet-cpp, and audiogen-cpp remain on their existing pins
# because their subtrees are byte-identical. Carries the fc844ce5 pin
# (PR #99, CosyVoice3, described above) and the 05879fc pin (PR #88 merged: Chatterbox S3Gen
# configurable CFG rate, described above) and the 1cbea2b7 pin (PR #82 merged:
# LavaSR enhancer on a ggml compute graph, described below), one commit ahead of
# the d16d7853 pin (PR #81, T3 per-op GPU->CPU fallback), which it carries.
# Layered on the 9ea1a5e0 pin (PR #77 merged: Chatterbox MTL Chinese
# (zh) support, described above -- exactly one commit ahead of the d149258 pin
# (PR #71, chatterbox-mtl Metal q8 KV-on-GPU real fix), which it
# carries).
# Layered on the 032cee10 pin (PR #76 merged: LavaSR denoiser
# scaffold, described above).
# Layered on the ce9ee96f pin (PR #69 merged: output-frequency
# selection, described above -- three commits back; in between master also took
# the whisper.cpp v1.9.1 upstream sync (PR #73) and a parakeet-cpp
# ggml_backend_sched compute-routing change (PR #74), neither of
# which touches the tts-cpp public API or CMake target).
# Layered on the 28f37eae pin (PR #72 merged: MeCab support for
# Chatterbox MTL Japanese, described above -- exactly one commit behind, so it
# carries the MeCab support).
# Layered on the 4c8767a2 pin (PR #68 merged: LavaSR enhancer,
# described above -- exactly one commit ahead of the prior 586268bf pin, so it
# carries the ARM Mali fix below).
# Layered on the 586268bf pin (PR #67 merged: run Chatterbox
# correctly on ARM Mali Vulkan via an is_arm_mali-gated unfused CFM attention
# -- zero change off ARM Mali, CPU output byte-identical), the 46921668 pin
# (PR #65 merged,
# S3TokenizerV2 host-mirror elimination, described above), the
# 1cc2d383 pin (PR #62: chunk-
# streaming CFM-step floor for the Multilingual standard 10-step CFM) and the
# a679c7e7 pin (PR #43 merged):
# chatterbox iOS-memory work — streamed GGUF tensor loads (no
# full-file host staging), selectable chatterbox KV-cache dtype
# (EngineOptions::kv_cache_type = f32|f16|q8_0) on a token-major slab with a
# load-time capability probe + F32 fallback and a Vulkan q8_0->f32 guard.
#
# Layered on the previous b95ad447 pin (Supertonic v3 PR #42 base),
# which brought the two TTS-relevant master merges:
# - [TTS GGML] end-of-speech robustness (PR #53): alignment-based
#     EOS stop (ports the AlignmentStreamAnalyzer cross-attention signal via an
#     in-graph attention probe) plus a heuristic stop controller (EOS
#     confidence, n-gram repetition, text-length budget) and per-language
#     calibration, so the Chatterbox multilingual model stops at end-of-
#     utterance instead of rambling for ~20s of random tokens past the text.
# - Supertonic Android GPU (PR #54): Adreno OpenCL + Xclipse/Mali
#     Vulkan. This also reroutes Supertonic's direct CPU-backend calls that are
#     unlinkable under GGML_BACKEND_DL=ON --
#     ggml_get_type_traits_cpu()->from_float -> ggml_quantize_chunk()
#     (ggml-base, always linked) and ggml_backend_is_cpu() ->
#     tts_cpp::detail::backend_is_cpu() (registry shim) -- so the tts-ggml
#     addon dlopen's cleanly on Android. It is the upstream successor to the
#     f7d4d6c fix that the tts-ggml package-local overlay was carrying; with
#     this pin published, that overlay can be dropped.

set(VCPKG_POLICY_MISMATCHED_NUMBER_OF_BINARIES enabled)
set(VCPKG_BUILD_TYPE release)

vcpkg_from_github(
    OUT_SOURCE_PATH WHISPER_CPP_SRC
    REPO tetherto/qvac-ext-lib-whisper.cpp
    REF 4456c59b1f07138b30d1076996eb4115f8eb2320
    SHA512 0b2319969691b2e8c03a7761986a775ac2e1fb27e875791f658152d55f796a7ccd9da272e1a1f3b9d676fd55e04dff18da3430f56f8e1c12627b34dca385774f
    HEAD_REF master
)

set(SOURCE_PATH "${WHISPER_CPP_SRC}/engines/tts")
if (NOT EXISTS "${SOURCE_PATH}/CMakeLists.txt")
    message(FATAL_ERROR
        "tts-cpp: ${SOURCE_PATH}/CMakeLists.txt missing; the engines/tts/ "
        "subfolder layout in qvac-ext-lib-whisper.cpp may have changed.")
endif()

vcpkg_check_features(OUT_FEATURE_OPTIONS FEATURE_OPTIONS
    FEATURES
        metal   GGML_METAL
        vulkan  GGML_VULKAN
        cuda    GGML_CUDA
        opencl  GGML_OPENCL
)

set(PLATFORM_OPTIONS)

if(NOT VCPKG_TARGET_IS_OSX)
    list(APPEND PLATFORM_OPTIONS
        -DGGML_BLAS=OFF
        -DGGML_ACCELERATE=OFF
        -DCMAKE_DISABLE_FIND_PACKAGE_BLAS=ON
    )
endif()

vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}"
    DISABLE_PARALLEL_CONFIGURE
    OPTIONS
        -DTTS_CPP_BUILD_LIBRARY=ON
        -DTTS_CPP_BUILD_SHARED=OFF
        -DTTS_CPP_BUILD_EXECUTABLES=OFF
        -DTTS_CPP_BUILD_TESTS=OFF
        -DTTS_CPP_INSTALL=ON
        -DTTS_CPP_USE_SYSTEM_GGML=ON
        -DBUILD_SHARED_LIBS=OFF
        -DGGML_NATIVE=OFF
        -DGGML_OPENMP=OFF
        -DTTS_CPP_OPENMP=OFF
        -DGGML_CCACHE=OFF
        -DTTS_CPP_CCACHE=OFF
        ${FEATURE_OPTIONS}
        ${PLATFORM_OPTIONS}
)

vcpkg_cmake_install()

vcpkg_cmake_config_fixup(PACKAGE_NAME tts-cpp CONFIG_PATH share/tts-cpp)

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

if (VCPKG_LIBRARY_LINKAGE MATCHES "static")
    file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/bin")
    file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/bin")
endif()

vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")
