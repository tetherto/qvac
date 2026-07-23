# tts-cpp: Resemble Chatterbox + Supertonic TTS in pure C++/ggml.
# Sourced from the tts-cpp/ subfolder of qvac-ext-lib-whisper.cpp;
# consumes the ggml-speech port.
#
# [TTS GGML] Chatterbox S3Gen configurable CFG rate
# (qvac-ext-lib-whisper.cpp PR #88, QVAC-21908): exposes the S3Gen
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
# Pinned at tetherto/qvac-ext-lib-whisper.cpp@master HEAD 05879fc (PR #88
# merged: Chatterbox S3Gen configurable CFG rate, described above -- the current
# master tip). Carries the 1cbea2b7 pin (PR #82 merged: LavaSR enhancer on a
# ggml compute graph, described below), one commit ahead of the d16d7853 pin
# (PR #81, T3 per-op GPU->CPU fallback), which it carries.
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
    REF 88b690c051666a63d6f5494a68596c4e785468ef
    SHA512 a1adf1fc953e4c8210e120fc2859aece34a0c738407a346dadaa4bc1762b3f6f6f65ddaceb5ee6d470f56e209ae1d6f49a671cc844f3dfdd8c8a46bf53b426f0
    HEAD_REF master
)

set(SOURCE_PATH "${WHISPER_CPP_SRC}/engines/tts")
if (NOT EXISTS "${SOURCE_PATH}/CMakeLists.txt")
    message(FATAL_ERROR
        "tts-cpp: ${SOURCE_PATH}/CMakeLists.txt missing; the tts-cpp/ "
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
