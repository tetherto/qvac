#include "model-interface/LoadFitNormalization.hpp"

#include <algorithm>
#include <cctype>
#include <cinttypes>
#include <initializer_list>
#include <thread>
#include <iterator>
#include <sstream>
#include <stdexcept>
#include <string_view>
#include <utility>

#include <common/arg.h>
#include <common/chat.h>
#include <common/log.h>
#include <ggml-backend.h>
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

// Finds exactly one of `keys` present in `configFilemap`. Throws
// InvalidArgument, naming every key in `keys`, if more than one is present —
// the shared shape behind every "accept 'foo' or 'foo_bar', not both" config
// key in this file (split-mode, rpc-servers/rpc_servers/rpc, devices/
// device-list, mmproj-use-gpu). Returns configFilemap.end() if none are
// present; callers still do their own value parsing and erase() on use.
load_fit_normalization::ConfigMap::iterator findOneOfAliasedKeys(
    load_fit_normalization::ConfigMap& configFilemap,
    std::initializer_list<std::string_view> keys) {
  std::vector<load_fit_normalization::ConfigMap::iterator> found;
  for (const std::string_view key : keys) {
    if (auto it = configFilemap.find(std::string(key));
        it != configFilemap.end()) {
      found.push_back(it);
    }
  }
  if (found.size() > 1) {
    std::string joined;
    for (const std::string_view key : keys) {
      if (!joined.empty()) {
        joined += ", ";
      }
      joined += "'";
      joined += key;
      joined += "'";
    }
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        string_format(
            "%s: more than one of %s is present; use exactly one.\n",
            K_LEGACY_PARSER_NAME.data(), joined.c_str()));
  }
  return found.empty() ? configFilemap.end() : found.front();
}

// QVAC-24112: register remote RPC devices before backend selection runs.
//
// llama.cpp registers RPC endpoints from its own `--rpc` handler, which the
// passthrough loop below does not reach until long after chooseBackend() has
// already picked a device. Registering here makes the remote devices visible
// to the selection pass; see the call site for the ordering contract.
//
// Mirrors add_rpc_devices() in common/arg.cpp, which is static and so cannot be
// linked against. Two deliberate differences:
//
//  - Upstream calls ggml_backend_load_all() first. We must not: the caller has
//    already loaded backends through LlamaBackendsHandle (LlamaModel.cpp:193),
//    which honours the configured backends directory. Loading again here would
//    pull from the default search path as well, registering duplicate or
//    unintended backends wherever they ship as separate shared objects.
//
//  - ggml_backend_rpc_add_server() returns nullptr for an endpoint it cannot
//    reach, and upstream passes that straight to ggml_backend_register().
//    That is not a crash (register_backend early-returns on null), which is
//    the problem: the endpoint is dropped silently and the load continues on
//    whatever devices remain. We reject it naming the endpoint instead.
void registerRpcDevices(const std::string& servers) {
  const std::vector<std::string> endpoints = split(servers, ',');
  if (endpoints.empty()) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        string_format(
            "%s: 'rpc-servers' is empty; expected a comma-separated list of "
            "host:port endpoints.\n",
            K_LEGACY_PARSER_NAME.data()));
  }

  ggml_backend_reg_t rpcReg = ggml_backend_reg_by_name("RPC");
  if (rpcReg == nullptr) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        string_format(
            "%s: 'rpc-servers' was given but this build has no RPC backend "
            "(GGML_RPC was not enabled in qvac-fabric).\n",
            K_LEGACY_PARSER_NAME.data()));
  }

  using AddServerFn = ggml_backend_reg_t (*)(const char* endpoint);
  auto addServer = reinterpret_cast<AddServerFn>(
      ggml_backend_reg_get_proc_address(rpcReg, "ggml_backend_rpc_add_server"));
  if (addServer == nullptr) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        string_format(
            "%s: RPC backend does not export ggml_backend_rpc_add_server.\n",
            K_LEGACY_PARSER_NAME.data()));
  }

  // Optional: connects to every endpoint concurrently before the loop below
  // registers them one at a time. Without this, N endpoints cost N times a
  // full connect (each up to the connect timeout on an unreachable one) even
  // though the endpoints are independent of each other.
  //
  // Deliberately does not change what happens below: registration order (and
  // so RPC0/RPC1/... device numbering) stays exactly as sequential and
  // deterministic as it always was. Only the network wait moves earlier and
  // runs in parallel; addServer() below still assigns device numbers one
  // endpoint at a time, in list order, same as if this block did not exist -
  // it just becomes a cache hit on an already-open connection instead of a
  // fresh connect.
  //
  // A failed connect is NOT cached by get_command_queue() (only successful
  // ones are, so a transient failure gets a fresh retry on the next call
  // rather than being stuck), so addServer() below would otherwise redo the
  // full failing connect a second time, sequentially, for a still-down
  // endpoint - silently reintroducing the same N-times-the-timeout cost this
  // exists to avoid, for the unreachable case specifically. ok[i] records
  // which endpoints already failed during prefetch so the loop below can
  // fail fast on those instead of retrying.
  //
  // Optional because an older qvac-fabric build (predating this addon
  // change) will not export it; ggml_backend_reg_get_proc_address() returns
  // null for an unknown name rather than failing the whole call, so a build
  // without it falls back to today's sequential behavior with no error.
  using PrefetchFn = bool (*)(const char* endpoint);
  auto prefetch = reinterpret_cast<PrefetchFn>(ggml_backend_reg_get_proc_address(
      rpcReg, "ggml_backend_rpc_prefetch_connection"));
  // NOT std::vector<bool>: its bits are packed, so writes to two different
  // indices from two different threads can share an underlying word and
  // race. uint8_t elements are genuinely independent memory.
  std::vector<uint8_t> prefetchOk(endpoints.size(), 0);
  bool didPrefetch = false;
  if (prefetch != nullptr && endpoints.size() > 1) {
    didPrefetch = true;
    std::vector<std::thread> prefetchers;
    prefetchers.reserve(endpoints.size());
    for (size_t i = 0; i < endpoints.size(); i++) {
      // Each thread writes only prefetchOk[i], a distinct element; no shared
      // mutable state is touched, so no synchronization is needed beyond the
      // join() below.
      prefetchers.emplace_back([prefetch, &endpoint = endpoints[i], &ok = prefetchOk[i]]() {
        ok = prefetch(endpoint.c_str()) ? 1 : 0;
      });
    }
    for (std::thread& prefetcher : prefetchers) {
      prefetcher.join();
    }
  }

  for (size_t i = 0; i < endpoints.size(); i++) {
    const std::string& endpoint = endpoints[i];
    if (didPrefetch && !prefetchOk[i]) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          string_format(
              "%s: could not reach RPC server '%s'. Check that "
              "ggml-rpc-server is running there and the port is open.\n",
              K_LEGACY_PARSER_NAME.data(),
              endpoint.c_str()));
    }
    ggml_backend_reg_t reg = addServer(endpoint.c_str());
    if (reg == nullptr) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          string_format(
              "%s: could not reach RPC server '%s'. Check that "
              "ggml-rpc-server is running there and the port is open.\n",
              K_LEGACY_PARSER_NAME.data(),
              endpoint.c_str()));
    }
    ggml_backend_register(reg);
  }
}

uint32_t trainedContext(const ModelMetaData& metadata) {
  const auto architecture = metadata.tryGetString("general.architecture");
  if (!architecture.has_value()) {
    return 0;
  }
  const std::string key = *architecture + ".context_length";
  return metadata.tryGetU32(key.c_str()).value_or(0);
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
      .registerRpcDevices =
          [](const std::string& servers) { ::registerRpcDevices(servers); }};
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
      std::string value = it->second;
      std::ranges::transform(value, value.begin(), ::tolower);
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
              "load-mode must be one of 'none', 'mmap', 'mlock', "
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

  // parse custom nDiscarded from config (apply only if > 0)
  if (auto iter = configFilemap.find("n_discarded");
      iter != configFilemap.end()) {
    try {
      long long parsed = std::stoll(iter->second);
      if (parsed > 0) {
        result.configuredNDiscarded = static_cast<llama_pos>(parsed);
      }
    } catch (...) {
      std::string errorMsg = string_format(
          "%s: invalid n_discarded value: %s\n",
          K_LEGACY_PARSER_NAME.data(),
          iter->second.c_str());
      throw qvac_errors::StatusError(
          ADDON_ID,
          qvac_errors::general_error::toString(
              qvac_errors::general_error::InvalidArgument),
          errorMsg);
    }
    configFilemap.erase(iter);
  }

  llama_split_mode splitMode = LLAMA_SPLIT_MODE_NONE;
  if (auto it = findOneOfAliasedKeys(configFilemap, {"split-mode", "split_mode"});
      it != configFilemap.end()) {
    std::string val = it->second;
    std::transform(val.begin(), val.end(), val.begin(), ::tolower);
    if (val == "layer") {
      splitMode = LLAMA_SPLIT_MODE_LAYER;
    } else if (val == "row") {
      splitMode = LLAMA_SPLIT_MODE_ROW;
    } else if (val == "tensor") {
      // Real tensor parallelism: shards each weight and inserts all-reduces,
      // via the meta device. Distinct from the older 'row', which is a
      // deprecated split-buffer path no backend we ship provides.
      //
      // qvac-fabric enforces its own preconditions and throws if unmet: the
      // architecture must be on its supported list, flash attention must be
      // on, and the KV cache must not be quantized.
      splitMode = LLAMA_SPLIT_MODE_TENSOR;

      // qvac-fabric's own memory-fit preflight (on by default: fit_params
      // defaults to true in common_params, and this addon has no config key
      // that turns it off) throws internally for SPLIT_MODE_TENSOR
      // (fit.cpp: "llama_params_fit is not implemented for SPLIT_MODE_TENSOR").
      // Its caller in common_init_from_params() catches that, logs its own
      // WARN, and discards the failure status - loading proceeds with
      // whatever gpu_layers/ctx_size/tensor-split was configured, completely
      // unchecked against available memory across the split devices. An
      // over-provisioned tensor-split load has no preflight catching it
      // before an OOM or bad allocation at actual load/decode time.
      //
      // Surfacing that here because qvac-fabric's own WARN uses its
      // "common_fit_params" tag, giving no indication it is specifically
      // about tensor mode being unfittable, not a real fit failure - easy to
      // miss unless you already know to look for it, exactly the kind of
      // silent-degrade this whole feature is built to avoid.
      QLOG_IF(
          Priority::WARNING,
          "[LlamaModel] split-mode 'tensor' has no memory-fit safety net: "
          "qvac-fabric does not implement fit_params for SPLIT_MODE_TENSOR "
          "and silently skips it, so gpu_layers/ctx_size/tensor-split are "
          "used exactly as configured with no check against available "
          "memory across the split devices. Size them manually.\n");
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
  // Reject RPC here rather than letting it through: registration opens
  // blocking sockets during model load, and the path is untested on mobile.
  // Failing loudly beats a load that stalls on an unreachable peer.
  //
  // 'rpc' is llama.cpp's own spelling. It is matched here too, otherwise the
  // passthrough loop forwards it as --rpc and qvac-fabric registers the
  // endpoints itself, bypassing this guard entirely.
  if (configFilemap.count("rpc-servers") > 0 ||
      configFilemap.count("rpc_servers") > 0 ||
      configFilemap.count("rpc") > 0) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Distributed inference (rpc-servers) is not supported on mobile.");
  }
  // Same reasoning as the multi-GPU keys: an explicit device list overrides
  // the mobile backend selection and the tuning derived from it.
  if (configFilemap.count("devices") > 0 ||
      configFilemap.count("device-list") > 0) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Explicit device lists (devices) are not supported on mobile.");
  }
#endif

  // Set when this load registered RPC devices, so the CPU-fallback branch
  // below can tell "no RPC involved" apart from "RPC involved, but automatic
  // selection could not place it" — the latter must fail loudly rather than
  // silently run everything locally.
  bool rpcDevicesRegistered = false;

  // Ordering contract: this must run *before* the 'device' lookup and the
  // resolveBackend() call below, because RPC devices only exist in the ggml
  // registry once they are added here. It must also run *after* the mobile
  // guard above, which rejects the multi-device config keys outright.
  //
  // The key is erased on use: the passthrough loop further down forwards every
  // remaining key to llama.cpp as '--<key> <value>', and a surviving 'rpc' key
  // would make its parser register the same endpoints a second time.
  //
  // 'rpc' is accepted as an alias because it is llama.cpp's own flag name.
  // Handling it here rather than letting the passthrough loop forward it as
  // --rpc matters: qvac-fabric's own handler calls ggml_backend_load_all(),
  // which would re-load backends from the default path (see registerRpcDevices).
  if (auto it =
          findOneOfAliasedKeys(configFilemap, {"rpc-servers", "rpc_servers", "rpc"});
      it != configFilemap.end()) {
    dependencies.registerRpcDevices(it->second);
    rpcDevicesRegistered = true;
    configFilemap.erase(it);
  }

  // Hoisted alongside 'rpc-servers' rather than parsed where it is used below,
  // so the CPU-fallback branch can consult it: a caller who named devices
  // explicitly has already told us what to use, and that must not be
  // silently overridden by automatic selection failing to find a local GPU.
  std::string explicitDevices;
  if (auto it = findOneOfAliasedKeys(configFilemap, {"devices", "device-list"});
      it != configFilemap.end()) {
    explicitDevices = it->second;
    configFilemap.erase(it);
  }

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
    if (auto it = findOneOfAliasedKeys(
            configFilemap, {"mmproj-use-gpu", "mmproj_use_gpu"});
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
                K_LEGACY_PARSER_NAME.data(),
                it->second.c_str()));
      }
      configFilemap.erase(it);
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
      // Degrade row -> layer to keep the model loadable.
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
      // Automatic selection only ever looks at *local* hardware (the RPC
      // filter in emplaceIfValidDevice keeps it that way deliberately — see
      // that function), so this branch cannot tell "genuinely no GPU
      // anywhere" apart from "no local GPU, but the caller named remote ones
      // explicitly". Silently forcing single-device CPU inference in the
      // second case would run the whole model locally while reporting
      // success — exactly the failure mode this feature exists to avoid.
      // Require 'devices' in that case instead of guessing.
      if (rpcDevicesRegistered && explicitDevices.empty()) {
        throw qvac_errors::StatusError(
            qvac_errors::general_error::InvalidArgument,
            string_format(
                "%s: 'rpc-servers' was given but no local GPU was found, so "
                "automatic device selection cannot tell which devices to use. "
                "Set 'devices' to name them explicitly (e.g. 'RPC0,RPC1').\n",
                K_LEGACY_PARSER_NAME.data()));
      }
      if (rpcDevicesRegistered) {
        // Caller named devices explicitly (checked above): honor the
        // caller's split-mode and tensor-split as configured, rather than
        // taking the no-GPU-found degrade path below meant for a machine
        // that only ever had CPU as an option.
        params.mmproj_use_gpu = mmprojUseGpuOverride.value_or(true);
        result.runtimeBackendDevice = 1;
        params.split_mode = splitMode;
      } else {
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
      }
    } else {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InternalError,
          "preferredDeviceFromString: wrong deduced device, must be 'gpu' or "
          "'cpu'.\n");
    }

    if (!explicitDevices.empty()) {
      configVector.emplace_back("--device");
      configVector.emplace_back(explicitDevices);
    } else if (splitMode == LLAMA_SPLIT_MODE_NONE) {
      // In multi-GPU split mode we intentionally omit --device so llama.cpp
      // distributes layers/rows across all available GPUs rather than pinning
      // to the single backend that chooseBackend selected.
      configVector.emplace_back("--device");
      configVector.emplace_back(selected.name);
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
