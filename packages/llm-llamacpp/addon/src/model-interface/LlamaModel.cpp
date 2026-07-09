#include "LlamaModel.hpp"

#include <algorithm>
#include <cctype>
#include <charconv>
#include <cinttypes>
#include <cstddef>
#include <filesystem>
#include <mutex>
#include <optional>
#include <shared_mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_set>
#include <vector>

#include <common/arg.h>
#include <common/chat.h>
#include <common/common.h>
#include <common/log.h>
#include <inference-addon-cpp/Errors.hpp>
#include <llama.h>
#ifdef __APPLE__
#include <TargetConditionals.h>
#endif
#include <llama/mtmd/mtmd.h>
#include <picojson/picojson.h>

#include "BatchEntryGuard.hpp"
#include "MediaLoadOrder.hpp"
#include "MtmdLlmContext.hpp"
#include "TextLlmContext.hpp"
#include "addon/LlmErrors.hpp"
#include "inference-addon-cpp/LlamacppUtils.hpp"
#include "utils/BackendSelection.hpp"
#include "utils/ChatTemplateUtils.hpp"
#include "utils/LoggingMacros.hpp"
#include "utils/ScopeGuard.hpp"
#include "utils/SharedSnapshot.hpp"

using namespace qvac_lib_inference_addon_llama::errors;
using namespace qvac_lib_inference_addon_cpp::logger;
using namespace qvac_lib_inference_addon_llama::logging;

/// @brief Persist the active KV cache to disk when the caller opted in via
/// `saveCacheToDisk`. Shared by the prefill and post-generation paths so
/// both honour the option identically. No-op when no cache is active.
static void maybeSaveCacheToDisk(
    bool saveCacheToDisk, std::optional<CacheManager>& cacheManager) {
  if (saveCacheToDisk && cacheManager.has_value() &&
      cacheManager->hasActiveCache()) {
    cacheManager->saveCache();
  }
}

static std::vector<std::string> split(const std::string& str, char delimiter) {
  auto trim = [](const std::string& str) -> std::string {
    auto start =
        std::find_if(str.begin(), str.end(), [](unsigned char character) {
          return std::isspace(character) == 0;
        });

    if (start == str.end()) {
      return "";
    }

    auto end =
        std::find_if(str.rbegin(), str.rend(), [](unsigned char character) {
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

void LlamaModel::resolveShardPaths(
    GGUFShards& shards, const std::string& modelPath) {
  if (shards.gguf_files.empty())
    return;
  auto baseDir = std::filesystem::path(modelPath).parent_path();
  if (baseDir.empty())
    return;
  for (auto& f : shards.gguf_files)
    f = (baseDir / f).string();
  shards.tensors_file = (baseDir / shards.tensors_file).string();
}

void LlamaModel::tuneConfigMap(
    std::unordered_map<std::string, std::string>& configFilemap,
    const ModelMetaData& metadata, const std::optional<int>& adrenoVersion,
    const FinetuneConfigOverrides& finetuneOverrides, bool isOpenCl,
    bool isMetal, bool isGpu) {

  const bool isFinetuning = finetuneOverrides.active;

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
  // Shared inputs, computed once (flash-attn is already resolved above).
  // flash-attn is read from BOTH the hyphen and underscore keys: a caller may
  // pass flash_attn=on directly, and the underscore->hyphen normalization only
  // happens later in the configVector loop — so check both here, otherwise the
  // auto-default and the Adreno reject guard below would be silently skipped.
  constexpr int kAdrenoKvQuantThreshold = 800;
  auto valueIs =
      [&](const char* hyphenKey, const char* underscoreKey, const char* want) {
        auto it = configFilemap.find(hyphenKey);
        if (it == configFilemap.end())
          it = configFilemap.find(underscoreKey);
        return it != configFilemap.end() && it->second == want;
      };
  const bool flashAttnOn = valueIs("flash-attn", "flash_attn", "on");
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
  // (sliding context / context management) abort natively in
  // llama_kv_cache::update on Adreno, so f16 stays the safe default — and
  // block 3 now *rejects* any explicit quantized KV on OpenCL (q8_0 and q4_0
  // both crash on a shift). Also skipped for finetuning (manages its own KV
  // types), when flash attention is off (V-cache quantization requires it), and
  // on Adreno+Vulkan (see above).
  if (!isFinetuning && isGpu && !isOpenCl && flashAttnOn && !isAdrenoVulkan &&
      notUserSet("cache-type-k", "cache_type_k") &&
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
  if (isAdrenoVulkan && flashAttnOn) {
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
  // dequantize->RoPE->requantize copy on every KV-cache *shift* (sliding
  // context / context management), and ggml-opencl has no F32->quantized copy
  // kernel for that requantize step — so the shift aborts natively in
  // llama_kv_cache::update on Adreno. Confirmed for BOTH q8_0 and q4_0 (CI run
  // 28448086915: S25/S26 crash on a q4_0 sliding shift; Mali Vulkan passes).
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
                "cache management (sliding context, state restore) — "
                "ggml-opencl has no F32->quantized copy kernel for the "
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

LlamaModel::LlamaModel(
    std::string&& modelPath, std::string&& projectionPath,
    std::unordered_map<std::string, std::string>&& configFilemap)
    : loadingContext_(InitLoader::getLoadingContext("LlamaModel")),
      constructionArgs_{
          std::move(modelPath),
          std::move(projectionPath),
          std::move(configFilemap)} {
  setInitLoader(InitLoader::LOADER_TYPE::DELAYED);
}

void LlamaModel::reload(
    std::optional<FinetuneConfigOverrides> newFinetuneOverrides) {
  {
    std::shared_lock lock(stateMtx_);
    if (state_->asyncWeightsLoader_.isStreaming()) {
      // TODO: Make Fabric support moving/streaming existing loaded tensors
      // TODO: to a different backend.
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(ReloadNotSupportedForStreamedModel),
          "Cannot reload a model that was loaded via streamed shards; "
          "the streamed weights have already been consumed.");
    }
  }
  setInitLoader(InitLoader::LOADER_TYPE::IMMEDIATE, newFinetuneOverrides);
}

void LlamaModel::setInitLoader(
    std::optional<InitLoader::LOADER_TYPE> loaderType,
    std::optional<FinetuneConfigOverrides> newFinetuneOverrides) {
  cancel();
  std::unique_lock lock(stateMtx_);
  // Unconditionally stop the old contexts before destroying them, regardless
  // of job counters. cancel() above only routes to active engines (counters >
  // 0), but reload() must clean up *any* residual state in the old context
  // (e.g. after finetuning, which doesn't increment the counters) before
  // discarding it. Without this, stale stop flags or other state can survive
  // into the next operation and cause decode failures.
  if (state_) {
    if (state_->batchScheduler_) {
      state_->batchScheduler_->requestCancelAll();
    }
    if (state_->llmContext_) {
      state_->llmContext_->stop();
    }
  }
  if (newFinetuneOverrides.has_value()) {
    pendingFinetuneOverrides_ = *newFinetuneOverrides;
  }
  if (loaderType.has_value()) {
    constructionArgs_.loaderType = loaderType.value();
  }
  state_ = std::make_shared<ReloadableState>(
      constructionArgs_, loadingContext_, metadata_);
  bool callerHoldsLock =
      constructionArgs_.loaderType == InitLoader::LOADER_TYPE::IMMEDIATE;
  state_->initLoader_.init(
      constructionArgs_.loaderType,
      [this, acquireLock = !callerHoldsLock]() { this->init(acquireLock); });
}

void LlamaModel::init(bool acquireLock) {
  SharedSnapshot snap(state_, stateMtx_);
  if (!acquireLock) {
    snap.disable();
  }
  snap.lockRead();

  // Defensive guard: not reachable under normal usage because reload() is
  // only called after waitForLoadInitialization() returns, at which point the
  // delayed init callback has already completed. Protects against a misuse
  // scenario where reload() races with the initial delayed load.
  if (snap->llmContext_) {
    return;
  }

  const auto& modelPath = constructionArgs_.modelPath;
  auto configFilemap = constructionArgs_.configFilemap;

  setVerbosityLevel(configFilemap);

  if (!snap->asyncWeightsLoader_.isStreaming()) {
    if (!snap.promoteToWrite()) {
      return;
    }
    resolveShardPaths(snap->shards_, modelPath);
    snap.demoteToRead();
  }

  metadata_.parse(
      modelPath,
      snap->shards_,
      snap->asyncWeightsLoader_.isStreaming(),
      ADDON_ID);
  {
    auto fileType = metadata_.tryGetU32("general.file_type");
    QLOG_IF(
        Priority::DEBUG,
        string_format(
            "[LlamaModel] general.file_type = %s\n",
            fileType.has_value() ? std::to_string(*fileType).c_str()
                                 : "unknown"));
  }

  if (!snap.promoteToWrite()) {
    return;
  }

  {
    std::string backendsDir;
    if (auto it = configFilemap.find("backendsDir");
        it != configFilemap.end()) {
      backendsDir = it->second;
      configFilemap.erase(it);
    }
    std::string openclCacheDir;
    if (auto it = configFilemap.find("openclCacheDir");
        it != configFilemap.end()) {
      openclCacheDir = it->second;
      configFilemap.erase(it);
    }
    snap->backendsHandle_ = LlamaBackendsHandle(backendsDir, openclCacheDir);
  }

  common_params params;
  std::optional<int> adrenoVersion;
  ResolvedToolsCompactConfig toolsCompactConfig;
  commonParamsParse(
      modelPath, configFilemap, params, adrenoVersion, toolsCompactConfig);

  const std::string errorWhenFailed = toString(UnableToLoadModel);
  auto streamedFiles =
      snap->asyncWeightsLoader_.extractIndividualStreamedFiles();

  snap.demoteToRead();

  common_init_result_ptr llamaInit = initFromConfig(
      params,
      modelPath,
      streamedFiles,
      snap->shards_,
      loadingContext_,
      snap->asyncWeightsLoader_.isStreaming(),
      ADDON_ID,
      errorWhenFailed);

  if (!snap.promoteToWrite()) {
    return;
  }

  // Create tools compact controller before context (contexts hold reference)
  snap->toolsCompact_ =
      std::make_unique<ToolsCompactController>(toolsCompactConfig.profile);

  snap->isTextLlm_ = constructionArgs_.projectionPath.empty();
  snap->llmContext_ = createContext(
      std::string(constructionArgs_.projectionPath),
      params,
      std::move(llamaInit),
      *snap->toolsCompact_);

  if (snap->configuredNDiscarded_ > 0 && snap->llmContext_) {
    snap->llmContext_->setNDiscarded(snap->configuredNDiscarded_);
  }

  if (snap->llmContext_) {
    snap->cacheManager_.emplace(
        snap->llmContext_.get(),
        snap->configuredNDiscarded_,
        [this](bool resetStats) { this->resetState(resetStats); });
  }

  if (isMultiBatchActivated(*snap)) {
    snap->batchScheduler_ = initBatchScheduler(*snap);
  }
}

bool LlamaModel::isMultiBatchActivated(ReloadableState& state) {
  return state.llmContext_ && llama_n_seq_max(state.llmContext_->getCtx()) > 1;
}

namespace {

// Single source of truth for per-slot driver selection. The model layer owns
// this decision because driver construction needs model-owned handles (the
// shared llama context and the already-loaded mmproj); the scheduler stays
// agnostic of any concrete driver type. `sharedVision` is the loaded mmproj
// (`state.llmContext_` outlives the scheduler, see ReloadableState
// declaration order); null for text-only contexts selects the text driver.
// Capability is queried via `visionContext()` rather than an RTTI cast, so a
// future multimodal context is picked up without inheriting MtmdLlmContext.
batching::DriverFactory
buildDriverFactory(LlmModelContext shared, mtmd_context* sharedVision) {
  return [shared, sharedVision](
             const common_params& params,
             ToolsCompactController& tools,
             uint32_t seqId,
             llama_pos perSeqCtxCeiling) -> std::unique_ptr<SequenceDriver> {
    const auto sid = static_cast<llama_seq_id>(seqId);
    if (sharedVision != nullptr) {
      return std::make_unique<MtmdLlmContext>(
          params, shared, tools, sharedVision, sid, perSeqCtxCeiling);
    }
    return std::make_unique<TextLlmContext>(
        params, shared, tools, sid, perSeqCtxCeiling);
  };
}

} // namespace

std::unique_ptr<batching::ContinuousBatchScheduler>
LlamaModel::initBatchScheduler(ReloadableState& state) {
  llama_context* ctx = state.llmContext_->getCtx();
  llama_model* mdl = state.llmContext_->getModel();
  const common_params& cparams = state.llmContext_->getParams();
  const auto batchSize = static_cast<size_t>(llama_n_seq_max(ctx));
  const auto ctxTotalTokens = static_cast<unsigned>(llama_n_ctx(ctx));
  const auto batchCapacity = static_cast<int32_t>(cparams.n_batch);
  const auto maxChunkSize = static_cast<unsigned>(cparams.n_ubatch);
  LlmModelContext shared{
      .model = mdl,
      .lctx = ctx,
      .vocab = mdl != nullptr ? llama_model_get_vocab(mdl) : nullptr,
  };
  return std::make_unique<batching::ContinuousBatchScheduler>(
      shared,
      maxChunkSize,
      ctxTotalTokens,
      batchSize,
      batchCapacity,
      cparams,
      state.configuredNDiscarded_,
      state.toolsCompact_ ? state.toolsCompact_->profile() : std::nullopt,
      buildDriverFactory(shared, state.llmContext_->visionContext()));
}

void LlamaModel::setWeightsForFile(
    const std::string& filename,
    std::unique_ptr<std::basic_streambuf<char>>&& shard) {
  std::shared_lock lock(stateMtx_);
  state_->asyncWeightsLoader_.setWeightsForFile(filename, std::move(shard));
}

bool LlamaModel::isLoaded() {
  std::shared_lock lock(stateMtx_);
  return static_cast<bool>(state_->llmContext_);
}

llama_pos LlamaModel::getNPastBeforeTools() const {
  std::shared_lock lock(stateMtx_);
  if (state_->toolsCompact_) {
    return state_->toolsCompact_->anchor();
  }
  return -1;
}

llama_context* LlamaModel::getContext() {
  if (!state_->llmContext_) {
    return nullptr;
  }
  return state_->llmContext_->getCtx();
}

llama_model* LlamaModel::getModel() {
  if (!state_->llmContext_) {
    return nullptr;
  }
  return state_->llmContext_->getModel();
}

common_params& LlamaModel::getCommonParams() {
  if (!state_->llmContext_) {
    throw std::runtime_error("Model context not initialized");
  }
  return state_->llmContext_->getParams();
}

void LlamaModel::llamaLogCallback(
    ggml_log_level level, const char* text, void* userData) {
  (void)userData;
  // Convert ggml_log_level to QLOG Priority
  Priority priority = Priority::DEBUG;
  switch (level) {
  case GGML_LOG_LEVEL_ERROR:
    priority = Priority::ERROR;
    break;
  case GGML_LOG_LEVEL_WARN:
    priority = Priority::WARNING;
    break;
  case GGML_LOG_LEVEL_INFO:
    priority = Priority::INFO;
    break;
  case GGML_LOG_LEVEL_DEBUG:
  case GGML_LOG_LEVEL_NONE:
  case GGML_LOG_LEVEL_CONT:
  default:
    priority = Priority::DEBUG;
    break;
  }

  // Only log if the message priority is at or above the configured verbosity
  // level
  QLOG_IF(priority, string_format("[Llama.cpp] %s", text));
}

void LlamaModel::cancel() const {
  std::shared_lock lock(stateMtx_, std::try_to_lock);
  if (!lock.owns_lock()) {
    // If lock could not be acquired, it means reload
    // is in progress. It would be pointless to cancel
    // after it finishes reloading since there would be
    // nothing executing.
    return;
  }
  cancelImpl();
}

void LlamaModel::cancelImpl() const {
  // Guarded by the run counters, never by the scheduler's `hasWork()`:
  // the per-token streaming callback runs on the scheduler's worker
  // thread while it holds the scheduler `mutex_`, so any locking
  // scheduler method called from a cancel issued inside that callback
  // self-deadlocks. The counters are also what keeps cancel state
  // isolated per engine: only the engine with work in flight gets its
  // stop flag set, so an idle engine never carries a stale flag into
  // its next run.
  if (state_ && state_->batchScheduler_ && activeBatchJobs_.load() > 0) {
    state_->batchScheduler_->requestCancelAll();
  }
  if (state_ && state_->llmContext_ && activeSingleJobs_.load() > 0) {
    state_->llmContext_->stop();
  }
}

std::any LlamaModel::process(const std::any& input) {
  std::shared_lock lock(stateMtx_);
  if (input.type() != typeid(Prompt) &&
      input.type() != typeid(std::vector<Prompt>)) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(qvac_errors::general_error::InvalidArgument),
        "Invalid input type");
  }
  if (input.type() == typeid(std::vector<Prompt>)) {
    const auto& prompts = std::any_cast<const std::vector<Prompt>&>(input);
    return {processPromptBatchImpl(prompts)};
  }
  validateBitnetQuantization();
  const auto& prompt = std::any_cast<const Prompt&>(input);
#ifndef STANDALONE_TEST_BUILD
  if (prompt.finetuningParams.has_value()) {
    FinetuneTerminalResult::Stats stats{};
    // Release the shared lock before finetune() because reload() inside it
    // acquires an exclusive lock on stateMtx_; safe since JobRunner serialises
    // all jobs onto a single worker thread.
    lock.unlock();
    std::string status = finetuner_.finetune(
        *prompt.finetuningParams, &stats, prompt.progressCallback);
    FinetuneTerminalResult result{"finetune", std::move(status)};
    if (stats.globalSteps > 0 || stats.epochsCompleted > 0) {
      result.stats = stats;
    }
    return std::any(std::move(result));
  }
#else
  if (prompt.finetuningParams.has_value()) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(qvac_errors::general_error::InvalidArgument),
        "Finetuning not available in standalone test build");
  }
#endif
  return {processPromptImpl(prompt)};
}

LlamaModel::ResolvedPrompt
LlamaModel::resolveChatAndTools(const Prompt& prompt) {
  ResolvedPrompt resolved;
  // Load all prompt media (hoisted byte buffers and inline paths) in
  // prompt-marker order so each bitmap binds to its own MTMD marker.
  auto loadPlannedMedia = [this, &prompt](const ParsedPromptPayload& parsed) {
    if (state_->isTextLlm_ && !parsed.mediaPlan.empty()) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(MediaNotSupported),
          "Media not supported by text-only models");
    }
    validateByteBufferCount(parsed.mediaPlan, prompt.media.size());
    for (const auto& step : computeMediaLoadOrder(parsed.mediaPlan)) {
      if (step.source == MediaSource::ByteBuffer) {
        loadMedia(prompt.media[step.byteIndex]);
      } else {
        state_->llmContext_->loadMedia(step.path);
      }
    }
  };
  if (state_->cacheManager_.has_value()) {
    ParsedPromptPayload parsedPrompt;
    resolved.isCacheLoaded = state_->cacheManager_->handleCache(
        parsedPrompt,
        prompt.input,
        [this](const std::string& inputPrompt) {
          return this->formatPrompt(inputPrompt);
        },
        prompt.cacheKey);
    loadPlannedMedia(parsedPrompt);
    resolved.chatMsgs = std::move(parsedPrompt.chatMsgs);
    resolved.tools = std::move(parsedPrompt.tools);
    resolved.layout = std::move(parsedPrompt.layout);
    resolved.shouldResetAfterInference =
        state_->cacheManager_->isCacheDisabled() ||
        !state_->cacheManager_->wasCacheUsedInLastPrompt();
  } else {
    ParsedPromptPayload parsedPrompt = formatPrompt(prompt.input);
    loadPlannedMedia(parsedPrompt);
    resolved.chatMsgs = std::move(parsedPrompt.chatMsgs);
    resolved.tools = std::move(parsedPrompt.tools);
    resolved.layout = std::move(parsedPrompt.layout);
    resolved.shouldResetAfterInference = true;
  }
  return resolved;
}

std::string LlamaModel::processPrompt(const Prompt& prompt) {
  std::shared_lock lock(stateMtx_);
  return processPromptImpl(prompt);
}

std::string LlamaModel::processPromptImpl(const Prompt& prompt) {
  activeSingleJobs_.fetch_add(1);
  ScopeGuard jobGuard([this] { activeSingleJobs_.fetch_sub(1); });
  state_->lastRun_ = {};
  state_->lastRun_.wasPrefill = prompt.prefill;
  if (state_->batchScheduler_) {
    state_->batchScheduler_->resetRuntimeStats();
  }

  // Reset per-inference counters so they don't leak across runs.
  state_->llmContext_->resetNSlides();
  state_->llmContext_->resetThinkingBlockDiscards();
  state_->llmContext_->resetVisionEncodeMs();

  // Prompt media (both hoisted byte buffers and inline paths) is loaded by
  // resolveChatAndTools in prompt-marker order; see computeMediaLoadOrder.
  std::string out;
  ResolvedPrompt resolved = resolveChatAndTools(prompt);

  if (resolved.shouldResetAfterInference &&
      state_->llmContext_->getNPast() > 0) {
    resetState(true);
  }

  bool hasKvCacheContext = resolved.isCacheLoaded;
  if (state_->llmContext_->getNPast() > 0) {
    hasKvCacheContext = true;
  }

  auto resetAndInvalidateActiveCache = [this]() {
    resetState(false);
    if (state_->cacheManager_.has_value()) {
      state_->cacheManager_->invalidate();
    }
  };

  bool shouldSaveCache = false;
  bool shouldResetAfterInference = false;
  state_->llmContext_->validatePromptPolicy(
      resolved.chatMsgs, resolved.tools, resolved.layout, hasKvCacheContext);

  if (resolved.chatMsgs.empty() && resolved.tools.empty()) {
    QLOG_IF(Priority::INFO, "No messages to process - returning early\n");
    return out;
  }

  auto restore =
      state_->llmContext_->applyGenerationParams(prompt.generationParams);

  try {
    ScopeGuard paramsGuard([&] { restore(); });

    const LlmContext::EvalMessageResult evalResult =
        resolved.tools.empty()
            ? state_->llmContext_->evalMessage(
                  resolved.chatMsgs, resolved.isCacheLoaded, prompt.prefill)
            : state_->llmContext_->evalMessageWithTools(
                  resolved.chatMsgs,
                  resolved.tools,
                  resolved.isCacheLoaded,
                  prompt.prefill);

    if (!evalResult.ok) {
      QLOG_IF(
          Priority::DEBUG,
          "Inference was interrupted during prompt evaluation\n");
      if (!evalResult.rollbackOk) {
        resetAndInvalidateActiveCache();
      }
      return out;
    }

    if (prompt.prefill) {
      // On prefill, no logits are accessed so llama.cpp's synchronize() is
      // never triggered. Force it here so t_p_eval_ms is committed to the perf
      // context before the caller reads runtimeStats().
      llama_synchronize(state_->llmContext_->getCtx());
      shouldSaveCache = true;
    } else {
      std::ostringstream oss;
      auto callback = prompt.outputCallback;
      if (!prompt.outputCallback) {
        callback = [&](const std::string& token) { oss << token; };
      }

      const LlmContext::GenerateResponseResult generationResult =
          state_->llmContext_->generateResponse(callback);
      if (!generationResult.ok) {
        resetState();
        std::string errorMsg =
            string_format("%s: context overflow\n", __func__);
        throw qvac_errors::StatusError(
            ADDON_ID, toString(ContextOverflow), errorMsg);
      }

      if (!prompt.outputCallback) {
        out = oss.str();
      }

      if (generationResult.rollbackOk) {
        shouldSaveCache = true;
        shouldResetAfterInference = resolved.shouldResetAfterInference;
      } else {
        // The driver could not prove the live recurrent state was rolled back
        // to the pre-request cursor. Skipping this prompt's save protects the
        // file immediately, but the active cache session must also be dropped:
        // otherwise a later same-key prompt could reuse dirty live state, or a
        // cache-key transition could save that dirty state under the old key.
        resetAndInvalidateActiveCache();
      }
    }
  } catch (...) {
    // Once `handleCache()` has activated or loaded a cache session, any thrown
    // eval / generation failure must leave no active session behind. In
    // particular, strict `remove_thinking_from_context` compaction failures
    // throw after local rollback/wipe; keeping the old cacheKey active would
    // let a later prompt reuse or auto-save that recovery state over the last
    // known-good on-disk cache. Do not catch policy-validation failures before
    // admission; explicit save failures below have their own cleanup gate.
    resetAndInvalidateActiveCache();
    throw;
  }

  if (shouldSaveCache) {
    try {
      maybeSaveCacheToDisk(prompt.saveCacheToDisk, state_->cacheManager_);
    } catch (...) {
      // The request completed, but the active cache key could not be flushed.
      // Drop both live state and the active cache session so the next prompt
      // does not retry the same failing path or keep using an unsaved session.
      resetAndInvalidateActiveCache();
      throw;
    }
  }

  if (shouldResetAfterInference) {
    resetState(false);
  }
  return out;
}

std::vector<std::string>
LlamaModel::processPromptBatch(const std::vector<Prompt>& prompts) {
  std::shared_lock lock(stateMtx_);
  return processPromptBatchImpl(prompts);
}

bool LlamaModel::supportsBatching() const {
  std::shared_lock lock(stateMtx_);
  return state_ && isMultiBatchActivated(*state_);
}

std::vector<std::string>
LlamaModel::processPromptBatchImpl(const std::vector<Prompt>& prompts) {
  // Serialize the entry section (prior-count check, cache invalidation, KV
  // wipe) under batchEntryMutex_. Without it a second caller can see
  // activeBatchJobs_ == 0 before the first caller increments it, skip the wipe,
  // and reach scheduler.processBatch() while the first caller is still clearing
  // KV — wiping the second caller's sequences. The lock is released before
  // scheduler.processBatch() so concurrent batch calls still overlap during
  // generation; jobGuard outlives the lock so its decrement spans the whole
  // job.
  std::optional<batching::BatchEntryGuard> jobGuard;
  {
    std::lock_guard<std::mutex> entryLock(state_->batchEntryMutex_);
    jobGuard.emplace(
        activeBatchJobs_, [this] { validateBitnetQuantization(); });
    const unsigned priorBatchJobs = jobGuard->prior();
    state_->lastRun_ = {};
    state_->lastRun_.wasBatch = true;

    // Invalidate single-prompt cache state and clear any stale KV left by
    // single-prompt runs so the batch scheduler starts on clean KV. Only the
    // first batch job entering does this: while another batch job is already in
    // flight the scheduler owns the live KV slots, and an unconditional wipe
    // here would clear that active job's sequences before its own admission.
    if (priorBatchJobs == 0) {
      if (state_->cacheManager_.has_value()) {
        state_->cacheManager_->invalidate();
      }
      if (llama_context* lctx = getContext(); lctx != nullptr) {
        if (llama_memory_t mem = llama_get_memory(lctx); mem != nullptr) {
          const int nSeqMax = llama_n_seq_max(lctx);
          for (int seqId = 0; seqId < nSeqMax; seqId++) {
            llama_memory_seq_rm(mem, static_cast<llama_seq_id>(seqId), -1, -1);
          }
        }
      }
    }
  }

  if (prompts.empty()) {
    return {};
  }

  if (!state_->batchScheduler_) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(qvac_errors::general_error::InvalidArgument),
        "Model is not configured for continuous batching: requires "
        "n_seq_max > 1");
  }
  auto& scheduler = *state_->batchScheduler_;

  std::vector<batching::SubmitRequest> requests;
  requests.reserve(prompts.size());
  std::unordered_set<std::string> saveCacheKeys;
  for (size_t i = 0; i < prompts.size(); i++) {
    const Prompt& prompt = prompts[i];
    if (prompt.saveCacheToDisk && !prompt.cacheKey.empty() &&
        !saveCacheKeys.insert(prompt.cacheKey).second) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(qvac_errors::general_error::InvalidArgument),
          "processPromptBatch: duplicate cacheKey '" + prompt.cacheKey +
              "' with saveCacheToDisk in the same batch would overwrite "
              "itself; each saved cache must use a distinct key");
    }
    if (!prompt.media.empty() && state_->isTextLlm_) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(qvac_errors::general_error::InvalidArgument),
          "processPromptBatch: media requires a multimodal model");
    }
    if (prompt.finetuningParams.has_value()) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(qvac_errors::general_error::InvalidArgument),
          "processPromptBatch: finetuning is not a batch processing operation");
    }
    ParsedPromptPayload parsed = formatPrompt(prompt.input);
    if (parsed.chatMsgs.empty()) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(EmptyPrompt),
          "processPromptBatch: prompt produced no chat messages");
    }
    if (!parsed.mediaPaths.empty() && state_->isTextLlm_) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(qvac_errors::general_error::InvalidArgument),
          "processPromptBatch: media requires a multimodal model");
    }
    batching::SubmitRequest sr;
    sr.chatMsgs = std::move(parsed.chatMsgs);
    sr.tools = std::move(parsed.tools);
    sr.layout = std::move(parsed.layout);
    sr.media = prompt.media;
    sr.mediaPlan = std::move(parsed.mediaPlan);
    sr.prefill = prompt.prefill;
    sr.cacheKey = prompt.cacheKey;
    sr.saveCacheToDisk = prompt.saveCacheToDisk;
    sr.overrides = prompt.generationParams;
    sr.streams.onToken = [userCb = prompt.outputCallback](
                             [[maybe_unused]] uint32_t seqId,
                             const std::string& piece) {
      if (userCb) {
        userCb(piece);
      }
    };

    requests.push_back(std::move(sr));
  }

  batching::BatchResult result = scheduler.processBatch(std::move(requests));

  return result.outputs;
}

qvac_lib_inference_addon_cpp::RuntimeStats LlamaModel::runtimeStats() const {
  std::shared_lock lock(stateMtx_);
  if (state_->lastRun_.wasBatch && state_->batchScheduler_) {
    return batchRuntimeStatsLocked();
  }
  return singleRuntimeStatsLocked();
}

qvac_lib_inference_addon_cpp::RuntimeStats
LlamaModel::batchRuntimeStatsLocked() const {
  // Pull the live snapshot from the scheduler. It already aggregates
  // across every `processBatch` caller in the current idle epoch
  // (`stats_.reset()` only fires when the queue is both empty and has no
  // in-flight work), so this composes correctly with multiple queued /
  // in-flight batches without LlamaModel having to cache state.
  const batching::RuntimeStatsSnapshot stats =
      state_->batchScheduler_->runtimeStats();
  // TTFT comes from the scheduler's prefill-step timer rather than
  // `llama_perf_context().t_p_eval_ms`, which would include the
  // recurrent replay decode run by `compactThinkSpan` in
  // `onGenerationFinished`. We still reset the live counters so they
  // can't leak into the next single-prompt run.
  llama_perf_context_reset(state_->llmContext_->getCtx());
  return {
      {"TTFT", stats.prefillTimeMs()},
      {"TPS", stats.decodeTokensPerSecond()},
      {"ppTPS", stats.prefillTokensPerSecond()},
      {"CacheTokens", stats.cacheTokens},
      {"generatedTokens", stats.generatedTokens},
      {"promptTokens", stats.promptTokens},
      {"contextSlides", stats.contextSlides},
      {"thinkingBlockDiscards", stats.thinkingBlockDiscards},
      // visionEncodeMs/Tiles intentionally omitted in batch mode: multiple
      // prompts share the one per-context accumulator (reset per prompt), so a
      // per-batch value would be misattributed / racy. See singleRuntimeStats.
      {"avgConcurrentSeq", stats.avgConcurrentSeq()},
      {"backendDevice", runtimeBackendDevice_}};
}

qvac_lib_inference_addon_cpp::RuntimeStats
LlamaModel::singleRuntimeStatsLocked() const {
  // Prefer the per-inference snapshot taken at the start of
  // `compactThinkSpan`. That snapshot is the user-visible cutoff, BEFORE
  // any recurrent replay decode rolled extra `llama_decode` calls into
  // `n_p_eval` / `t_p_eval_ms`. When no snapshot exists (pure-attention
  // models, prefill-only requests, or `runtimeStats()` called between
  // turns) we fall back to a live `llama_perf_context()` read — same as
  // the legacy behaviour.
  auto snapshot = state_->llmContext_->takeUserVisiblePerfSnapshot();
  auto perfData =
      snapshot.value_or(llama_perf_context(state_->llmContext_->getCtx()));
  constexpr double kMillisInSecond = 1000.0;
  const bool wasPrefill = state_->lastRun_.wasPrefill;
  const double timeToFirstToken = wasPrefill ? 0.0 : perfData.t_p_eval_ms;
  const int64_t generatedTokens =
      static_cast<int64_t>(wasPrefill ? 0 : perfData.n_eval);
  const int64_t promptTokens =
      static_cast<int64_t>(wasPrefill ? 0 : perfData.n_p_eval);
  const double tokensPerSecond =
      (!wasPrefill && perfData.t_eval_ms > 0)
          ? kMillisInSecond / perfData.t_eval_ms * perfData.n_eval
          : 0.0;
  const double promptProcessingTPS =
      perfData.t_p_eval_ms > 0
          ? kMillisInSecond / perfData.t_p_eval_ms * perfData.n_p_eval
          : 0.0;
  llama_perf_context_reset(state_->llmContext_->getCtx());
  return {
      {"TTFT", timeToFirstToken},
      {"TPS", tokensPerSecond},
      {"ppTPS", promptProcessingTPS},
      {"CacheTokens",
       static_cast<int64_t>(state_->llmContext_->getCacheTokens())},
      {"generatedTokens", generatedTokens},
      {"promptTokens", promptTokens},
      {"contextSlides",
       static_cast<int64_t>(state_->llmContext_->getNSlides())},
      {"thinkingBlockDiscards",
       static_cast<int64_t>(state_->llmContext_->getThinkingBlockDiscards())},
      // Vision-encode time + slice count for the most recent inference.
      // Single-sequence semantics: the context accumulator resets per prompt,
      // so these are only meaningful on this single-prompt path — intentionally
      // NOT emitted from batchRuntimeStatsLocked (multiple prompts share one
      // context, so a per-batch value would be misattributed).
      {"visionEncodeMs", state_->llmContext_->getVisionEncodeMs()},
      {"visionEncodeTiles",
       static_cast<int64_t>(state_->llmContext_->getVisionEncodeTiles())},
      {"avgConcurrentSeq", 1.0},
      {"backendDevice", runtimeBackendDevice_}};
}

qvac_lib_inference_addon_cpp::RuntimeStats
LlamaModel::runtimeDebugStats() const {
  std::shared_lock lock(stateMtx_);
  const int64_t firstMsgTokens =
      state_->llmContext_
          ? static_cast<int64_t>(state_->llmContext_->getFirstMsgTokens())
          : 0LL;
  auto snapshot = state_->toolsCompact_
                      ? state_->toolsCompact_->debugSnapshot()
                      : ToolsCompactController::DebugSnapshot{};
  return {
      {"nPastBeforeTools", static_cast<int64_t>(snapshot.nPastBeforeTools)},
      {"firstMsgTokens", firstMsgTokens},
      {"toolsTrimmed", snapshot.lastToolsTrimmed ? 1LL : 0LL}};
}

// NOLINTNEXTLINE(readability-convert-member-functions-to-static,readability-function-cognitive-complexity)
LlamaModel::ResolvedToolsCompactConfig
LlamaModel::resolveToolsCompactConfig(bool toolsCompactRequested) const {
  if (!toolsCompactRequested) {
    return {};
  }

  auto arch = metadata_.tryGetString("general.architecture");
  auto marker = qvac_lib_inference_addon_llama::utils::
      selectToolsCompactMarkerForModelMetadata(arch);

  if (!marker.has_value()) {
    return {
        .resolution = ToolsCompactResolution::RequestedUnsupported,
        .profile = std::nullopt};
  }

  ToolsCompactProfile profile;
  profile.toolCallStartMarker = marker.value();
  return {
      .resolution = ToolsCompactResolution::RequestedSupported,
      .profile = std::move(profile)};
}

// NOLINTNEXTLINE(readability-convert-member-functions-to-static,readability-function-cognitive-complexity)
void LlamaModel::commonParamsParse(
    const std::string& modelPath,
    std::unordered_map<std::string, std::string>& configFilemap,
    common_params& params, std::optional<int>& outAdrenoVersion,
    ResolvedToolsCompactConfig& outToolsCompactConfig) {

  std::vector<std::string> configVector;
  outToolsCompactConfig = ResolvedToolsCompactConfig{};

  // Check if tools are enabled and exclude it with jinja from the config file
  if (auto iter = configFilemap.find("tools"); iter != configFilemap.end()) {
    std::string toolsVal = iter->second;
    std::ranges::transform(toolsVal, toolsVal.begin(), ::tolower);
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

  // MedPsy ships only a Jinja chat template embedded in its GGUF; the non-jinja
  // fallback path used by llama.cpp does not execute the {%- set persona -%}
  // block that injects the model's persona system prompt, so the model loses
  // its identity when jinja is off. Auto-enable jinja whenever we detect the
  // MedPsy basename so the embedded template is applied regardless of the
  // tools setting.
  if (!params.use_jinja &&
      qvac_lib_inference_addon_llama::utils::isMedPsyBasename(
          metadata_.tryGetString("general.basename").value_or(""))) {
    params.use_jinja = true;
    QLOG_IF(
        Priority::INFO,
        "[LlamaModel] MedPsy basename detected; auto-enabling jinja so the "
        "embedded chat template is applied\n");
  }

  // reasoning-budget controls the size of the model's <think> reasoning
  // channel: -1 (default) leaves it unrestricted, 0 disables thinking
  // entirely, any positive N caps the reasoning channel at N tokens (the
  // budget sampler forces </think> once N reasoning tokens have been
  // emitted).
  auto parseReasoningBudget = [](const std::string& raw) {
    int value = 0;
    const char* begin = raw.data();
    const char* end = begin + raw.size();
    const auto [ptr, ec] = std::from_chars(begin, end, value);
    if (ec != std::errc{} || ptr != end || value < -1) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          qvac_errors::general_error::toString(
              qvac_errors::general_error::InvalidArgument),
          "reasoning-budget must be -1 (unrestricted), 0 (disabled), or a "
          "positive integer (token cap)");
    }
    return value;
  };
  for (const std::string& key : {"reasoning-budget", "reasoning_budget"}) {
    if (auto it = configFilemap.find(key); it != configFilemap.end()) {
      params.reasoning_budget = parseReasoningBudget(it->second);
      configFilemap.erase(it);
    }
  }

  // parse image-tile-mode (not in LLAMA_EXAMPLE_COMMON, must be handled
  // manually before configVector is built)
  for (const std::string& key : {"image-tile-mode", "image_tile_mode"}) {
    if (auto it = configFilemap.find(key); it != configFilemap.end()) {
      std::string val = it->second;
      std::transform(val.begin(), val.end(), val.begin(), ::tolower);
      if (val == "0" || val == "batched") {
        params.image_tile_mode = COMMON_IMAGE_TILE_MODE_BATCHED;
      } else if (val == "1" || val == "sequential") {
        params.image_tile_mode = COMMON_IMAGE_TILE_MODE_SEQUENTIAL;
      } else if (val == "2" || val == "disabled") {
        params.image_tile_mode = COMMON_IMAGE_TILE_MODE_DISABLED;
      } else {
        throw qvac_errors::StatusError(
            ADDON_ID,
            qvac_errors::general_error::toString(
                qvac_errors::general_error::InvalidArgument),
            string_format(
                "image-tile-mode must be 0/batched, 1/sequential, or "
                "2/disabled, got: %s",
                it->second.c_str()));
      }
      configFilemap.erase(it);
    }
  }

  // parse image-max-tokens / image-min-tokens (override Qwen-VL default caps)
  for (const std::string& key : {"image-max-tokens", "image_max_tokens"}) {
    if (auto it = configFilemap.find(key); it != configFilemap.end()) {
      try {
        params.image_max_tokens = std::stoi(it->second);
      } catch (...) {
        throw qvac_errors::StatusError(
            ADDON_ID,
            qvac_errors::general_error::toString(
                qvac_errors::general_error::InvalidArgument),
            string_format(
                "image-max-tokens must be an integer, got: %s",
                it->second.c_str()));
      }
      configFilemap.erase(it);
      break;
    }
  }
  for (const std::string& key : {"image-min-tokens", "image_min_tokens"}) {
    if (auto it = configFilemap.find(key); it != configFilemap.end()) {
      try {
        params.image_min_tokens = std::stoi(it->second);
      } catch (...) {
        throw qvac_errors::StatusError(
            ADDON_ID,
            qvac_errors::general_error::toString(
                qvac_errors::general_error::InvalidArgument),
            string_format(
                "image-min-tokens must be an integer, got: %s",
                it->second.c_str()));
      }
      configFilemap.erase(it);
      break;
    }
  }

  // parse custom nDiscarded from config (apply only if > 0)
  if (auto iter = configFilemap.find("n_discarded");
      iter != configFilemap.end()) {
    try {
      long long parsed = std::stoll(iter->second);
      if (parsed > 0) {
        state_->configuredNDiscarded_ = static_cast<llama_pos>(parsed);
      }
    } catch (...) {
      std::string errorMsg = string_format(
          "%s: invalid n_discarded value: %s\n",
          __func__,
          iter->second.c_str());
      throw qvac_errors::StatusError(
          ADDON_ID,
          qvac_errors::general_error::toString(
              qvac_errors::general_error::InvalidArgument),
          errorMsg);
    }
    configFilemap.erase(iter);
  }

  // parse tools_compact flag from config
  bool toolsCompactRequested = false;
  if (auto iter = configFilemap.find("tools_compact");
      iter != configFilemap.end()) {
    std::string val = iter->second;
    std::transform(val.begin(), val.end(), val.begin(), ::tolower);
    toolsCompactRequested = (val == "true");
    configFilemap.erase(iter);
  }

  outToolsCompactConfig = resolveToolsCompactConfig(toolsCompactRequested);
  if (outToolsCompactConfig.resolution ==
      ToolsCompactResolution::RequestedUnsupported) {
    QLOG_IF(
        Priority::WARNING,
        "[LlamaModel] tools_compact is not supported for this model "
        "architecture, ignoring\n");
  }

  llama_split_mode splitMode = LLAMA_SPLIT_MODE_NONE;
  auto hIt = configFilemap.find("split-mode");
  auto uIt = configFilemap.find("split_mode");
  if (hIt != configFilemap.end() && uIt != configFilemap.end()) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        string_format(
            "%s: both 'split-mode' and 'split_mode' are present; "
            "use one or the other.\n",
            __func__));
  }
  if (auto it = (hIt != configFilemap.end()) ? hIt : uIt;
      it != configFilemap.end()) {
    std::string val = it->second;
    std::transform(val.begin(), val.end(), val.begin(), ::tolower);
    if (val == "layer") {
      splitMode = LLAMA_SPLIT_MODE_LAYER;
    } else if (val == "row") {
      splitMode = LLAMA_SPLIT_MODE_ROW;
    } else if (val != "none") {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          string_format(
              "%s: invalid split-mode '%s', must be 'none', 'layer', or "
              "'row'.\n",
              __func__,
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
    std::string errorMsg =
        string_format("%s: must specify a device: 'gpu' or 'cpu'.\n", __func__);
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

    bool isMaliGpu = false;
    const std::pair<BackendType, std::string> chosenBackend = chooseBackend(
        preferredBackend,
        LlamaModel::llamaLogCallback,
        mainGpu,
        &metadata_,
        &outAdrenoVersion,
        pendingFinetuneOverrides_.active,
        &isMaliGpu);

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
                __func__));
      }
      if (auto it = (hMmproj != configFilemap.end()) ? hMmproj : uMmproj;
          it != configFilemap.end()) {
        std::string val = it->second;
        std::transform(val.begin(), val.end(), val.begin(), ::tolower);
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
                  __func__,
                  it->second.c_str()));
        }
        configFilemap.erase(it);
      }
    }

    if (chosenBackend.first == BackendType::GPU) {
      params.mmproj_backend = chosenBackend.second;
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
          outAdrenoVersion.has_value() &&
          outAdrenoVersion.value() >= kAdrenoMmprojGpuThreshold;
      bool mmprojUseGpu = isAdreno800Plus;
      const char* mmprojDefaultReason =
          isAdreno800Plus
              ? "auto-default, Adreno 800+"
              : (isMaliGpu ? "auto-default, Mali GPU"
                           : (outAdrenoVersion.has_value()
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
      params.split_mode = splitMode;
      runtimeBackendDevice_ = 1;

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
    } else if (chosenBackend.first == BackendType::CPU) {
      params.mmproj_use_gpu = false;
      if (mmprojUseGpuOverride.value_or(false)) {
        QLOG_IF(
            Priority::WARNING,
            "[LlamaModel] mmproj-use-gpu ignored: no GPU backend available, "
            "running the multimodal projector on CPU\n");
      }
      runtimeBackendDevice_ = 0;
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
    if (splitMode == LLAMA_SPLIT_MODE_NONE) {
      configVector.emplace_back("--device");
      configVector.emplace_back(chosenBackend.second);
    }
    configFilemap.erase("device");

    isGpu = chosenBackend.first == BackendType::GPU;
    isOpenCl =
        isGpu && chosenBackend.second.find("opencl") != std::string::npos;
    isMetal =
        isGpu && (chosenBackend.second.find("metal") != std::string::npos ||
                  chosenBackend.second.rfind("mtl", 0) == 0);
  }

  tuneConfigMap(
      configFilemap,
      metadata_,
      outAdrenoVersion,
      pendingFinetuneOverrides_,
      isOpenCl,
      isMetal,
      isGpu);

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
  params.training = pendingFinetuneOverrides_.active;
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
      std::string errorMsg =
          string_format("%s: invalid argument: %s\n", __func__, arg.c_str());
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
              __func__,
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
          __func__,
          arg.c_str(),
          e.what());
      throw qvac_errors::StatusError(
          ADDON_ID,
          qvac_errors::general_error::toString(
              qvac_errors::general_error::InvalidArgument),
          errorMsg);
    }
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
        __func__,
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
            __func__));
    params.n_ctx = kMinNCtx;
  }
  if (params.rope_freq_base != 0.0) {
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "%s: changing RoPE frequency base to %g.\n",
            __func__,
            params.rope_freq_base));
  }
  if (params.rope_freq_scale != 0.0) {
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "%s: scaling RoPE frequency by %g.\n",
            __func__,
            params.rope_freq_scale));
  }
}
// NOLINTNEXTLINE(readability-convert-member-functions-to-static,readability-function-cognitive-complexity)
ParsedPromptPayload LlamaModel::formatPrompt(const std::string& input) {
  if (input.empty()) {
    state_->llmContext_->resetMedia();
    std::string errorMsg = string_format("%s: empty prompt\n", __func__);
    throw qvac_errors::StatusError(ADDON_ID, toString(EmptyPrompt), errorMsg);
  }
  ParsedPromptPayload parsed;
  std::vector<common_chat_msg>& chatMsgs = parsed.chatMsgs;
  std::vector<common_chat_tool>& tools = parsed.tools;

  picojson::value chatJson;
  std::string err = picojson::parse(chatJson, input);

  if (err.empty() && chatJson.is<picojson::array>()) {
    auto& obj = chatJson.get<picojson::array>();

    // Build PromptLayout for tools_compact validation
    PromptLayout layout;
    layout.totalItems = obj.size();

    int addMediaPlaceholder = 0;
    bool isNextUser = false;
    for (size_t i = 0; i < obj.size(); ++i) {
      const auto& subObj = obj[i];
      if (subObj.is<picojson::object>()) {
        picojson::object jsonObj = subObj.get<picojson::object>();

        if (jsonObj.find("type") != jsonObj.end() &&
            jsonObj["type"].get<std::string>() == "function") {
          if (!layout.firstToolIdx.has_value()) {
            layout.firstToolIdx = i;
          }
          layout.lastToolIdx = i;
          layout.toolCount++;

          common_chat_tool tool;
          tool.name = jsonObj["name"].get<std::string>();
          if (jsonObj.find("description") != jsonObj.end()) {
            tool.description = jsonObj["description"].get<std::string>();
          }
          if (jsonObj.find("parameters") != jsonObj.end()) {
            tool.parameters = jsonObj["parameters"].serialize();
          }
          tools.push_back(tool);
          continue;
        }

        common_chat_msg newMsg;
        if (jsonObj.find("role") == jsonObj.end()) {
          const char* errorMsg = "role is required in the input\n";
          throw qvac_errors::StatusError(
              ADDON_ID, toString(NoRoleProvided), errorMsg);
        }
        newMsg.role = jsonObj["role"].get<std::string>();

        // Track last anchor (user/tool) message index for tools_compact
        if (newMsg.role == "user" || newMsg.role == "tool") {
          layout.lastAnchorIdx = i;
        }

        // Track if the very last array item is a user message
        if (newMsg.role == "user" && i == obj.size() - 1) {
          layout.lastItemIsUserMsg = true;
        }

        if (jsonObj.find("content") == jsonObj.end()) {
          const char* errorMsg = "content is required in the input\n";
          throw qvac_errors::StatusError(
              ADDON_ID, toString(NoContentProvided), errorMsg);
        }
        auto content = jsonObj["content"].get<std::string>();

        if (jsonObj.find("type") != jsonObj.end() &&
            jsonObj["type"].get<std::string>() == "media") {
          if (state_->isTextLlm_) {
            const char* errorMsg = "Media not supported by text-only models";
            throw qvac_errors::StatusError(
                ADDON_ID, toString(MediaNotSupported), errorMsg);
          }

          if (!content.empty()) {
            parsed.mediaPaths.push_back(content);
            parsed.mediaPlan.push_back({MediaSource::Path, content});
          } else {
            parsed.mediaPlan.push_back({MediaSource::ByteBuffer, ""});
          }
          addMediaPlaceholder++;
          isNextUser = true;
          continue;
        }
        if (newMsg.role == "user" && isNextUser) {
          isNextUser = false;
          while (addMediaPlaceholder > 0) {
            addMediaPlaceholder--;
            content.insert(0, mtmd_default_marker());
          }
        }
        if (newMsg.role != "user" && isNextUser) {
          state_->llmContext_->resetMedia();
          std::string errorMsg = string_format(
              "%s: Must append a user question after loading "
              "media\n",
              __func__);
          throw qvac_errors::StatusError(
              ADDON_ID, toString(UserMessageNotProvided), errorMsg);
        }
        newMsg.content = content;
        chatMsgs.push_back(newMsg);
      }
    }

    parsed.layout = std::move(layout);

    if (addMediaPlaceholder > 0) {
      state_->llmContext_->resetMedia();
      std::string errorMsg =
          string_format("%s: No request for media was made\n", __func__);
      throw qvac_errors::StatusError(
          ADDON_ID, toString(MediaRequestNotProvided), errorMsg);
    }
  }
  if (!err.empty()) {
    state_->llmContext_->resetMedia();
    std::string errorMsg =
        string_format("%s: Invalid input format: %s\n", __func__, err.c_str());
    throw qvac_errors::StatusError(
        ADDON_ID, toString(InvalidInputFormat), errorMsg);
  }
  return parsed;
}

void LlamaModel::resetState(bool resetStats) {
  state_->llmContext_->setNDiscarded(state_->configuredNDiscarded_);
  state_->llmContext_->resetState(resetStats);
}

std::unique_ptr<LlmContext> LlamaModel::createContext(
    std::string&& projectionPath, common_params& params,
    common_init_result_ptr llamaInit, ToolsCompactController& tools) {
  if (!projectionPath.empty()) {
    params.mmproj.path = std::move(projectionPath);
    return std::make_unique<MtmdLlmContext>(
        params, std::move(llamaInit), tools);
  }
  return std::make_unique<TextLlmContext>(params, std::move(llamaInit), tools);
}

bool LlamaModel::loadMedia(const std::vector<uint8_t>& input) {
  if (state_->isTextLlm_) {
    QLOG_IF(Priority::ERROR, "Media not supported by text-only models");
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(MediaNotSupported),
        "Media not supported by text-only models");
  }
  state_->llmContext_->loadMedia(input);
  return true;
}

bool LlamaModel::isBitnetModel() const {
  return metadata_.hasOneBitQuantization();
}

void LlamaModel::validateBitnetQuantization() {
  llama_model* mdl = getModel();
  if (mdl == nullptr) {
    return;
  }

  char arch[64] = {0};
  int len =
      llama_model_meta_val_str(mdl, "general.architecture", arch, sizeof(arch));
  if (len <= 0 || len >= static_cast<int>(sizeof(arch))) {
    return;
  }

  std::string archStr(arch, static_cast<size_t>(len));
  if (archStr == "bitnet" && !isBitnetModel()) {
    auto fileType = metadata_.tryGetU32("general.file_type");
    throw std::runtime_error(
        "Bitnet models are only supported with TQ1_0 or TQ2_0 quantization "
        "(file_type=" +
        std::to_string(fileType.value_or(0)) + ")");
  }
}

// Finetuning implementation moved to LlamaFinetuner.{hpp,cpp}.
