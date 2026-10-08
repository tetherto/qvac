#include "LlamaModelLoader.hpp"

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <initializer_list>
#include <map>
#include <optional>
#include <ranges>
#include <sstream>
#include <utility>
#include <vector>

#include <common/common.h>
#include <inference-addon-cpp/Errors.hpp>
#include <llama.h>
#include <llama/common/arg.h>
#include <llama/common/log.h>
#ifdef __APPLE__
#include <TargetConditionals.h>
#endif

#include "addon/BertErrors.hpp"
#include "inference-addon-cpp/LlamacppUtils.hpp"
#include "logging.hpp"
#include "utils.hpp"

using namespace qvac_lib_infer_llamacpp_embed::errors;
using namespace qvac_lib_infer_llamacpp_embed::logging;

namespace {
// Trim each token and drop empties so "1,,2" and "1, 2" both count two shares,
// matching how fabric's --tensor-split handler tokenizes on `[,/]+`.
std::vector<std::string> split(const std::string& str, char delimiter) {
  auto trim = [](const std::string& value) -> std::string {
    auto start = std::ranges::find_if(value, [](unsigned char character) {
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

bool hasContextSizeConfig(
    const std::unordered_map<std::string, std::string>& configFilemap) {
  return configFilemap.contains("ctx_size") ||
         configFilemap.contains("ctx-size");
}
} // namespace

void applySplitDeviceSelection(
    common_params& params, std::unordered_map<std::string, std::string>& config,
    const backend_selection::SplitDeviceSelection& selection) {
  if (selection.devices.empty()) {
    return;
  }

  auto hyphen = config.find("tensor-split");
  auto underscore = config.find("tensor_split");
  if (hyphen != config.end() && underscore != config.end()) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "both 'tensor-split' and 'tensor_split' are present; use one or the "
        "other.");
  }
  auto tensorSplit = hyphen != config.end() ? hyphen : underscore;
  if (tensorSplit != config.end()) {
    std::string normalized = tensorSplit->second;
    std::ranges::replace(normalized, '/', ',');
    const std::vector<std::string> proportions = split(normalized, ',');
    // Re-join from the tokens: fabric keeps empty and whitespace-only fields
    // (',1,2', '1, ,2') and its std::stof throws on them.
    auto join = [](const std::vector<std::string>& shares) {
      std::string joined;
      for (const std::string& share : shares) {
        if (!joined.empty()) {
          joined += ',';
        }
        joined += share;
      }
      return joined;
    };
    // Final order wins on a tie: this addon pins params.devices itself, so
    // fabric applies share i to final device i. Rejecting a mismatch is on us —
    // fabric checks only llama_max_devices, then zero-pads or truncates.
    if (proportions.size() == selection.devices.size()) {
      tensorSplit->second = join(proportions);
    } else if (proportions.size() != selection.sourceGpuCount) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          string_format(
              "tensor-split has %zu values, which matches neither the %zu "
              "registered GPU devices nor the %zu eligible devices.",
              proportions.size(),
              selection.sourceGpuCount,
              selection.devices.size()));
    } else {
      std::vector<std::string> remapped;
      remapped.reserve(selection.devices.size());
      for (const backend_selection::SplitDevice& device : selection.devices) {
        remapped.push_back(proportions[device.sourceGpuIndex]);
      }
      tensorSplit->second = join(remapped);
    }
  }

  params.devices.clear();
  params.devices.reserve(selection.devices.size() + 1);
  for (const backend_selection::SplitDevice& device : selection.devices) {
    params.devices.push_back(device.handle);
  }
  params.devices.push_back(nullptr);
}

SplitBackendTraits
splitBackendTraits(const backend_selection::SplitDeviceSelection& selection) {
  const auto local = std::ranges::find_if(
      selection.devices, [](const backend_selection::SplitDevice& device) {
        return !device.isRpc;
      });
  const backend_selection::SplitDevice& reported =
      local != selection.devices.end() ? *local : selection.devices.front();
  return {
      .backendName = reported.name,
      .isOpenCl = std::ranges::any_of(
          selection.devices, [](const backend_selection::SplitDevice& device) {
            return device.isOpenCl;
          })};
}

namespace {
llama_split_mode
parseSplitMode(std::unordered_map<std::string, std::string>& configFilemap) {
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
  auto splitModeIt = (hIt != configFilemap.end()) ? hIt : uIt;
  if (splitModeIt == configFilemap.end()) {
    return LLAMA_SPLIT_MODE_NONE;
  }
  std::string val = splitModeIt->second;
  std::ranges::transform(val, val.begin(), ::tolower);
  llama_split_mode splitMode = LLAMA_SPLIT_MODE_NONE;
  if (val == "layer") {
    splitMode = LLAMA_SPLIT_MODE_LAYER;
  } else if (val == "row") {
    // Needs split buffers from every device in the split set; no backend this
    // addon admits provides them.
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        string_format(
            "%s: split-mode 'row' is no longer accepted; it never took effect "
            "on any shipped backend. Use 'layer' (accepted values: 'none', "
            "'layer').\n",
            __func__));
  } else if (val != "none") {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        string_format(
            "%s: invalid split-mode '%s', must be 'none' or 'layer'.\n",
            __func__,
            splitModeIt->second.c_str()));
  }
  configFilemap.erase(splitModeIt);
  return splitMode;
}

} // namespace

LlamaModelSetup setupParams(
    const std::string& modelGgufPath,
    std::unordered_map<std::string, std::string> configFilemap) {
  LlamaModelSetup result{};
  common_params& params = result.params;
  result.ctxSizeConfigured = hasContextSizeConfig(configFilemap);

  // Override default params
  std::vector<std::string> configVector;
  // Add program name as first arg
  configVector.emplace_back("llama");
  configVector.emplace_back("--model");
  configVector.emplace_back(modelGgufPath);

  llama_split_mode splitMode = parseSplitMode(configFilemap);

#if defined(__ANDROID__) ||                                                    \
    (defined(__APPLE__) && defined(TARGET_OS_IOS) && TARGET_OS_IOS)
  if (splitMode != LLAMA_SPLIT_MODE_NONE ||
      configFilemap.count("main-gpu") > 0 ||
      configFilemap.count("main_gpu") > 0 ||
      configFilemap.count("tensor-split") > 0 ||
      configFilemap.count("tensor_split") > 0) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        "Multi-GPU parameters (split-mode, main-gpu, tensor-split) are not "
        "supported on mobile (single-GPU device).");
  }
#endif

  auto deviceIt = configFilemap.find("device");
  if (deviceIt == configFilemap.end()) {
    std::string errorMsg =
        string_format("%s: must specify a device: 'gpu' or 'cpu'.\n", __func__);
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        errorMsg);
  }

  {
    using namespace backend_selection;
    const BackendType preferredBackend =
        preferredBackendTypeFromString(deviceIt->second);
    const std::optional<MainGpu> mainGpu = tryMainGpuFromMap(configFilemap);
    std::pair<BackendType, std::string> chosenBackend{BackendType::CPU, "none"};
    SplitDeviceSelection splitSelection;
    bool isOpenCl = false;
    if (preferredBackend == BackendType::GPU &&
        splitMode != LLAMA_SPLIT_MODE_NONE) {
      splitSelection = getSplitDeviceSelection();
      if (!splitSelection.devices.empty()) {
        const SplitBackendTraits traits = splitBackendTraits(splitSelection);
        chosenBackend = {BackendType::GPU, traits.backendName};
        isOpenCl = traits.isOpenCl;
      } else if (!splitSelection.rejectedDevices.empty()) {
        std::string message =
            "[LlamaModelLoader] no eligible GPU backend found; rejected ";
        for (size_t index = 0; index < splitSelection.rejectedDevices.size();
             ++index) {
          if (index > 0) {
            message += ", ";
          }
          message += splitSelection.rejectedDevices[index];
        }
        message += "; falling back to CPU\n";
        llamaLogCallback(GGML_LOG_LEVEL_WARN, message.c_str(), nullptr);
      }
    } else {
      chosenBackend =
          chooseBackend(preferredBackend, llamaLogCallback, mainGpu);
      // Name-based: chooseBackend returns only a name, no registry handle.
      isOpenCl = chosenBackend.first == BackendType::GPU &&
                 chosenBackend.second.find("opencl") != std::string::npos;
    }
    const bool useGpu = chosenBackend.first == BackendType::GPU;

    if (useGpu) {
      result.resolvedBackendDevice = 1;
      params.split_mode = splitMode;

      if (splitMode != LLAMA_SPLIT_MODE_NONE && mainGpu.has_value()) {
        qvac_lib_infer_llamacpp_embed::logging::llamaLogCallback(
            GGML_LOG_LEVEL_WARN,
            "[LlamaModelLoader] main-gpu is ignored in multi-GPU split-mode\n",
            nullptr);
      }
      if (splitMode != LLAMA_SPLIT_MODE_NONE) {
        applySplitDeviceSelection(params, configFilemap, splitSelection);
        std::string deviceList;
        for (const SplitDevice& device : splitSelection.devices) {
          if (!deviceList.empty()) {
            deviceList += ",";
          }
          deviceList += device.name;
        }
        qvac_lib_infer_llamacpp_embed::logging::llamaLogCallback(
            GGML_LOG_LEVEL_INFO,
            string_format(
                "[LlamaModelLoader] split mode: pinning to %zu eligible "
                "device(s): "
                "%s\n",
                splitSelection.devices.size(),
                deviceList.c_str())
                .c_str(),
            nullptr);
      }
    } else if (chosenBackend.first == BackendType::CPU) {
      result.resolvedBackendDevice = 0;
      params.split_mode = LLAMA_SPLIT_MODE_NONE;
      params.main_gpu = -1;
      if (splitMode != LLAMA_SPLIT_MODE_NONE) {
        qvac_lib_infer_llamacpp_embed::logging::llamaLogCallback(
            GGML_LOG_LEVEL_WARN,
            "[LlamaModelLoader] split-mode, tensor-split and main-gpu ignored: "
            "no eligible named GPU device available, falling back to CPU\n",
            nullptr);
        splitMode = LLAMA_SPLIT_MODE_NONE;
        configFilemap.erase("tensor-split");
        configFilemap.erase("tensor_split");
      }
    } else {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InternalError,
          "preferredDeviceFromString: wrong deduced device, must be 'gpu' or "
          "'cpu'.\n");
    }
    if (splitMode == LLAMA_SPLIT_MODE_NONE) {
      configVector.emplace_back("--device");
      configVector.emplace_back(chosenBackend.second);
    }
    configFilemap.erase(deviceIt);

    // Disable flash attention by default when the chosen GPU backend is
    // OpenCL: it is not reliably supported there. Users who pass an
    // explicit "flash-attn"/"flash_attn" override are respected.
    const bool userSetFlashAttn = configFilemap.contains("flash-attn") ||
                                  configFilemap.contains("flash_attn");
    if (isOpenCl && !userSetFlashAttn) {
      configFilemap["flash-attn"] = "off";
      qvac_lib_infer_llamacpp_embed::logging::llamaLogCallback(
          GGML_LOG_LEVEL_INFO,
          "[LlamaModelLoader] OpenCL backend selected: disabling flash "
          "attention by "
          "default (not reliably supported on OpenCL)\n",
          nullptr);
    }
  }

  // The deprecated load flags are no longer in fabric's argument table, so
  // the mode they select is passed as --load-mode. An explicit load-mode wins.
  std::optional<llama_load_mode> deprecatedMode;
  const char* deprecatedKey = nullptr;
  for (const char* key :
       {"mmap", "no-mmap", "direct-io", "no-direct-io", "mlock"}) {
    const auto it = configFilemap.find(key);
    if (it == configFilemap.end()) {
      continue;
    }
    llama_load_mode mode = LLAMA_LOAD_MODE_NONE;
    try {
      mode = deprecatedLoadFlagMode(key, it->second).value();
    } catch (const std::invalid_argument& e) {
      throw qvac_errors::StatusError(
          ADDON_ID, toString(InvalidConfiguration), e.what());
    }
    if (deprecatedMode.has_value() && deprecatedMode.value() != mode) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(InvalidConfiguration),
          string_format(
              "'%s' and '%s' select different load modes; use 'load-mode' "
              "instead",
              deprecatedKey,
              key));
    }
    deprecatedMode = mode;
    deprecatedKey = key;
    configFilemap.erase(it);
  }
  if (deprecatedMode.has_value()) {
    if (configFilemap.contains("load-mode")) {
      qvac_lib_infer_llamacpp_embed::logging::llamaLogCallback(
          GGML_LOG_LEVEL_WARN,
          string_format(
              "[LlamaModelLoader] '%s' ignored: 'load-mode' is set\n",
              deprecatedKey)
              .c_str(),
          nullptr);
    } else {
      configFilemap["load-mode"] = loadModeName(deprecatedMode.value());
    }
  }

  for (const auto& [key, value] : configFilemap) {
    if (key.empty()) {
      continue;
    }
    configVector.emplace_back(std::string("--") + key);
    if (!value.empty()) {
      configVector.emplace_back(value);
    }
  }

  // Convert to argc/argv format
  std::vector<char*> argv;
  argv.reserve(configVector.size());
  for (std::string& argString : configVector) {
    argv.push_back(argString.data());
  }
  int argc = static_cast<int>(argv.size());

  if (!common_params_parse(
          argc, argv.data(), params, LLAMA_EXAMPLE_EMBEDDING)) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(InvalidConfiguration),
        "Invalid configuration parameters.");
  }

  return result;
}

void LlamaModelLoader::resolveShardPaths(
    GGUFShards& shards, const std::string& modelPath) {
  if (shards.gguf_files.empty()) {
    return;
  }
  const std::filesystem::path baseDir =
      std::filesystem::path(modelPath).parent_path();
  if (baseDir.empty()) {
    return;
  }
  for (std::string& f : shards.gguf_files) {
    f = (baseDir / f).string();
  }
  shards.tensors_file = (baseDir / shards.tensors_file).string();
}

LlamaModelLoader::LlamaModelLoader(
    const std::string& modelName, Hooks hooks, const std::string& modelGgufPath,
    const std::unordered_map<std::string, std::string>& config,
    const std::string& backendsDir)
    : hooks_(std::move(hooks)),
      loadingContext_(InitLoader::getLoadingContext(modelName)),
      shards_(GGUFShards::expandGGUFIntoShards(modelGgufPath)),
      asyncWeightsLoader_(shards_, initLoader_, loadingContext_, &metadata_) {
  auto modelInit = [this](
                       const std::string& path,
                       const std::unordered_map<std::string, std::string>& cfg,
                       const std::string& backendsDir) {
    this->init(path, cfg, backendsDir);
  };
  initLoader_.init(
      InitLoader::LOADER_TYPE::DELAYED,
      modelInit,
      modelGgufPath,
      config,
      backendsDir);
}

LlamaModelLoader::LlamaModelLoader(
    const std::string& modelName, Hooks hooks, LlamaModelSetup& setup)
    : hooks_(std::move(hooks)),
      loadingContext_(InitLoader::getLoadingContext(modelName)),
      shards_(GGUFShards::expandGGUFIntoShards(setup.params.model.path)),
      asyncWeightsLoader_(shards_, initLoader_, loadingContext_, &metadata_) {
  auto modelInit = [this](LlamaModelSetup s) { this->init(s); };

  initLoader_.init(InitLoader::LOADER_TYPE::DELAYED, modelInit, setup);
}

void LlamaModelLoader::init(
    const std::string& modelGgufPath,
    const std::unordered_map<std::string, std::string>& config,
    const std::string& backendsDir) {
  // Need to initialize backend before setupParams to properly
  // detect available backends and choose properly among them

  // Extract and set verbosity level from config (modifies configCopy)
  auto configCopy = config;
  setVerbosityLevel(configCopy);

  std::string openclCacheDir;
  if (auto configIt = configCopy.find("openclCacheDir");
      configIt != configCopy.end()) {
    openclCacheDir = configIt->second;
    configCopy.erase(configIt);
  }

  lazyCommonInit();
  initializeBackend(backendsDir, openclCacheDir);

  LlamaModelSetup setup = setupParams(modelGgufPath, configCopy);
  LlamaModelLoader::init(setup);
}

void LlamaModelLoader::init(LlamaModelSetup& setup) {
  runtimeBackendDevice_ = setup.resolvedBackendDevice;
  common_params& params = setup.params;

  lazyCommonInit();
  initializeBackend();
  llama_numa_init(params.numa);

  const std::string errorWhenFailed = toString(UnableToLoadModel);

  if (!asyncWeightsLoader_.isStreaming()) {
    LlamaModelLoader::resolveShardPaths(shards_, params.model.path);
  }

  metadata_.parse(
      params.model.path, shards_, asyncWeightsLoader_.isStreaming(), ADDON_ID);
  if (hooks_.configureParams) {
    hooks_.configureParams(params, metadata_, setup.ctxSizeConfigured);
  }

  std::map<std::string, std::unique_ptr<std::basic_streambuf<char>>>
      streamedFiles = asyncWeightsLoader_.extractIndividualStreamedFiles();

  common_init_result_ptr llamaInit = initFromConfig(
      params,
      params.model.path,
      streamedFiles,
      shards_,
      loadingContext_,
      asyncWeightsLoader_.isStreaming(),
      ADDON_ID,
      errorWhenFailed);

  init_.params = params;
  init_.result = std::move(llamaInit);
  model_ = init_.result->model();
  ctx_ = init_.result->context();
  // common_init_from_params returns a result with a null model/context when the
  // model fails to load (corrupt GGUF, or no usable backend under
  // GGML_BACKEND_DL). Fail loudly here rather than dereferencing null below
  // (which segfaults the process instead of surfacing a catchable error).
  if (model_ == nullptr || ctx_ == nullptr) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToLoadModel),
        "model initialization returned a null model/context");
  }
  if (hooks_.onLoaded) {
    hooks_.onLoaded(model_, ctx_);
  }

  // print system information
  {
    qvac_lib_infer_llamacpp_embed::logging::llamaLogCallback(
        GGML_LOG_LEVEL_INFO,
        string_format(
            "%s\n", common_params_get_system_info(init_.params).c_str())
            .c_str(),
        nullptr);
  }
  loaded_ = true;
}

void LlamaModelLoader::initializeBackend(
    const std::string& backendsDir, const std::string& openclCacheDir) {
  backendsHandle_ = LlamaBackendsHandle(backendsDir, openclCacheDir);
}

void LlamaModelLoader::setWeightsForFile(
    const std::string& filename,
    std::unique_ptr<std::basic_streambuf<char>>&& shard) {
  asyncWeightsLoader_.setWeightsForFile(filename, std::move(shard));
}

bool LlamaModelLoader::isLoaded() const {
  return loaded_ && model_ != nullptr && ctx_ != nullptr;
}
