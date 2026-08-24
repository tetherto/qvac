#include "fit/LlamaLoadConfig.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cerrno>
#include <cstdlib>
#include <limits>
#include <stdexcept>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>

#include <common/arg.h>
#include <gguf.h>
#ifdef __APPLE__
#include <TargetConditionals.h>
#endif

namespace model_fit {

namespace {

constexpr int32_t MIN_CONTEXT_SIZE = 8;
constexpr int ADRENO_UBATCH_THRESHOLD = 800;
constexpr int32_t ADRENO_UBATCH_CAP = 128;

constexpr LlamaFitPlatform currentPlatform() {
#if defined(__ANDROID__) ||                                                    \
    (defined(__APPLE__) && defined(TARGET_OS_IOS) && TARGET_OS_IOS)
  return LlamaFitPlatform::Mobile;
#else
  return LlamaFitPlatform::Desktop;
#endif
}

const std::unordered_set<std::string> IGNORED_NON_MEMORY_KEYS = {
    "tools",
    "jinja",
    "reverse-prompt",
    "n-discarded",
};

// Direct binding must reject these before backend discovery; constructing
// qvac-fabric parser metadata initializes backends.
const std::unordered_set<std::string> FIT_CRITICAL_INTEGER_KEYS = {
    "ctx-size",
    "batch-size",
    "ubatch-size",
    "parallel",
    "gpu-layers",
    "n-gpu-layers",
    "main-gpu",
    "fit-ctx",
    "n-cpu-moe",
};

// This exact experimental subset must be classified before backend discovery.
// `host`, `extra-bufts` and `no-extra-bufts` are deliberately absent:
// qvac-fabric registers no such option for LLAMA_EXAMPLE_COMMON, so neither the
// addons nor this package can express them, and accepting them here would
// answer for a placement the load cannot reproduce.
const std::unordered_set<std::string> SUPPORTED_LOAD_KEYS = {
    "device",       "main-gpu",      "split-mode",  "tensor-split",
    "ctx-size",     "batch-size",    "ubatch-size", "parallel",
    "gpu-layers",   "n-gpu-layers",  "flash-attn",  "cache-type-k",
    "cache-type-v", "no-mmap",       "swa-full",    "fit-ctx",
    "n-cpu-moe",    "no-kv-offload", "kv-offload",  "no-op-offload",
    "op-offload",   "no-host",
};

// Distinct allowlisted keys that write the same field. `canonicalizeConfig`
// only folds `_` into `-`, so both spellings survive it and
// `parseGenericConfig` applies both handlers while iterating an unordered_map —
// which value lands would be decided by hash-bucket order rather than by the
// request. The addons reject conflicting alias pairs outright
// (BackendSelection.cpp for main-gpu, LoadFitNormalization.cpp for split-mode),
// and `aliasedInteger` in binding.cpp already does it for
// ctx-size/batch-size/ubatch-size, so do the same here rather than answering a
// request non-deterministically.
constexpr std::array<std::pair<std::string_view, std::string_view>, 3>
    EXCLUSIVE_LOAD_KEY_PAIRS = {{
        {"gpu-layers", "n-gpu-layers"},
        {"kv-offload", "no-kv-offload"},
        {"op-offload", "no-op-offload"},
    }};

const std::array<std::string_view, 18> UNSUPPORTED_KEY_PARTS = {
    "lora",
    "control-vector",
    "mmproj",
    "multimodal",
    "finetune",
    "training",
    "rope-scale",
    "rope-freq",
    "yarn",
    "model-draft",
    "model-vocoder",
    "model-url",
    "hf-repo",
    "hf-file",
    "docker-repo",
    "rpc",
    "shard",
    "stream",
};

std::string lower(std::string value) {
  std::ranges::transform(value, value.begin(), [](unsigned char character) {
    return static_cast<char>(std::tolower(character));
  });
  return value;
}

std::string canonicalKey(std::string key) {
  std::ranges::replace(key, '_', '-');
  return lower(std::move(key));
}

bool keyIsUnsupported(const std::string& key) {
  return std::ranges::any_of(UNSUPPORTED_KEY_PARTS, [&](std::string_view part) {
    return key.find(part) != std::string::npos;
  });
}

bool parseBoolean(const std::string& value, const std::string& key) {
  if (value.empty() || common_arg_utils::is_truthy(value)) {
    return true;
  }
  if (common_arg_utils::is_falsey(value)) {
    return false;
  }
  throw std::invalid_argument(
      "model-fit: config." + key + " must be a boolean string");
}

int parseInteger(const std::string& value, const std::string& key) {
  size_t consumed = 0;
  long long parsed = 0;
  try {
    parsed = std::stoll(value, &consumed);
  } catch (const std::exception&) {
    throw std::invalid_argument(
        "model-fit: config." + key + " must be an integer string");
  }
  if (consumed != value.size() || parsed < std::numeric_limits<int>::min() ||
      parsed > std::numeric_limits<int>::max()) {
    throw std::invalid_argument(
        "model-fit: config." + key + " must be an integer string");
  }
  return static_cast<int>(parsed);
}

LlamaConfigMap canonicalizeConfig(const LlamaConfigMap& config) {
  LlamaConfigMap canonical;
  for (const auto& [rawKey, value] : config) {
    const std::string key = canonicalKey(rawKey);
    if (key.empty()) {
      throw std::invalid_argument(
          "model-fit: llama config keys must not be empty");
    }
    if (!canonical.emplace(key, value).second) {
      throw std::invalid_argument(
          "model-fit: duplicate llama config key aliases for '" + key + "'");
    }
  }
  for (const auto& [first, second] : EXCLUSIVE_LOAD_KEY_PAIRS) {
    if (canonical.contains(std::string(first)) &&
        canonical.contains(std::string(second))) {
      throw std::invalid_argument(
          std::string("model-fit: use only one of '") + std::string(first) +
          "' and '" + std::string(second) + "'");
    }
  }
  return canonical;
}

bool isGpu(const BackendDevice& device) {
  return device.type == BackendDeviceType::Gpu ||
         device.type == BackendDeviceType::IntegratedGpu;
}

bool isEligibleGpu(const BackendDevice& device) {
  if (!isGpu(device) || lower(device.registryName) == "rpc") {
    return false;
  }
  const bool isOpenCl = lower(device.name).find("opencl") != std::string::npos;
  const bool isAdreno =
      lower(device.description).find("adreno") != std::string::npos;
  return !isOpenCl || isAdreno;
}

int adrenoVersion(const BackendDevice& device) {
  const std::string description = lower(device.description);
  const size_t adreno = description.find("adreno");
  if (adreno == std::string::npos) {
    return 0;
  }
  size_t digit = description.find_first_of("0123456789", adreno);
  if (digit == std::string::npos) {
    return 0;
  }
  size_t end = description.find_first_not_of("0123456789", digit);
  try {
    return std::stoi(description.substr(digit, end - digit));
  } catch (const std::exception&) {
    return 0;
  }
}

struct BackendSelection {
  const BackendDevice* selected = nullptr;
  int adrenoVersion = 0;
};

BackendSelection selectGpu(
    const std::vector<BackendDevice>& devices, const ModelTraits& traits,
    const std::optional<int>& requestedIndex, bool isEmbedding) {
  if (requestedIndex.has_value()) {
    const int index = requestedIndex.value();
    if (index >= 0 && static_cast<size_t>(index) < devices.size()) {
      const BackendDevice& selected = devices[static_cast<size_t>(index)];
      if (isEligibleGpu(selected)) {
        return {
            .selected = &selected, .adrenoVersion = adrenoVersion(selected)};
      }
      return {};
    }
  }

  const BackendDevice* openCl = nullptr;
  const BackendDevice* discrete = nullptr;
  const BackendDevice* integrated = nullptr;
  int maxAdrenoVersion = 0;
  for (const BackendDevice& device : devices) {
    if (!isEligibleGpu(device)) {
      continue;
    }
    const std::string name = lower(device.name);
    const bool isOpenCl = name.find("opencl") != std::string::npos;
    maxAdrenoVersion = std::max(maxAdrenoVersion, adrenoVersion(device));
    if (isOpenCl) {
      if (openCl == nullptr) {
        openCl = &device;
      }
    } else if (device.type == BackendDeviceType::Gpu && discrete == nullptr) {
      discrete = &device;
    } else if (integrated == nullptr) {
      integrated = &device;
    }
  }

  const bool isBitnet =
      traits.architecture == "bitnet" && traits.hasOneBitQuantization;
  if (!isEmbedding && !requestedIndex.has_value() && isBitnet &&
      maxAdrenoVersion > 0) {
    if (maxAdrenoVersion < ADRENO_UBATCH_THRESHOLD) {
      return {.selected = nullptr, .adrenoVersion = maxAdrenoVersion};
    }
    if (discrete != nullptr) {
      return {.selected = discrete, .adrenoVersion = maxAdrenoVersion};
    }
    return {.selected = nullptr, .adrenoVersion = maxAdrenoVersion};
  }
  if (openCl != nullptr) {
    return {.selected = openCl, .adrenoVersion = maxAdrenoVersion};
  }
  return {
      .selected = discrete != nullptr ? discrete : integrated,
      .adrenoVersion = maxAdrenoVersion};
}

bool allGpuDevicesSupportSplit(const std::vector<BackendDevice>& devices) {
  bool sawGpu = false;
  for (const BackendDevice& device : devices) {
    if (!isGpu(device)) {
      continue;
    }
    sawGpu = true;
    if (!device.supportsSplitBuffer) {
      return false;
    }
  }
  return sawGpu;
}

NormalizedLlamaLoad unsupported(std::string detail) {
  NormalizedLlamaLoad out;
  out.supported = false;
  out.unsupportedDetail = std::move(detail);
  return out;
}

bool isSymbolicMainGpuValue(const std::string& value) {
  const std::string canonicalValue = lower(value);
  return canonicalValue == "integrated" || canonicalValue == "dedicated";
}

std::optional<std::string>
preBackendUnsupportedDetail(const LlamaConfigMap& config) {
  for (const auto& [key, value] : config) {
    static_cast<void>(value);
    if (keyIsUnsupported(key)) {
      return "unsupported llama load setting: " + key;
    }
    if (!SUPPORTED_LOAD_KEYS.contains(key) &&
        !IGNORED_NON_MEMORY_KEYS.contains(key)) {
      return "unrecognized llama load setting: " + key;
    }
  }

  const auto device = config.find("device");
  if (device == config.end() ||
      (lower(device->second) != "gpu" && lower(device->second) != "cpu")) {
    return "device must be 'gpu' or 'cpu'";
  }

  const auto splitMode = config.find("split-mode");
  if (splitMode != config.end()) {
    const std::string value = lower(splitMode->second);
    if (value != "none" && value != "layer" && value != "row") {
      return "split-mode must be none, layer, or row";
    }
  }

  const auto mainGpu = config.find("main-gpu");
  if (mainGpu != config.end() && isSymbolicMainGpuValue(mainGpu->second)) {
    return "symbolic main-gpu selection is not reproducible";
  }
  return std::nullopt;
}

NormalizedLlamaLoad parseGenericConfig(
    LlamaLoadKind loadKind, const std::string& modelPath,
    const LlamaConfigMap& config) {
  NormalizedLlamaLoad out;
  common_params& params = out.params;
  params.embedding = loadKind == LlamaLoadKind::Embedding;
  auto parser = common_params_parser_init(
      params, LLAMA_EXAMPLE_COMMON, [](int, char**) {});

  std::unordered_map<std::string, common_arg*> options;
  std::unordered_map<std::string, bool> optionPolarity;
  for (common_arg& option : parser.options) {
    for (const char* arg : option.args) {
      options[arg] = &option;
      optionPolarity[arg] = true;
    }
    for (const char* arg : option.args_neg) {
      options[arg] = &option;
      optionPolarity[arg] = false;
    }
  }

  for (const auto& [key, value] : config) {
    if (IGNORED_NON_MEMORY_KEYS.contains(key)) {
      continue;
    }
    if (keyIsUnsupported(key)) {
      return unsupported("unsupported llama load setting: " + key);
    }

    const std::string arg = "--" + key;
    const auto optionIt = options.find(arg);
    if (optionIt == options.end()) {
      return unsupported("unrecognized llama load setting: " + key);
    }
    common_arg& option = *optionIt->second;
    try {
      if (option.handler_bool != nullptr) {
        const bool polarity = optionPolarity.at(arg);
        const bool requested = value.empty() ? true : parseBoolean(value, key);
        const bool enabled = polarity ? requested : !requested;
        option.handler_bool(params, enabled);
      } else if (option.handler_void != nullptr) {
        // Valueless upstream flags (`--no-host`, `--swa-full`): the token is
        // never consulted, so passing the flag always means "on". A caller who
        // wrote `false` described a load this flag cannot express, and the real
        // load would have set the flag anyway — report that rather than
        // projecting the opposite placement.
        if (!parseBoolean(value, key)) {
          return unsupported(
              "false cannot be represented for llama flag: " + key);
        }
        option.handler_void(params);
      } else if (option.handler_int != nullptr) {
        option.handler_int(params, parseInteger(value, key));
      } else if (option.handler_string != nullptr) {
        option.handler_string(params, value);
      } else {
        return unsupported("llama setting requires multiple values: " + key);
      }
    } catch (const std::invalid_argument&) {
      throw;
    } catch (const std::exception& error) {
      throw std::invalid_argument(
          "model-fit: invalid llama config setting '" + key +
          "': " + error.what());
    }
  }

  params.model.path = modelPath;
  params.warmup = false;
  if (params.n_ctx != 0 && params.n_ctx < MIN_CONTEXT_SIZE) {
    params.n_ctx = MIN_CONTEXT_SIZE;
  }
  if (!params.kv_overrides.empty()) {
    params.kv_overrides.emplace_back();
    params.kv_overrides.back().key[0] = '\0';
  }
  if (!params.tensor_buft_overrides.empty()) {
    params.tensor_buft_overrides.push_back({nullptr, nullptr});
  }
  return out;
}

} // namespace

std::vector<BackendDevice> discoverBackendDevices() {
  std::vector<BackendDevice> devices;
  const size_t count = ggml_backend_dev_count();
  devices.reserve(count);
  for (size_t index = 0; index < count; ++index) {
    ggml_backend_dev_t handle = ggml_backend_dev_get(index);
    const enum ggml_backend_dev_type type = ggml_backend_dev_type(handle);
    BackendDeviceType mapped = BackendDeviceType::Accelerator;
    switch (type) {
    case GGML_BACKEND_DEVICE_TYPE_CPU:
      mapped = BackendDeviceType::Cpu;
      break;
    case GGML_BACKEND_DEVICE_TYPE_GPU:
      mapped = BackendDeviceType::Gpu;
      break;
    case GGML_BACKEND_DEVICE_TYPE_IGPU:
      mapped = BackendDeviceType::IntegratedGpu;
      break;
    case GGML_BACKEND_DEVICE_TYPE_ACCEL:
      mapped = BackendDeviceType::Accelerator;
      break;
    case GGML_BACKEND_DEVICE_TYPE_META:
      mapped = BackendDeviceType::Accelerator;
      break;
    }
    ggml_backend_reg_t registry = ggml_backend_dev_backend_reg(handle);
    devices.push_back(
        {.name = ggml_backend_dev_name(handle),
         .description = ggml_backend_dev_description(handle),
         .type = mapped,
         .supportsSplitBuffer =
             registry != nullptr &&
             ggml_backend_reg_get_proc_address(
                 registry, "ggml_backend_split_buffer_type") != nullptr,
         .handle = handle,
         .registryName =
             registry == nullptr ? "" : ggml_backend_reg_name(registry)});
  }
  return devices;
}

ModelTraits readModelTraits(const std::string& modelPath) {
  gguf_init_params params = {};
  params.no_alloc = true;
  params.kv_only = true;
  gguf_context* context = gguf_init_from_file(modelPath.c_str(), params);
  if (context == nullptr) {
    return {};
  }

  ModelTraits traits;
  const int64_t architecture = gguf_find_key(context, "general.architecture");
  if (architecture >= 0 &&
      gguf_get_kv_type(context, architecture) == GGUF_TYPE_STRING) {
    traits.architecture = lower(gguf_get_val_str(context, architecture));
  }
  const int64_t fileType = gguf_find_key(context, "general.file_type");
  if (fileType >= 0 &&
      gguf_get_kv_type(context, fileType) == GGUF_TYPE_UINT32) {
    const uint32_t value = gguf_get_val_u32(context, fileType);
    traits.hasOneBitQuantization =
        value == static_cast<uint32_t>(LLAMA_FTYPE_MOSTLY_TQ1_0) ||
        value == static_cast<uint32_t>(LLAMA_FTYPE_MOSTLY_TQ2_0);
  }
  gguf_free(context);
  return traits;
}

void validateLlamaLoadFitCriticalIntegers(const LlamaConfigMap& config) {
  for (const auto& [rawKey, value] : config) {
    const std::string key = canonicalKey(rawKey);
    if (key == "main-gpu" && isSymbolicMainGpuValue(value)) {
      continue;
    }
    if (FIT_CRITICAL_INTEGER_KEYS.contains(key)) {
      static_cast<void>(parseInteger(value, key));
    }
  }
}

std::optional<std::string>
preBackendUnsupportedLlamaLoad(const LlamaConfigMap& config) {
  return preBackendUnsupportedLlamaLoad(config, currentPlatform());
}

std::optional<std::string> preBackendUnsupportedLlamaLoad(
    const LlamaConfigMap& config, LlamaFitPlatform platform) {
  if (platform == LlamaFitPlatform::Mobile) {
    return "llama load-config fitting is not supported on mobile";
  }
  return preBackendUnsupportedDetail(canonicalizeConfig(config));
}

NormalizedLlamaLoad normalizeLlamaLoadConfig(
    LlamaLoadKind loadKind, const std::string& modelPath, LlamaConfigMap config,
    const ModelTraits& traits, const std::vector<BackendDevice>& devices) {
  return normalizeLlamaLoadConfig(
      loadKind,
      modelPath,
      std::move(config),
      traits,
      devices,
      currentPlatform());
}

NormalizedLlamaLoad normalizeLlamaLoadConfig(
    const std::string& modelPath, LlamaConfigMap config,
    const ModelTraits& traits, const std::vector<BackendDevice>& devices) {
  return normalizeLlamaLoadConfig(
      LlamaLoadKind::Completion, modelPath, std::move(config), traits, devices);
}

NormalizedLlamaLoad normalizeLlamaLoadConfig(
    LlamaLoadKind loadKind, const std::string& modelPath, LlamaConfigMap config,
    const ModelTraits& traits, const std::vector<BackendDevice>& devices,
    LlamaFitPlatform platform) {
  if (platform == LlamaFitPlatform::Mobile) {
    return unsupported("llama load-config fitting is not supported on mobile");
  }
  config = canonicalizeConfig(config);
  if (const auto detail = preBackendUnsupportedDetail(config);
      detail.has_value()) {
    return unsupported(detail.value());
  }

  const auto deviceIt = config.find("device");
  if (deviceIt == config.end()) {
    return unsupported("device must be 'gpu' or 'cpu'");
  }
  const std::string requestedDevice = lower(deviceIt->second);
  config.erase(deviceIt);
  if (requestedDevice != "gpu" && requestedDevice != "cpu") {
    return unsupported("device must be 'gpu' or 'cpu'");
  }

  llama_split_mode splitMode = LLAMA_SPLIT_MODE_NONE;
  if (const auto splitIt = config.find("split-mode"); splitIt != config.end()) {
    const std::string value = lower(splitIt->second);
    if (value == "layer") {
      splitMode = LLAMA_SPLIT_MODE_LAYER;
    } else if (value == "row") {
      splitMode = LLAMA_SPLIT_MODE_ROW;
    } else if (value != "none") {
      return unsupported("split-mode must be none, layer, or row");
    }
    config.erase(splitIt);
  }

  std::optional<int> mainGpu;
  if (const auto mainIt = config.find("main-gpu"); mainIt != config.end()) {
    mainGpu = parseInteger(mainIt->second, "main-gpu");
    config.erase(mainIt);
  }

  bool noMmap = false;
  if (const auto mmapIt = config.find("no-mmap"); mmapIt != config.end()) {
    noMmap = parseBoolean(mmapIt->second, "no-mmap");
    config.erase(mmapIt);
  }

  const bool isEmbedding = loadKind == LlamaLoadKind::Embedding;
  BackendSelection selection;
  if (requestedDevice == "gpu") {
    selection = selectGpu(devices, traits, mainGpu, isEmbedding);
  }
  const BackendDevice* selected = selection.selected;
  const bool useGpu = selected != nullptr && requestedDevice == "gpu";

  if (!useGpu) {
    // No `gpu-layers` override: the addons leave `n_gpu_layers` alone on the
    // CPU path (LoadFitNormalization.cpp:780-792 only resets split mode and
    // main-gpu), and pinning it to 0 here both diverged from the load and made
    // `common_fit_params` abort with "n_gpu_layers already set by user to 0"
    // when the projection needed to adjust it. The zero-device list below is
    // what keeps the weights off the GPU.
    splitMode = LLAMA_SPLIT_MODE_NONE;
    config.erase("tensor-split");
  } else if (
      splitMode == LLAMA_SPLIT_MODE_ROW &&
      !allGpuDevicesSupportSplit(devices)) {
    splitMode = LLAMA_SPLIT_MODE_LAYER;
  }

  const std::string backendName =
      selected == nullptr ? "" : lower(selected->name);
  const bool isOpenCl = backendName.find("opencl") != std::string::npos;
  const bool isMetal = backendName.find("metal") != std::string::npos ||
                       backendName.starts_with("mtl");
  const bool isBitnet =
      traits.architecture == "bitnet" && traits.hasOneBitQuantization;
  const bool isAdrenoVulkan =
      useGpu && selection.adrenoVersion >= ADRENO_UBATCH_THRESHOLD &&
      !isOpenCl && !isMetal;

  if (!config.contains("flash-attn")) {
    if (isEmbedding) {
      if (isOpenCl) {
        config["flash-attn"] = "off";
      }
    } else {
      config["flash-attn"] = isBitnet ? "off" : "on";
    }
  }
  // Exact `on`, matching `llm-llamacpp`'s `valueIs("flash-attn", "flash_attn",
  // "on")` (LoadFitNormalization.cpp:287). The broader truthiness diverged:
  // with `flash_attn: 'true'` the addon's q8_0 KV auto-default below does not
  // fire and the load keeps f16, so treating it as enabled here halved the
  // projected KV footprint — the direction that reports `fits` for a load that
  // will not. Widening the spelling belongs in `llm-llamacpp` first so both
  // move together.
  const bool flashEnabled =
      config.contains("flash-attn") && lower(config.at("flash-attn")) == "on";
  const auto isQuantizedCache = [](const std::string& value) {
    const std::string type = lower(value);
    return type == "q8_0" || type == "q4_0" || type == "q4_1" ||
           type == "iq4_nl" || type == "q5_0" || type == "q5_1" ||
           type == "tbq3_0" || type == "tbq4_0" || type == "pq3_0" ||
           type == "pq4_0";
  };
  const auto isTurboPolarCache = [](const std::string& value) {
    const std::string type = lower(value);
    return type == "tbq3_0" || type == "tbq4_0" || type == "pq3_0" ||
           type == "pq4_0";
  };
  const auto isOpenClSafeCache = [](const std::string& value) {
    const std::string type = lower(value);
    return type == "f32" || type == "f16" || type == "bf16";
  };
  const bool quantizedK = config.contains("cache-type-k") &&
                          isQuantizedCache(config.at("cache-type-k"));
  const bool quantizedV = config.contains("cache-type-v") &&
                          isQuantizedCache(config.at("cache-type-v"));
  if (isOpenCl && ((config.contains("cache-type-k") &&
                    !isOpenClSafeCache(config.at("cache-type-k"))) ||
                   (config.contains("cache-type-v") &&
                    !isOpenClSafeCache(config.at("cache-type-v"))))) {
    return unsupported(
        "only f32, f16, and bf16 KV cache are supported on Adreno OpenCL");
  }
  if (isMetal && ((config.contains("cache-type-k") &&
                   isTurboPolarCache(config.at("cache-type-k"))) ||
                  (config.contains("cache-type-v") &&
                   isTurboPolarCache(config.at("cache-type-v"))))) {
    return unsupported(
        "TurboQuant and PolarQuant KV cache are not supported on Metal");
  }
  if (isAdrenoVulkan && flashEnabled && (quantizedK || quantizedV)) {
    return unsupported(
        "quantized KV cache with flash attention is not supported on Adreno "
        "800+ Vulkan");
  }
  if (!isEmbedding && useGpu && flashEnabled && !isOpenCl && !isAdrenoVulkan &&
      !config.contains("cache-type-k") && !config.contains("cache-type-v")) {
    config["cache-type-k"] = "q8_0";
    config["cache-type-v"] = "q8_0";
  }

  if (!isEmbedding && isBitnet &&
      selection.adrenoVersion >= ADRENO_UBATCH_THRESHOLD) {
    const auto ubatchIt = config.find("ubatch-size");
    const int ubatch = ubatchIt == config.end()
                           ? ADRENO_UBATCH_CAP
                           : std::min(
                                 parseInteger(ubatchIt->second, "ubatch-size"),
                                 ADRENO_UBATCH_CAP);
    config["ubatch-size"] = std::to_string(ubatch);
  }

  NormalizedLlamaLoad out = parseGenericConfig(loadKind, modelPath, config);
  if (!out.supported) {
    return out;
  }

  out.params.use_mmap = !noMmap;
  out.params.split_mode = splitMode;
  if (isEmbedding) {
    if (out.params.n_parallel == 1) {
      out.params.kv_unified = true;
    }
    out.params.n_ubatch = out.params.n_batch;
  }
  // `llama_model_params::devices` is a NULL-terminated list (llama.h:296) and
  // `llama_prepare_model_devices` walks it looking for that terminator
  // (llama.cpp:154) on every load, `no_alloc` fits included. An empty vector is
  // not the same as an empty list either: `common_model_params_to_llama` only
  // forwards a non-empty vector (common.cpp:1645), so clearing it left
  // `devices` null and sent fabric down its "default device selection" branch —
  // every GPU enumerated, and the host-memory arm of `common/fit.cpp` that
  // actually constrains a CPU load skipped. The addons avoid both by emitting
  // `--device none` / `--device <name>` and letting `parse_device_list` append
  // the sentinel (common/arg.cpp:978); these lists carry it explicitly.
  if (!useGpu) {
    out.params.devices = {nullptr};
    out.params.main_gpu = -1;
  } else {
    if (splitMode == LLAMA_SPLIT_MODE_NONE && selected->handle != nullptr) {
      out.params.devices = {selected->handle, nullptr};
      out.params.main_gpu = 0;
    } else {
      out.params.main_gpu = mainGpu.value_or(0);
    }
  }
  return out;
}

void applyEmbeddingContextPolicy(common_params& params, uint32_t trainedCtx) {
  // Mirrors `embed-llamacpp`'s `adjustEmbeddingContextSize`
  // (BertModel.cpp:293-316). The pin is the load-bearing half: `common/fit.h`
  // documents that the fitter rewrites the context size "if and only if equal
  // to 0", so leaving an unset embedding context at 0 invites it to report a
  // reduced `nCtx` — and a correspondingly reduced memory figure — for a load
  // that will run at the full trained context. The cap is the other direction:
  // the addon accepts an oversized request after capping it, so rejecting it
  // here would hard-error on a load that succeeds.
  if (trainedCtx == 0) {
    return;
  }
  if (params.n_ctx == 0 || static_cast<uint32_t>(params.n_ctx) > trainedCtx) {
    params.n_ctx = static_cast<int32_t>(trainedCtx);
  }
}

NormalizedLlamaLoad normalizeLlamaLoadConfig(
    const std::string& modelPath, LlamaConfigMap config,
    const ModelTraits& traits, const std::vector<BackendDevice>& devices,
    LlamaFitPlatform platform) {
  return normalizeLlamaLoadConfig(
      LlamaLoadKind::Completion,
      modelPath,
      std::move(config),
      traits,
      devices,
      platform);
}

LlamaFitExecution invokeLlamaFit(
    const std::string& modelPath, common_params& params, uint32_t marginMiB,
    uint32_t nCtxMin, const LlamaFitInvoker& invoker) {
  LlamaFitExecution execution;
  const size_t maxDevices = llama_max_devices();
  execution.modelParams = common_model_params_to_llama(params);
  execution.contextParams = common_context_params_to_llama(params);
  execution.tensorSplit.assign(
      std::begin(params.tensor_split),
      std::begin(params.tensor_split) + maxDevices);
  execution.buftOverrides.resize(llama_max_tensor_buft_overrides());
  const size_t configuredOverrides = std::min(
      params.tensor_buft_overrides.size(), execution.buftOverrides.size());
  std::copy_n(
      params.tensor_buft_overrides.begin(),
      configuredOverrides,
      execution.buftOverrides.begin());
  std::vector<size_t> margins(
      maxDevices, static_cast<size_t>(marginMiB) * 1024ULL * 1024ULL);

  execution.status = invoker(
      modelPath.c_str(),
      &execution.modelParams,
      &execution.contextParams,
      execution.tensorSplit.data(),
      execution.buftOverrides.data(),
      margins.data(),
      nCtxMin,
      GGML_LOG_LEVEL_INFO);
  return execution;
}

bool withSupportedLlamaLoad(
    NormalizedLlamaLoad& normalized, const SupportedLlamaLoadHandler& handler) {
  if (!normalized.supported) {
    return false;
  }
  handler(normalized.params);
  return true;
}

} // namespace model_fit
