#include "model-interface/LoadFitNormalization.hpp"

#include <algorithm>
#include <cctype>
#include <cinttypes>
#include <iterator>
#include <sstream>
#include <stdexcept>
#include <string_view>
#include <unordered_set>
#include <utility>

#include <common/arg.h>
#include <common/chat.h>
#include <common/log.h>
#include <inference-addon-cpp/Errors.hpp>
#ifdef __APPLE__
#include <TargetConditionals.h>
#endif

#include "addon/LlmErrors.hpp"
#include "handlers/LoadConfigHandlers.hpp"
#include "utils/ChatTemplateUtils.hpp"
#include "utils/LoggingMacros.hpp"

using namespace qvac_lib_inference_addon_llama::errors;
using namespace qvac_lib_inference_addon_cpp::logger;
using namespace qvac_lib_inference_addon_llama::logging;

namespace {

constexpr std::string_view K_LEGACY_PARSER_NAME = "commonParamsParse";

std::vector<std::string> split(const std::string& str, char delimiter) {
  auto trim = [](const std::string& value) -> std::string {
    auto start =
        std::find_if(value.begin(), value.end(), [](unsigned char character) {
          return std::isspace(character) == 0;
        });

    if (start == value.end()) {
      return "";
    }

    auto end =
        std::find_if(value.rbegin(), value.rend(), [](unsigned char character) {
          return std::isspace(character) == 0;
        }).base();

    return {start, end};
  };

  std::vector<std::string> tokens;
  std::istringstream stream(str);
  std::string token;

  while (std::getline(stream, token, delimiter)) {
    auto trimmed = trim(token);
    if (!trimmed.empty()) {
      tokens.push_back(std::move(trimmed));
    }
  }
  return tokens;
}

uint32_t trainedContext(const ModelMetaData& metadata) {
  const auto architecture = metadata.tryGetString("general.architecture");
  if (!architecture.has_value()) {
    return 0;
  }
  const std::string key = *architecture + ".context_length";
  return metadata.tryGetU32(key.c_str()).value_or(0);
}

// Mirrors llm_arch_supports_sm_tensor() in qvac-fabric src/llama-arch.cpp,
// which qvac-fabric does not install: it lives in the internal
// src/llama-arch.h, not the public include/ tree. The values below
// are the GGUF `general.architecture` strings from LLM_ARCH_NAMES, NOT the enum
// names lower-cased — e.g. LLM_ARCH_FALCON_H1 is "falcon-h1" and
// LLM_ARCH_GRANITE_HYBRID is "granitehybrid". Deliberately absent, because
// fabric does support them: "deepseek2-ocr" and "t5encoder".
//
// RE-CHECK ON EVERY qvac-fabric BUMP — this is a manual mirror and nothing
// enforces it. LoadFitNormalizationTest.TensorSplitArchDenylistCoversFabric
// exercises this list but reads nothing from fabric, so it cannot detect
// drift; it only pins the addon against its own copy. Verified by hand
// against qvac-fabric v10297.1.1 (27 entries). v10297.1.1 leaves
// src/llama-arch.cpp untouched relative to v10297.1.0, so the list is
// unchanged across that bump.
//
// The bump from v10297.0.0 to v10297.1.0 REMOVED three entries — fabric now
// supports tensor split for deepseek4, qwen35 and qwen35moe. Leaving them here
// would reject architectures fabric accepts, so the list shrank rather than
// grew. A denylist drifts in both directions; re-derive it from
// llm_arch_supports_sm_tensor rather than only appending.
//
// An absent general.architecture returns "supported": fabric's own check at
// src/llama-model.cpp:328 remains the backstop, this list is only a UX layer
// that turns a bare std::runtime_error into a structured InvalidArgument.
bool archSupportsTensorSplit(const ModelMetaData& metadata) {
  static const std::unordered_set<std::string> kUnsupported = {
      "grok",          "mpt",
      "plamo2",        "minicpm3",
      "gemma3n",       "mamba",
      "mamba2",        "jamba",
      "falcon-h1",     "olmo2",
      "olmoe",         "deepseek2",
      "deepseek32",    "glm-dsa",
      "bitnet",        "t5",
      "nemotron_h",    "nemotron_h_moe",
      "granitehybrid", "lfm2",
      "lfm2moe",       "minimax-m2",
      "minimax-m3",    "mistral4",
      "kimi-linear",   "qwen3tts",
      "qwen3next"};
  const auto architecture = metadata.tryGetString("general.architecture");
  if (!architecture.has_value()) {
    return true;
  }
  return kUnsupported.count(*architecture) == 0;
}

// Lambda form rather than a bare ::tolower: the value is caller-supplied and
// may carry non-ASCII bytes, which are negative under a signed char and
// undefined input to tolower.
std::string toLowerAscii(std::string value) {
  std::transform(
      value.begin(), value.end(), value.begin(), [](unsigned char character) {
        return static_cast<char>(std::tolower(character));
      });
  return value;
}

// The resolved flash-attn value, classified against qvac-fabric's own three-way
// vocabulary. Fabric's --flash-attn handler (common/arg.cpp) routes every value
// through is_truthy / is_falsey / is_autoy and throws on anything all three
// reject, so a value outside them is invalid input, NOT a fourth state.
//
// Two flags rather than one because the guards that read this ask DIFFERENT
// questions, and AUTO answers them differently:
//   - "will flash attention definitely be on?"  -> enabled
//   - "might flash attention be on?"            -> mayEnable
struct FlashAttnState {
  bool enabled = false;
  bool mayEnable = false;
};

// Resolves flash-attn from BOTH key spellings, validates it, and classifies it
// once. Callers get a value already checked against fabric's vocabulary, so no
// guard downstream has to decide what an unrecognised string means.
//
// Both spellings present is a hard error. The passthrough loop emits one
// --flash-attn per key and ConfigMap is an unordered_map, so a contradictory
// pair hands fabric two flags whose winner is unspecified — which let a caller
// read as "off" here while fabric applied "auto", disarming the Adreno crash
// guard below. index.d.ts already publishes "Supplying both is an error"; this
// is where that contract is finally enforced, matching what split-mode and
// mmproj-use-gpu already do for their own duplicate spellings.
//
// The value is matched case-SENSITIVELY, deliberately. Fabric's predicates do
// no case folding, so lowercasing here would let the addon act on a value
// fabric then rejects — making this file more permissive than the parser it
// feeds, and replacing fabric's accurate "unknown value" with whatever
// downstream guard happened to fire first.
FlashAttnState resolveFlashAttn(
    const std::unordered_map<std::string, std::string>& configFilemap) {
  const auto hyphenIt = configFilemap.find("flash-attn");
  const auto underscoreIt = configFilemap.find("flash_attn");
  if (hyphenIt != configFilemap.end() && underscoreIt != configFilemap.end()) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        string_format(
            "%s: both 'flash-attn' and 'flash_attn' are present; use one or "
            "the other. Supplying both leaves it unspecified which flash "
            "attention value reaches qvac-fabric.\n",
            K_LEGACY_PARSER_NAME.data()));
  }

  const auto it = (hyphenIt != configFilemap.end()) ? hyphenIt : underscoreIt;
  if (it == configFilemap.end()) {
    return {};
  }

  // is_autoy also accepts "-1", fabric's numeric spelling of AUTO. That is not
  // in index.d.ts's declared union for "flash-attn", and a declared property
  // wins over the [key: string] index signature — so a TypeScript caller can
  // only reach "-1" through the undeclared "flash_attn" spelling. Accepted
  // anyway, because the addon must not disagree with the parser it is about to
  // hand the value to, and direct C++ / JS callers bypass the types entirely.
  const std::string& value = it->second;
  const bool truthy = common_arg_utils::is_truthy(value);
  const bool falsey = common_arg_utils::is_falsey(value);
  const bool autoy = common_arg_utils::is_autoy(value);
  if (!truthy && !falsey && !autoy) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        string_format(
            "%s: unknown value for %s: '%s'. Accepted (lower-case): on, "
            "enabled, true, 1, off, disabled, false, 0, auto.\n",
            K_LEGACY_PARSER_NAME.data(),
            it->first.c_str(),
            value.c_str()));
  }
  return {.enabled = truthy, .mayEnable = truthy || autoy};
}

} // namespace

namespace load_fit_normalization {

NormalizedFitSnapshot makeNormalizedFitSnapshot(
    const common_params& params, uint32_t trainedContext) {
  NormalizedFitSnapshot snapshot{
      .nGpuLayers = params.n_gpu_layers,
      .nCtx = params.n_ctx == 0 ? trainedContext
                                : static_cast<uint32_t>(params.n_ctx),
      .nBatch = static_cast<uint32_t>(params.n_batch),
      .nUbatch = static_cast<uint32_t>(params.n_ubatch),
      .nParallel = static_cast<uint32_t>(params.n_parallel),
      .splitMode = static_cast<int32_t>(params.split_mode),
      .mainGpu = params.main_gpu,
      .typeK = static_cast<int32_t>(params.cache_type_k),
      .typeV = static_cast<int32_t>(params.cache_type_v),
      .flashAttnType = static_cast<int32_t>(params.flash_attn_type),
      .useMmap = params.load_mode == LLAMA_LOAD_MODE_MMAP ||
                 params.load_mode == LLAMA_LOAD_MODE_MMAP_MLOCK,
      .useMlock = params.load_mode == LLAMA_LOAD_MODE_MLOCK ||
                  params.load_mode == LLAMA_LOAD_MODE_MMAP_MLOCK,
      .kvOffload = !params.no_kv_offload,
      .opOffload = !params.no_op_offload,
      .swaFull = params.swa_full,
      .kvUnified = params.kv_unified,
      .useExtraBufferTypes = !params.no_extra_bufts,
      .useHostBuffer = !params.no_host,
      .fitParams = params.fit_params,
      .fitParamsMinCtx = params.fit_params_min_ctx};

  snapshot.tensorSplit.assign(
      std::begin(params.tensor_split),
      std::begin(params.tensor_split) + llama_max_devices());
  snapshot.fitParamsTargetBytes.assign(
      params.fit_params_target.begin(), params.fit_params_target.end());

  for (const auto& override : params.kv_overrides) {
    if (override.key[0] == '\0') {
      break;
    }
    CanonicalModelKvValue value;
    switch (override.tag) {
    case LLAMA_KV_OVERRIDE_TYPE_INT:
      value = override.val_i64;
      break;
    case LLAMA_KV_OVERRIDE_TYPE_FLOAT:
      value = override.val_f64;
      break;
    case LLAMA_KV_OVERRIDE_TYPE_BOOL:
      value = override.val_bool;
      break;
    case LLAMA_KV_OVERRIDE_TYPE_STR:
      value = std::string(override.val_str);
      break;
    default:
      throw std::invalid_argument("unknown llama model metadata override type");
    }
    snapshot.modelKvOverrides.push_back(
        {.key = override.key,
         .type = static_cast<int32_t>(override.tag),
         .value = std::move(value)});
  }

  for (const auto& override : params.tensor_buft_overrides) {
    if (override.pattern == nullptr) {
      break;
    }
    snapshot.tensorBufferOverrides.push_back(
        {override.pattern,
         override.buft == nullptr ? ""
                                  : ggml_backend_buft_name(override.buft)});
  }
  return snapshot;
}

void tuneLoadConfigMap(
    std::unordered_map<std::string, std::string>& configFilemap,
    const ModelMetaData& metadata, const std::optional<int>& adrenoVersion,
    const FinetuneConfigOverrides& finetuneOverrides, bool isOpenCl,
    bool isMetal, bool isGpu, bool isTensorSplit) {

  const bool isFinetuning = finetuneOverrides.active;

  // Validate the CALLER's value before any default is written on top of it.
  // Order matters: the finetuning branch below erases "flash_attn" and writes
  // "flash-attn", which would silently resolve a contradictory pair instead of
  // rejecting it. The classified result is recomputed after the defaults, so
  // only the validation side effect is wanted here.
  static_cast<void>(resolveFlashAttn(configFilemap));

  auto notUserSet = [&](const char* hyphenKey, const char* underscoreKey) {
    return configFilemap.find(hyphenKey) == configFilemap.end() &&
           configFilemap.find(underscoreKey) == configFilemap.end();
  };

  const bool isBitnet =
      metadata.hasOneBitQuantization() &&
      metadata.tryGetString("general.architecture") == "bitnet";

  if (isFinetuning) {
    configFilemap.erase("ctx_size");
    configFilemap["ctx-size"] = std::to_string(finetuneOverrides.contextLength);
    configFilemap.erase("batch_size");
    configFilemap["batch-size"] = std::to_string(finetuneOverrides.batchSize);
    configFilemap.erase("ubatch_size");
    configFilemap["ubatch-size"] =
        std::to_string(finetuneOverrides.microBatchSize);
    QLOG_IF(
        Priority::DEBUG,
        string_format(
            "[LlamaModel] Finetuning: ctx-size=%" PRId64 " batch-size=%" PRId64
            " ubatch-size=%" PRId64 "\n",
            finetuneOverrides.contextLength,
            finetuneOverrides.batchSize,
            finetuneOverrides.microBatchSize));
  }

  if (isFinetuning) {
    configFilemap.erase("flash_attn");
    configFilemap["flash-attn"] = finetuneOverrides.flashAttn ? "on" : "off";
    QLOG_IF(
        Priority::INFO,
        (finetuneOverrides.flashAttn
             ? "[LlamaModel] Finetuning: enabling flash attention\n"
             : "[LlamaModel] Finetuning: disabling flash attention\n"));
  } else if (isBitnet && notUserSet("flash-attn", "flash_attn")) {
    configFilemap.erase("flash_attn");
    configFilemap["flash-attn"] = "off";
    QLOG_IF(
        Priority::INFO,
        "[LlamaModel] BitNet model detected: disabling flash attention\n");
  } else if (notUserSet("flash-attn", "flash_attn")) {
    configFilemap.erase("flash_attn");
    configFilemap["flash-attn"] = "on";
    QLOG_IF(
        Priority::INFO, "[LlamaModel] Enabling flash attention by default\n");
  }

  constexpr int kAdrenoUbatchThreshold = 800;
  const bool needsUbatch = (isBitnet || isFinetuning) &&
                           adrenoVersion.has_value() &&
                           adrenoVersion.value() >= kAdrenoUbatchThreshold;
  if (needsUbatch) {
    constexpr int64_t kAdrenoUbatchCap = 128;
    if (notUserSet("ubatch-size", "ubatch_size")) {
      configFilemap["ubatch-size"] = std::to_string(kAdrenoUbatchCap);
      QLOG_IF(
          Priority::INFO,
          "[LlamaModel] Adreno 800+ (Vulkan): defaulting ubatch-size=128\n");
    } else {
      const std::string& key =
          configFilemap.count("ubatch-size") ? "ubatch-size" : "ubatch_size";
      int64_t userVal;
      try {
        userVal = std::stoll(configFilemap[key]);
      } catch (const std::exception& e) {
        QLOG_IF(
            Priority::ERROR,
            string_format(
                "[LlamaModel] Adreno 800+ (Vulkan): invalid ubatch-size "
                "\"%s\" (%s), falling back to %" PRId64 "\n",
                configFilemap[key].c_str(),
                e.what(),
                kAdrenoUbatchCap));
        userVal = kAdrenoUbatchCap;
      }
      const int64_t clamped = std::min(userVal, kAdrenoUbatchCap);
      if (clamped < userVal) {
        QLOG_IF(
            Priority::WARNING,
            string_format(
                "[LlamaModel] Adreno 800+ (Vulkan): ubatch-size=%" PRId64
                " exceeds safe maximum %" PRId64 ", clamping to %" PRId64 "\n",
                userVal,
                kAdrenoUbatchCap,
                clamped));
      }
      configFilemap.erase("ubatch_size");
      configFilemap["ubatch-size"] = std::to_string(clamped);
    }
  }

  if (isFinetuning && !finetuneOverrides.gpuSupportsF16OutProd) {
    if (notUserSet("cache-type-k", "cache_type_k")) {
      configFilemap["cache-type-k"] = "f32";
      QLOG_IF(
          Priority::INFO,
          "[LlamaModel] Finetuning: GPU lacks F16 out_prod, using f32 K for KV "
          "cache\n");
    }
    if (notUserSet("cache-type-v", "cache_type_v")) {
      configFilemap["cache-type-v"] = "f32";
      QLOG_IF(
          Priority::INFO,
          "[LlamaModel] Finetuning: GPU lacks F16 out_prod, using f32 V for KV "
          "cache\n");
    }
  }

  // QVAC-21318: KV-cache type policy. Blocks 1-3 run in a fixed order that MUST
  // NOT be reordered; block 4 is an order-independent advisory:
  //   1. auto-default q8_0 on GPU   — fills in the default when unset
  //   2. Adreno 800+ Vulkan reject  — rejects quantized KV that would crash
  //   3. OpenCL / Metal guard       — validates the (possibly defaulted) type
  //   4. mixed K!=V warning         — advisory only, never throws
  // The finetuning f32 KV override above runs first; the auto-default is gated
  // by !isFinetuning so it never clobbers it.
  //
  // Shared inputs, computed once. Re-resolved rather than reusing the caller's
  // classification above, because the branches in between may have written the
  // effective value (the "on" default, BitNet's and finetuning's force-off) —
  // this must read what fabric will actually receive.
  constexpr int kAdrenoKvQuantThreshold = 800;
  const FlashAttnState flashAttn = resolveFlashAttn(configFilemap);

  // Two questions, not one, because the guards below differ on AUTO.
  //
  // flashAttnEnabled — "flash attention will definitely be on". Truthy only,
  // with one exception. AUTO is otherwise excluded because the q8_0 default it
  // gates quantizes the V cache, and fabric promotes AUTO to ENABLED whenever
  // the V cache is quantized (src/llama-context.cpp, "enabling flash_attn
  // since it is required for quantized V cache"). Defaulting q8_0 for an AUTO
  // caller would force flash attention on and skip the runtime capability
  // probe (llama_context::resolve, cparams.auto_fa) that AUTO exists to run —
  // contradicting this package's documented contract, "'auto' lets qvac-fabric
  // decide" (src/index.ts). An AUTO caller keeps f16; an explicit
  // cache-type-k/v still works.
  //
  // The exception is split-mode 'tensor'. Fabric promotes AUTO to ENABLED for
  // that mode unconditionally and before any KV type is read
  // (src/llama-context.cpp, "enabling flash_attn since it is required for
  // SPLIT_MODE_TENSOR"), so there is no probe left to protect and withholding
  // q8_0 would cost 2x the KV cache for nothing. It lands worst there too:
  // tensor mode force-disables auto-fit, so nothing trims ctx_size to absorb
  // it. Falsey under tensor mode is rejected outright by the guard in
  // normalizeLoadForFit, so it cannot reach the q8_0 block either way.
  //
  // flashAttnMayEnable — "flash attention might be on". Truthy or autoy. The
  // Adreno crash guard is defence-in-depth against a native abort, so it must
  // fire for any value that can reach fabric with flash attention active, and
  // AUTO can: quantized V promotes it to ENABLED, and even an un-promoted AUTO
  // resolves to enabled wherever the probe passes. Deliberately conservative —
  // with a quantized K cache only no promotion fires and the probe might have
  // disabled flash attention on its own, but the guard runs long before the
  // probe and cannot know the outcome.
  const bool flashAttnEnabled =
      flashAttn.enabled || (isTensorSplit && flashAttn.mayEnable);
  const bool flashAttnMayEnable = flashAttn.mayEnable;
  // Adreno 800+ on Vulkan: coopmat1 Flash Attention is unstable with quantized
  // KV (no fabric scalar-FA fix on this branch). Adreno selects OpenCL by
  // default, so this is normally unreachable; kept as a defensive guard against
  // forced-Vulkan paths. Requires isGpu so a non-GPU call can't fire it.
  const bool isAdrenoVulkan =
      isGpu && adrenoVersion.has_value() &&
      adrenoVersion.value() >= kAdrenoKvQuantThreshold && !isOpenCl && !isMetal;
  auto isQuantizedKvType = [](const std::string& v) {
    return v == "q4_0" || v == "q4_1" || v == "q5_0" || v == "q5_1" ||
           v == "q8_0" || v == "iq4_nl" || v == "tbq3_0" || v == "tbq4_0" ||
           v == "pq3_0" || v == "pq4_0";
  };

  // 1. Default the KV-cache to q8_0 on Metal/Vulkan GPU backends when the
  // caller hasn't picked a cache type. q8_0 is quality-neutral vs f16 on GPU
  // and cuts KV-cache memory ~47%. CPU keeps the f16 default — ARM q8_0 carries
  // a measured quality and decode-throughput cost. OpenCL (Adreno) is also
  // EXCLUDED: q8_0 attention works there, but quantized KV-cache *shifts*
  // (reasoning-block compaction / state restore) abort natively in
  // llama_kv_cache::update on Adreno, so f16 stays the safe default — and
  // block 3 now *rejects* any explicit quantized KV on OpenCL (q8_0 and q4_0
  // both crash on a shift). Also skipped for finetuning (manages its own KV
  // types), when flash attention is off (V-cache quantization requires it), and
  // on Adreno+Vulkan (see above).
  if (!isFinetuning && isGpu && !isOpenCl && flashAttnEnabled &&
      !isAdrenoVulkan && notUserSet("cache-type-k", "cache_type_k") &&
      notUserSet("cache-type-v", "cache_type_v")) {
    configFilemap["cache-type-k"] = "q8_0";
    configFilemap["cache-type-v"] = "q8_0";
    QLOG_IF(
        Priority::INFO,
        "[LlamaModel] Defaulting KV-cache to q8_0 on GPU backend "
        "(set cache-type-k/v to override)\n");
  }

  // 2. Adreno 800+ Vulkan: quantized KV-cache with Flash Attention crashes (the
  // FA CM2 shader's dequant path hits an Adreno driver bug). Guard here so
  // callers get a clean error instead of a native abort.
  if (isAdrenoVulkan && flashAttnMayEnable) {
    auto checkAdrenoKv = [&](const char* hyphenKey,
                             const char* underscoreKey,
                             const char* side) {
      auto it = configFilemap.find(hyphenKey);
      if (it == configFilemap.end())
        it = configFilemap.find(underscoreKey);
      if (it == configFilemap.end())
        return;
      if (!isQuantizedKvType(it->second))
        return;
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          string_format(
              "[LlamaModel] cache-type-%s=%s: quantized KV-cache with "
              "Flash Attention is not supported on Adreno 800+ (Vulkan). "
              "Use flash-attn=off, set cache-type-%s to f16/f32/bf16, or "
              "disable GPU acceleration.\n",
              side,
              it->second.c_str(),
              side));
    };
    checkAdrenoKv("cache-type-k", "cache_type_k", "k");
    checkAdrenoKv("cache-type-v", "cache_type_v", "v");
  }

  // 3. OpenCL (Adreno): reject ALL quantized KV-cache types. q4_0/q8_0
  // attention works, but a quantized K cache needs a
  // dequantize->RoPE->requantize copy on every KV-cache *shift* (reasoning-
  // block compaction / state restore), and ggml-opencl has no F32->quantized
  // copy kernel for that requantize step, so the shift aborts natively in
  // llama_kv_cache::update on Adreno. Confirmed for BOTH q8_0 and q4_0 (CI run
  // 28448086915: S25/S26 crash on a q4_0 KV-cache shift; Mali Vulkan passes).
  // Only f32/f16/bf16 are safe on OpenCL. Metal: standard quant types are
  // supported; only TurboQuant/PolarQuant is rejected.
  if (isOpenCl || isMetal) {
    auto isTurboQuantKvType = [](const std::string& v) {
      return v == "tbq3_0" || v == "tbq4_0" || v == "pq3_0" || v == "pq4_0";
    };
    auto isOpenClSafeKvType = [](const std::string& v) {
      return v == "f32" || v == "f16" || v == "bf16";
    };
    auto checkCacheType = [&](const char* hyphenKey,
                              const char* underscoreKey,
                              const char* side) {
      auto it = configFilemap.find(hyphenKey);
      if (it == configFilemap.end())
        it = configFilemap.find(underscoreKey);
      if (it == configFilemap.end())
        return;
      if (isOpenCl) {
        if (isOpenClSafeKvType(it->second))
          return;
        // TurboQuant/PolarQuant: no OpenCL kernel at all. Keep the
        // "TurboQuant/PolarQuant ... not supported" wording so callers can
        // recognize it specifically.
        if (isTurboQuantKvType(it->second)) {
          throw qvac_errors::StatusError(
              qvac_errors::general_error::InvalidArgument,
              string_format(
                  "[LlamaModel] cache-type-%s=%s is a TurboQuant/PolarQuant "
                  "KV-cache type and is not supported on the OpenCL (Adreno) "
                  "backend. Use cache-type-%s f32/f16/bf16, or switch device "
                  "to "
                  "a Vulkan GPU or CPU.\n",
                  side,
                  it->second.c_str(),
                  side));
        }
        // Any other quantized type on OpenCL: the requantize copy on a KV-cache
        // shift has no ggml-opencl kernel and aborts in llama_kv_cache::update.
        // The wording covers both sides — this check runs for K and V alike.
        throw qvac_errors::StatusError(
            qvac_errors::general_error::InvalidArgument,
            string_format(
                "[LlamaModel] cache-type-%s=%s: quantized KV-cache is not "
                "supported on the OpenCL (Adreno) backend. A quantized K or V "
                "cache aborts in llama_kv_cache::update on KV-cache shifts / "
                "cache management (reasoning-block compaction, state restore), "
                "because ggml-opencl has no F32->quantized copy kernel for the "
                "requantize step (true for q8_0 and q4_0 alike). Use "
                "cache-type-%s f32/f16/bf16, or switch device to a Vulkan GPU "
                "or CPU.\n",
                side,
                it->second.c_str(),
                side));
      }
      // Metal: only TurboQuant/PolarQuant is unsupported.
      if (!isTurboQuantKvType(it->second))
        return;
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          string_format(
              "[LlamaModel] cache-type-%s=%s is a TurboQuant/PolarQuant "
              "KV-cache type and is not supported on the Metal backend. Either "
              "pick a different cache type "
              "(f32/f16/bf16/q4_0/q4_1/q5_0/q5_1/q8_0/iq4_nl) or switch device "
              "to a Vulkan GPU or CPU.\n",
              side,
              it->second.c_str()));
    };
    checkCacheType("cache-type-k", "cache_type_k", "k");
    checkCacheType("cache-type-v", "cache_type_v", "v");
  }

  // 4. Mixed/asymmetric K!=V warning (advisory — never throws). When K and V
  // use different cache types and at least one is quantized, the kernels fall
  // off the fused Flash-Attention path (a large GPU decode penalty on
  // Vulkan/Mali) for no quality benefit. Asymmetric non-quantized
  // (f32/f16/bf16) carries no such penalty and is not warned. Finetuning
  // manages its own KV types, so it is skipped. This is a warning, not a hard
  // error — callers may still opt in — and can be removed once qvac-fabric
  // handles asymmetric quantized K/V efficiently.
  if (!isFinetuning) {
    auto effectiveType = [&](const char* hyphenKey, const char* underscoreKey) {
      auto it = configFilemap.find(hyphenKey);
      if (it == configFilemap.end())
        it = configFilemap.find(underscoreKey);
      return it == configFilemap.end() ? std::string("f16") : it->second;
    };
    const std::string kType = effectiveType("cache-type-k", "cache_type_k");
    const std::string vType = effectiveType("cache-type-v", "cache_type_v");
    if (kType != vType &&
        (isQuantizedKvType(kType) || isQuantizedKvType(vType))) {
      QLOG_IF(
          Priority::WARNING,
          string_format(
              "[LlamaModel] Mixed KV-cache types (cache-type-k=%s, "
              "cache-type-v=%s): asymmetric quantized K/V falls off the fused "
              "Flash-Attention path (notable GPU decode-throughput penalty on "
              "Vulkan/Mali) with no quality benefit, and is unsupported on "
              "Adreno OpenCL. Proceeding anyway; prefer a symmetric cache "
              "type. "
              "(This may be relaxed once qvac-fabric handles asymmetric "
              "quantized K/V efficiently.)\n",
              kType.c_str(),
              vType.c_str()));
    }
  }
}

NormalizationDependencies
productionDependencies(backend_selection::llamaLogCallbackF logCallback) {
  return {
      .resolveBackend =
          [logCallback](
              backend_selection::BackendType preferred,
              const std::optional<backend_selection::MainGpu>& mainGpu,
              const ModelMetaData& metadata,
              bool isFinetuning) {
            std::optional<int> adrenoVersion;
            bool isMaliGpu = false;
            auto [type, name] = backend_selection::chooseBackend(
                preferred,
                logCallback,
                mainGpu,
                &metadata,
                &adrenoVersion,
                isFinetuning,
                &isMaliGpu);
            return SelectedBackend{
                .type = type,
                .name = std::move(name),
                .adrenoVersion = adrenoVersion,
                .isMaliGpu = isMaliGpu};
          },
      .gpuBackendSupportsRowSplit =
          []() { return backend_selection::gpuBackendSupportsRowSplit(); },
      .tensorSplitDeviceNames =
          []() { return backend_selection::getTensorSplitDeviceNames(); }};
}

NormalizedLoad normalizeLoadForFit(
    const std::string& modelPath, ConfigMap configFilemap,
    const ModelMetaData& metadata,
    const FinetuneConfigOverrides& finetuneOverrides,
    const NormalizationDependencies& dependencies) {
  NormalizedLoad result;
  common_params& params = result.params;

  std::vector<std::string> configVector;

  // Check if tools are enabled and exclude it with jinja from the config file
  if (auto iter = configFilemap.find("tools"); iter != configFilemap.end()) {
    const std::string toolsVal = toLowerAscii(iter->second);
    if (toolsVal == "true") {
      params.use_jinja = true;
      // Remove "tools" from config, since using jinja
      configFilemap.erase(iter);
    } else {
      configFilemap.erase(iter);
    }
  }
  if (auto jit = configFilemap.find("jinja"); jit != configFilemap.end()) {
    // Remove "jinja" from config
    configFilemap.erase(jit);
  }

  // Map the addon's load-mode string configuration directly to the native
  // model parameter (the generic argument parser is bypassed for it). The
  // accepted values mirror llama_load_mode_from_str: 'none', 'mmap',
  // 'mlock', 'mmap+mlock' and 'dio'. When absent, llama.cpp's default
  // (mmap) applies. Validated with a local table instead of
  // llama_load_mode_from_str: that helper reports unknown values by throwing
  // std::invalid_argument, and exceptions thrown inside the fabric DLL do
  // not reliably match catch-by-type across the module boundary on Windows.
  std::optional<std::string> loadMode;
  for (const std::string& key : {"load-mode", "load_mode"}) {
    if (auto it = configFilemap.find(key); it != configFilemap.end()) {
      const std::string value = toLowerAscii(it->second);
      if (loadMode.has_value() && loadMode.value() != value) {
        throw qvac_errors::StatusError(
            ADDON_ID,
            qvac_errors::general_error::toString(
                qvac_errors::general_error::InvalidArgument),
            "load-mode and load_mode must have the same value");
      }
      loadMode = value;
      configFilemap.erase(it);
    }
  }
  if (loadMode.has_value()) {
    static const std::unordered_map<std::string, llama_load_mode> kLoadModes = {
        {"auto", LLAMA_LOAD_MODE_AUTO},
        {"none", LLAMA_LOAD_MODE_NONE},
        {"mmap", LLAMA_LOAD_MODE_MMAP},
        {"mlock", LLAMA_LOAD_MODE_MLOCK},
        {"mmap+mlock", LLAMA_LOAD_MODE_MMAP_MLOCK},
        {"dio", LLAMA_LOAD_MODE_DIRECT_IO}};
    const auto mode = kLoadModes.find(loadMode.value());
    if (mode == kLoadModes.end()) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          qvac_errors::general_error::toString(
              qvac_errors::general_error::InvalidArgument),
          string_format(
              "load-mode must be one of 'auto', 'none', 'mmap', 'mlock', "
              "'mmap+mlock' or 'dio', got: %s",
              loadMode->c_str()));
    }
    params.load_mode = mode->second;
  }

  // MedPsy ships only a Jinja chat template embedded in its GGUF; the non-jinja
  // fallback path used by llama.cpp does not execute the {%- set persona -%}
  // block that injects the model's persona system prompt, so the model loses
  // its identity when jinja is off. Auto-enable jinja whenever we detect the
  // MedPsy basename so the embedded template is applied regardless of the
  // tools setting.
  if (!params.use_jinja &&
      qvac_lib_inference_addon_llama::utils::isMedPsyBasename(
          metadata.tryGetString("general.basename").value_or(""))) {
    params.use_jinja = true;
    QLOG_IF(
        Priority::INFO,
        "[LlamaModel] MedPsy basename detected; auto-enabling jinja so the "
        "embedded chat template is applied\n");
  }

  qvac_lib_inference_addon_llama::applyLoadConfigHandlers(
      params, configFilemap);

  llama_split_mode splitMode = LLAMA_SPLIT_MODE_NONE;
  auto hIt = configFilemap.find("split-mode");
  auto uIt = configFilemap.find("split_mode");
  if (hIt != configFilemap.end() && uIt != configFilemap.end()) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        string_format(
            "%s: both 'split-mode' and 'split_mode' are present; "
            "use one or the other.\n",
            K_LEGACY_PARSER_NAME.data()));
  }
  if (auto it = (hIt != configFilemap.end()) ? hIt : uIt;
      it != configFilemap.end()) {
    const std::string val = toLowerAscii(it->second);
    if (val == "layer") {
      splitMode = LLAMA_SPLIT_MODE_LAYER;
    } else if (val == "row") {
      splitMode = LLAMA_SPLIT_MODE_ROW;
    } else if (val == "tensor") {
      splitMode = LLAMA_SPLIT_MODE_TENSOR;
    } else if (val != "none") {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          string_format(
              "%s: invalid split-mode '%s', must be 'none', 'layer', 'row', or "
              "'tensor'.\n",
              K_LEGACY_PARSER_NAME.data(),
              it->second.c_str()));
    }
    configFilemap.erase(it);
  }

#if defined(__ANDROID__) ||                                                    \
    (defined(__APPLE__) && defined(TARGET_OS_IOS) && TARGET_OS_IOS)
  if (splitMode != LLAMA_SPLIT_MODE_NONE ||
      configFilemap.count("main-gpu") > 0 ||
      configFilemap.count("main_gpu") > 0 ||
      configFilemap.count("tensor-split") > 0 ||
      configFilemap.count("tensor_split") > 0) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Multi-GPU parameters (split-mode, main-gpu, tensor-split) are not "
        "supported on mobile (single-GPU device).");
  }
#endif

  auto deviceIt = configFilemap.find("device");
  if (deviceIt == configFilemap.end()) {
    std::string errorMsg = string_format(
        "%s: must specify a device: 'gpu' or 'cpu'.\n",
        K_LEGACY_PARSER_NAME.data());
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument, errorMsg);
  }

  bool isOpenCl = false;
  bool isMetal = false;
  bool isGpu = false;
  {
    using namespace backend_selection;
    const BackendType preferredBackend =
        preferredBackendTypeFromString(deviceIt->second);

    const std::optional<MainGpu> mainGpu = tryMainGpuFromMap(configFilemap);

    const SelectedBackend selected = dependencies.resolveBackend(
        preferredBackend, mainGpu, metadata, finetuneOverrides.active);
    result.adrenoVersion = selected.adrenoVersion;

    // QVAC-21257: optional runtime override for the multimodal projector
    // (mmproj / vision encoder) backend. The default is auto-selected per
    // device class (QVAC-21867): desktop / iOS -> GPU; Android -> GPU except
    // Mali, whose projector encode is slower on GPU than CPU -> CPU. The key
    // lets callers force either backend without recompiling.
    // Accepts true/on/1 and false/off/0 (case-insensitive). Erased from
    // configFilemap so it is never forwarded to llama.cpp's argument parser
    // by the passthrough loop.
    std::optional<bool> mmprojUseGpuOverride;
    {
      auto hMmproj = configFilemap.find("mmproj-use-gpu");
      auto uMmproj = configFilemap.find("mmproj_use_gpu");
      if (hMmproj != configFilemap.end() && uMmproj != configFilemap.end()) {
        throw qvac_errors::StatusError(
            qvac_errors::general_error::InvalidArgument,
            string_format(
                "%s: both 'mmproj-use-gpu' and 'mmproj_use_gpu' are present; "
                "use one or the other.\n",
                K_LEGACY_PARSER_NAME.data()));
      }
      if (auto it = (hMmproj != configFilemap.end()) ? hMmproj : uMmproj;
          it != configFilemap.end()) {
        const std::string val = toLowerAscii(it->second);
        if (val == "true" || val == "on" || val == "1") {
          mmprojUseGpuOverride = true;
        } else if (val == "false" || val == "off" || val == "0") {
          mmprojUseGpuOverride = false;
        } else {
          throw qvac_errors::StatusError(
              qvac_errors::general_error::InvalidArgument,
              string_format(
                  "%s: invalid mmproj-use-gpu '%s', must be 'true'/'on'/'1' or "
                  "'false'/'off'/'0'.\n",
                  K_LEGACY_PARSER_NAME.data(),
                  it->second.c_str()));
        }
        configFilemap.erase(it);
      }
    }

    if (selected.type == BackendType::GPU) {
      params.mmproj_backend = selected.name;
#ifdef __ANDROID__
      // QVAC-21867: auto-default the projector backend by GPU class.
      // Only Adreno 800+ is benchmarked (QVAC-21257) to encode the projector
      // faster on the mobile GPU than on CPU, so it is the only Android class
      // that defaults to GPU. Every other Android GPU class defaults to CPU
      // (the LLM layers still run on the GPU):
      //   - Mali: the projector encode is slower on the Mali GPU than on CPU
      //     (QVAC-21257 benchmarks).
      //   - Adreno < 800: materially weaker tiers the QVAC-21257
      //     projector-on-GPU benchmarks did not cover (conservative).
      //   - Any GPU whose Adreno tier can't be detected: conservative default.
      // Relax per class once those tiers are benchmarked. The mmproj-use-gpu
      // key overrides this either way.
      constexpr int kAdrenoMmprojGpuThreshold = 800;
      const bool isAdreno800Plus =
          result.adrenoVersion.has_value() &&
          result.adrenoVersion.value() >= kAdrenoMmprojGpuThreshold;
      bool mmprojUseGpu = isAdreno800Plus;
      const char* mmprojDefaultReason =
          isAdreno800Plus ? "auto-default, Adreno 800+"
                          : (selected.isMaliGpu
                                 ? "auto-default, Mali GPU"
                                 : (result.adrenoVersion.has_value()
                                        ? "auto-default, Adreno <800"
                                        : "auto-default, non-Adreno-800+ GPU"));
#else
      bool mmprojUseGpu = true;
      const char* mmprojDefaultReason = "auto-default";
#endif
      if (mmprojUseGpuOverride.has_value()) {
        mmprojUseGpu = mmprojUseGpuOverride.value();
      }
      QLOG_IF(
          Priority::INFO,
          string_format(
              "[LlamaModel] multimodal projector backend: %s (%s)\n",
              mmprojUseGpu ? "GPU" : "CPU",
              mmprojUseGpuOverride.has_value() ? "mmproj-use-gpu override"
                                               : mmprojDefaultReason));
      params.mmproj_use_gpu = mmprojUseGpu;

      // Row-split needs a backend that provides split buffers.
      // Degrade row -> layer to keep the model loadable. This is ROW-only by
      // design: qvac-fabric only demands split buffers under
      // LLAMA_SPLIT_MODE_ROW (src/llama-model.cpp make_gpu_buft_list), while
      // LLAMA_SPLIT_MODE_TENSOR goes through the meta device and needs none.
      // Routing tensor mode through this probe would silently degrade it to
      // 'layer' on every backend this package ships.
      if (splitMode == LLAMA_SPLIT_MODE_ROW &&
          !dependencies.gpuBackendSupportsRowSplit()) {
        QLOG_IF(
            Priority::WARNING,
            "[LlamaModel] split-mode 'row' is not supported by this GPU "
            "backend (no split-buffer support), falling back to split-mode "
            "'layer'\n");
        splitMode = LLAMA_SPLIT_MODE_LAYER;
      }

      params.split_mode = splitMode;
      result.runtimeBackendDevice = 1;

      if (splitMode != LLAMA_SPLIT_MODE_NONE && mainGpu.has_value()) {
        if (std::holds_alternative<int>(mainGpu.value())) {
          configFilemap["main-gpu"] =
              std::to_string(std::get<int>(mainGpu.value()));
        } else {
          QLOG_IF(
              Priority::WARNING,
              "[LlamaModel] main-gpu 'dedicated'/'integrated' ignored in "
              "multi-GPU split-mode; use an integer device index instead\n");
        }
      }
    } else if (selected.type == BackendType::CPU) {
      params.mmproj_use_gpu = false;
      if (mmprojUseGpuOverride.value_or(false)) {
        QLOG_IF(
            Priority::WARNING,
            "[LlamaModel] mmproj-use-gpu ignored: no GPU backend available, "
            "running the multimodal projector on CPU\n");
      }
      result.runtimeBackendDevice = 0;
      params.split_mode = LLAMA_SPLIT_MODE_NONE;
      params.main_gpu = -1;
      if (splitMode != LLAMA_SPLIT_MODE_NONE) {
        QLOG_IF(
            Priority::WARNING,
            "[LlamaModel] split-mode, tensor-split and main-gpu ignored: "
            "no GPU backend available, falling back to CPU\n");
        splitMode = LLAMA_SPLIT_MODE_NONE;
        configFilemap.erase("tensor-split");
      }
    } else {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InternalError,
          "preferredDeviceFromString: wrong deduced device, must be 'gpu' or "
          "'cpu'.\n");
    }
    // In multi-GPU split mode we intentionally omit --device so llama.cpp
    // distributes layers/rows across all available GPUs rather than pinning
    // to the single backend that chooseBackend selected.
    //
    // QVAC-24253: tensor mode is the exception and must pass an explicit list.
    // 'layer' and 'row' route through qvac-fabric's filtered device selection,
    // which excludes integrated GPUs unless they are all that is available and
    // dedupes a physical GPU registered by two backends. SPLIT_MODE_TENSOR
    // takes a different branch that does neither, so omitting --device there
    // splits weights and the KV cache onto the iGPU on any dGPU + iGPU host —
    // pacing the whole model by the weakest participant — and shards a
    // dual-registered GPU twice. main-gpu cannot correct it: fabric's pruning
    // is gated on split_mode == NONE, and string forms are dropped above.
    if (splitMode == LLAMA_SPLIT_MODE_NONE) {
      configVector.emplace_back("--device");
      configVector.emplace_back(selected.name);
    } else if (splitMode == LLAMA_SPLIT_MODE_TENSOR) {
      const std::vector<std::string> tensorDevices =
          dependencies.tensorSplitDeviceNames();
      if (tensorDevices.empty()) {
        // No enumerable GPU device: leave --device alone rather than emitting
        // an empty list, and let fabric's own selection and checks decide.
        QLOG_IF(
            Priority::WARNING,
            "[LlamaModel] split-mode 'tensor': no GPU device could be "
            "enumerated for an explicit device list; falling back to "
            "qvac-fabric's own device selection\n");
      } else {
        std::string deviceList;
        for (const std::string& device : tensorDevices) {
          if (!deviceList.empty()) {
            deviceList += ",";
          }
          deviceList += device;
        }
        configVector.emplace_back("--device");
        configVector.emplace_back(deviceList);
        QLOG_IF(
            Priority::INFO,
            string_format(
                "[LlamaModel] split-mode 'tensor': pinning to %zu device(s): "
                "%s\n",
                tensorDevices.size(),
                deviceList.c_str()));
      }
    }
    configFilemap.erase("device");

    isGpu = selected.type == BackendType::GPU;
    isOpenCl = isGpu && selected.name.find("opencl") != std::string::npos;
    isMetal = isGpu && (selected.name.find("metal") != std::string::npos ||
                        selected.name.rfind("mtl", 0) == 0);
  }

  tuneLoadConfigMap(
      configFilemap,
      metadata,
      result.adrenoVersion,
      finetuneOverrides,
      isOpenCl,
      isMetal,
      isGpu,
      // params.split_mode is already assigned above (and reset to NONE on CPU
      // fallback), so this is the mode fabric will actually see. Tensor mode
      // changes how 'auto' is classified for the q8_0 KV default — see the
      // comment on flashAttnEnabled.
      params.split_mode == LLAMA_SPLIT_MODE_TENSOR);

  // QVAC-24253: constraints qvac-fabric places on LLAMA_SPLIT_MODE_TENSOR.
  // Keyed on params.split_mode, not the local splitMode, because that is the
  // value actually handed to fabric: the GPU branch assigns it above and the
  // CPU-fallback branch resets it to NONE, so a tensor request that fell back
  // to CPU correctly skips every check here.
  //
  // Placed AFTER tuneLoadConfigMap on purpose: that call is what applies the
  // flash-attn defaults — on by default, and forced off when finetuning — so
  // this is the first point at which the effective value can be read. Moving
  // this block up into the GPU branch would see only a caller-supplied value
  // and miss both. (tuneLoadConfigMap also forces it off for BitNet, but that
  // path is unreachable here: "bitnet" is on the unsupported-architecture list
  // checked immediately below, so it throws before flash-attn is consulted.)
  if (params.split_mode == LLAMA_SPLIT_MODE_TENSOR) {
    if (!archSupportsTensorSplit(metadata)) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          string_format(
              "%s: split-mode 'tensor' is not supported for architecture '%s' "
              "by this qvac-fabric version; use split-mode 'layer'.\n",
              K_LEGACY_PARSER_NAME.data(),
              metadata.tryGetString("general.architecture")
                  .value_or("unknown")
                  .c_str()));
    }

    // qvac-fabric returns a null context (src/llama-context.cpp, "SPLIT_MODE_
    // TENSOR requires flash_attn to be enabled") rather than a diagnosable
    // error, so reject here instead of silently flipping a value the caller
    // set. AUTO is fine — fabric promotes it to ENABLED itself.
    //
    // Both key spellings must be checked, for the same reason
    // resolveFlashAttn does: when the caller passes flash_attn directly, none
    // of tuneLoadConfigMap's default branches fire, so the value is never
    // normalised into the hyphen key and stays under the underscore one until
    // the configVector loop rewrites it. Reading only "flash-attn" here would
    // let flash_attn=off through.
    //
    // The value spelling matters as much as the key spelling: fabric routes
    // --flash-attn through common_arg_utils::is_falsey, which accepts "off",
    // "disabled", "false" and "0" as equivalent, so comparing against "off"
    // alone would let the other three reach fabric in the state this guard
    // exists to prevent. is_falsey is called directly rather than mirrored, so
    // this guard and the two in tuneLoadConfigMap cannot drift apart. No case
    // folding, matching fabric — resolveFlashAttn has already rejected any
    // value outside the three sets, mixed case included.
    //
    // A contradictory { "flash-attn": …, "flash_attn": … } pair is likewise
    // already rejected by resolveFlashAttn, so at most one key is present by
    // the time this loop runs; it iterates both only to find whichever that is
    // and to name it accurately in the error.
    for (const char* flashAttnKey : {"flash-attn", "flash_attn"}) {
      const auto flashAttnIt = configFilemap.find(flashAttnKey);
      if (flashAttnIt == configFilemap.end()) {
        continue;
      }
      if (common_arg_utils::is_falsey(flashAttnIt->second)) {
        // Under finetuning tuneLoadConfigMap is what wrote flash-attn=off, so
        // telling the caller to remove a key they never set would misdirect
        // them.
        throw qvac_errors::StatusError(
            qvac_errors::general_error::InvalidArgument,
            finetuneOverrides.active
                ? string_format(
                      "%s: split-mode 'tensor' requires flash attention, which "
                      "is disabled while finetuning; use split-mode 'layer' "
                      "for finetuning runs.\n",
                      K_LEGACY_PARSER_NAME.data())
                : string_format(
                      "%s: split-mode 'tensor' requires flash attention; "
                      "remove %s=%s or use split-mode 'layer'.\n",
                      K_LEGACY_PARSER_NAME.data(),
                      flashAttnIt->first.c_str(),
                      flashAttnIt->second.c_str()));
      }
    }

    // Auto-fit is disabled for tensor mode, but the assignment itself lives
    // after the generic arg loop below — see the second tensor block.
  }

  // Handle both reverse-prompt variants
  for (const std::string& key : {"reverse-prompt", "reverse_prompt"}) {
    if (auto iter = configFilemap.find(key); iter != configFilemap.end()) {
      auto listString = iter->second;
      std::vector<std::string> list = split(listString, ',');
      for (const auto& item : list) {
        params.antiprompt.push_back(item);
      }
      if (list.empty() && !listString.empty()) {
        params.antiprompt.push_back(listString);
      }
      configFilemap.erase(iter);
    }
  }

  // transform json config into the format required by llama.cpp
  for (auto& keyValuePair : configFilemap) {
    configVector.push_back(std::string("--") + keyValuePair.first);
    if (!keyValuePair.second.empty()) {
      configVector.push_back(keyValuePair.second);
    }
  }

  auto ctxArg = common_params_parser_init(
      params, LLAMA_EXAMPLE_COMMON, [](int, char**) {});

  // disable warmup run
  params.warmup = false;
  params.training = finetuneOverrides.active;
  // add model path to  model parameters
  params.model.path = modelPath;

  int size = static_cast<int>(configVector.size());

  std::unordered_map<std::string, common_arg*> argToOptions;
  for (auto& opt : ctxArg.options) {
    for (const auto& arg : opt.args) {
      argToOptions[arg] = &opt;
    }
  }

  // handle config arguments
  auto checkArg = [&](int argIndex) {
    if (argIndex >= size) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          qvac_errors::general_error::toString(
              qvac_errors::general_error::InvalidArgument),
          "Expected value for argument");
    }
  };

  for (int argIndex = 0; argIndex < size; argIndex++) {
    const std::string argPrefix = "--";

    std::string arg = configVector.at(argIndex);
    if (arg.starts_with(argPrefix)) {
      std::ranges::replace(arg, '_', '-');
    }
    if (argToOptions.find(arg) == argToOptions.end()) {
      std::string errorMsg = string_format(
          "%s: invalid argument: %s\n",
          K_LEGACY_PARSER_NAME.data(),
          arg.c_str());
      throw qvac_errors::StatusError(
          ADDON_ID,
          qvac_errors::general_error::toString(
              qvac_errors::general_error::InvalidArgument),
          errorMsg);
    }
    auto opt = *argToOptions[arg];
    if (opt.has_value_from_env()) {
      QLOG_IF(
          Priority::DEBUG,
          string_format(
              "%s: %s variable is set, but will be overwritten by argument "
              "%s\n",
              K_LEGACY_PARSER_NAME.data(),
              opt.env,
              arg.c_str()));
    }
    try {
      if (opt.handler_void != nullptr) {
        opt.handler_void(params);
        continue;
      }

      // arg with single value
      checkArg(argIndex);
      const std::string& val = configVector[++argIndex];
      if (opt.handler_int != nullptr) {
        opt.handler_int(params, std::stoi(val));
        continue;
      }
      if (opt.handler_string != nullptr) {
        opt.handler_string(params, val);
        continue;
      }

      // arg with 2 values
      checkArg(argIndex);
      const std::string& val2 = configVector[++argIndex];
      if (opt.handler_str_str != nullptr) {
        opt.handler_str_str(params, val, val2);
        continue;
      }
    } catch (std::exception& e) {
      std::string errorMsg = string_format(
          "%s: error while handling argument \"%s\": %s\n\n",
          K_LEGACY_PARSER_NAME.data(),
          arg.c_str(),
          e.what());
      throw qvac_errors::StatusError(
          ADDON_ID,
          qvac_errors::general_error::toString(
              qvac_errors::general_error::InvalidArgument),
          errorMsg);
    }
  }

  // QVAC-24253: auto-fit is disabled for tensor mode HERE, after the generic
  // arg loop, not in the constraint block above. qvac-fabric registers
  // `--fit [on|off]` as a common arg with no example restriction, so it is
  // reachable through this addon's passthrough: a caller passing
  // { "split-mode": "tensor", "fit": "on" } would otherwise have the loop set
  // fit_params back to true after the block cleared it, making the notice
  // below a lie and leaving the caller with fabric's own spurious "failed to
  // fit params to free device memory" WARN — the exact output this is meant
  // to prevent. Assigning after the loop makes the override authoritative.
  //
  // WARNING rather than INFO deliberately: every sibling "we overrode your
  // setting" notice in this function is WARNING, and the library's default
  // verbosity suppresses INFO entirely, so at INFO the one message carrying a
  // real OOM consequence would be invisible by default.
  if (params.split_mode == LLAMA_SPLIT_MODE_TENSOR) {
    params.fit_params = false;
    QLOG_IF(
        Priority::WARNING,
        "[LlamaModel] split-mode 'tensor': auto-fit is not available in this "
        "mode and has been disabled; gpu_layers defaults to every layer and "
        "ctx_size to the model's trained context unless set explicitly\n");
  }

  postprocess_cpu_params(params.cpuparams, nullptr);
  postprocess_cpu_params(params.cpuparams_batch, &params.cpuparams);

  if (!params.kv_overrides.empty()) {
    params.kv_overrides.emplace_back();
    params.kv_overrides.back().key[0] = 0;
  }

  if (!params.tensor_buft_overrides.empty()) {
    params.tensor_buft_overrides.push_back({nullptr, nullptr});
  }

  if (!params.chat_template.empty() &&
      !common_chat_verify_template(params.chat_template, params.use_jinja)) {
    std::string errorMsg = string_format(
        "%s: the supplied chat template is not supported: %s%s\n",
        K_LEGACY_PARSER_NAME.data(),
        params.chat_template.c_str(),
        params.use_jinja ? ""
                         : "\nnote: llama.cpp was started without --jinja, "
                           "we only support commonly used templates");
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        errorMsg);
  }

  constexpr int kMinNCtx = 8;
  if (params.n_ctx != 0 && params.n_ctx < kMinNCtx) {
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "%s: warning: minimum context size is 8, using minimum size.\n",
            K_LEGACY_PARSER_NAME.data()));
    params.n_ctx = kMinNCtx;
  }
  if (params.rope_freq_base != 0.0) {
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "%s: changing RoPE frequency base to %g.\n",
            K_LEGACY_PARSER_NAME.data(),
            params.rope_freq_base));
  }
  if (params.rope_freq_scale != 0.0) {
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "%s: scaling RoPE frequency by %g.\n",
            K_LEGACY_PARSER_NAME.data(),
            params.rope_freq_scale));
  }

  result.fitSnapshot =
      makeNormalizedFitSnapshot(result.params, trainedContext(metadata));
  return result;
}

} // namespace load_fit_normalization
