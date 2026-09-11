#include "BertModel.hpp"

#include <algorithm>
#include <any>
#include <cctype>
#include <cstring>
#include <map>
#include <ranges>
#include <sstream>
#include <stdexcept>
#include <utility>

#include <common/common.h>
#include <inference-addon-cpp/Errors.hpp>
#include <llama-cpp.h>
#include <llama.h>
#include <llama/common/arg.h>
#ifdef __APPLE__
#include <TargetConditionals.h>
#endif

#include "BackendSelection.hpp"
#include "LlamaLazyInitializeBackend.hpp"
#include "ModelMetadata.hpp"
#include "addon/BertErrors.hpp"
#include "inference-addon-cpp/GGUFShards.hpp"
#include "inference-addon-cpp/LlamacppUtils.hpp"
#include "logging.hpp"
#include "utils.hpp"

using namespace qvac_lib_infer_llamacpp_embed::errors;
using namespace qvac_lib_infer_llamacpp_embed::logging;

namespace {

void batchAddSeq(
    llama_batch& batch, const std::vector<int32_t>& tokens,
    llama_seq_id seqId) {
  size_t numTokens = tokens.size();
  for (size_t i = 0; i < numTokens; i++) {
    common_batch_add(
        batch, tokens[i], static_cast<llama_pos>(i), {seqId}, true);
  }
}

// NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
void batchDecode(
    llama_context* ctx, llama_batch& batch, float* output,
    std::size_t numSeq, // NOLINT(bugprone-easily-swappable-parameters)
    int numEmbd,
    int embeddingNorm) /* NOLINT(bugprone-easily-swappable-parameters) */ {
  enum llama_pooling_type poolingType = llama_pooling_type(ctx);

  // clear previous kv_cache values (irrelevant for embeddings)
  llama_memory_clear(llama_get_memory(ctx), true);

  // run model
  qvac_lib_infer_llamacpp_embed::logging::llamaLogCallback(
      GGML_LOG_LEVEL_INFO,
      string_format(
          "%s: n_tokens = %d, numSeq = %zu\n", __func__, batch.n_tokens, numSeq)
          .c_str(),
      nullptr);
  if (llama_decode(ctx, batch) < 0) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(DecodeFailed),
        string_format("%s: llama_decode failed", __func__));
  }

  std::span<const int8_t> logitsSpan{
      batch.logits, static_cast<std::size_t>(batch.n_tokens)};

  for (int i = 0; i < batch.n_tokens; i++) {
    if (logitsSpan[i] == 0) {
      continue;
    }

    const float* embd = nullptr;
    int embeddingPos = 0;

    if (poolingType == LLAMA_POOLING_TYPE_NONE) {
      // try to get token embeddings
      embd = llama_get_embeddings_ith(ctx, i);
      embeddingPos = i;
      if (embd == nullptr) {
        throw qvac_errors::StatusError(
            ADDON_ID,
            toString(FailedToGetTokenEmbeddings),
            "Failed to get token embeddings");
      }
    } else {
      // try to get sequence embeddings - supported only when pooling_type is
      // not NONE
      embd = llama_get_embeddings_seq(
          ctx,
          // NOLINTNEXTLINE(cppcoreguidelines-pro-bounds-pointer-arithmetic)
          *batch.seq_id[i]);
      // NOLINTNEXTLINE(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      embeddingPos = *batch.seq_id[i];
      if (embd == nullptr) {
        throw qvac_errors::StatusError(
            ADDON_ID,
            toString(FailedToGetSequenceEmbeddings),
            "Failed to get sequence embeddings");
      }
    }

    std::size_t outputIndexOffset = static_cast<std::size_t>(embeddingPos) *
                                    static_cast<std::size_t>(numEmbd);
    std::size_t capacityCount = (poolingType == LLAMA_POOLING_TYPE_NONE)
                                    ? static_cast<std::size_t>(batch.n_tokens)
                                    : numSeq;
    std::span<float> outputSpan{
        output, capacityCount * static_cast<std::size_t>(numEmbd)};
    float* out = outputSpan.subspan(outputIndexOffset).data();
    common_embd_normalize(embd, out, numEmbd, embeddingNorm);
  }
}

// Helper functions to reduce cognitive complexity in tokenizeInput
std::vector<std::vector<int32_t>>
tokenizePrompts(llama_context* ctx, const std::vector<std::string>& prompts) {
  std::vector<std::vector<int32_t>> results;
  results.reserve(prompts.size());
  for (const auto& prompt : prompts) {
    results.emplace_back(common_tokenize(ctx, prompt, true, true));
  }
  return results;
}

void validateBatchLimitsOrThrow(
    const std::vector<std::vector<int32_t>>& inputs, uint64_t nBatch) {
  for (const auto& inp : inputs) {
    if (inp.size() > nBatch) {
      std::string msg = string_format(
          "%s: batch overflow: number of tokens in input line (%zu) exceeds "
          "batch size (%llu), increase batch size and re-run",
          __func__,
          inp.size(),
          static_cast<unsigned long long>(nBatch));
      throw qvac_errors::StatusError(
          ADDON_ID, toString(InputTokensExceedBatchSize), msg);
    }
  }
}

void ensureLastTokenIsSpecial(
    const llama_vocab* vocab, const std::vector<std::vector<int32_t>>& inputs) {
  // Determine the expected ending token based on vocab type
  enum llama_vocab_type vocabType = llama_vocab_type(vocab);
  llama_token expectedToken = LLAMA_TOKEN_NULL;
  const char* tokenName = nullptr;
  const char* metadataKey = nullptr;

  switch (vocabType) {
  case LLAMA_VOCAB_TYPE_WPM:
    // BERT-style models use SEP token
    expectedToken = llama_vocab_sep(vocab);
    tokenName = "SEP";
    metadataKey = "tokenizer.ggml.add_sep_token";
    break;
  case LLAMA_VOCAB_TYPE_SPM:
  case LLAMA_VOCAB_TYPE_BPE:
  case LLAMA_VOCAB_TYPE_UGM:
    // SentencePiece and BPE models use EOS token
    expectedToken = llama_vocab_eos(vocab);
    tokenName = "EOS";
    metadataKey = "tokenizer.ggml.add_eos_token";
    break;
  default:
    // For other vocab types, skip the check
    return;
  }

  // If the expected token is not defined, skip the check
  if (expectedToken == LLAMA_TOKEN_NULL) {
    return;
  }

  // Check each input sequence
  for (const auto& inp : inputs) {
    if (inp.empty() || inp.back() != expectedToken) {
      qvac_lib_infer_llamacpp_embed::logging::llamaLogCallback(
          GGML_LOG_LEVEL_WARN,
          string_format(
              "%s: last token in the prompt is not %s (expected token ID: %d, "
              "got: "
              "%d)\n",
              __func__,
              tokenName,
              expectedToken,
              inp.empty() ? -1 : inp.back())
              .c_str(),
          nullptr);
      qvac_lib_infer_llamacpp_embed::logging::llamaLogCallback(
          GGML_LOG_LEVEL_WARN,
          string_format(
              "%s: '%s' should be set to 'true' in the GGUF header\n",
              __func__,
              metadataKey)
              .c_str(),
          nullptr);
    }
  }
}

void logPrompt(
    llama_context* ctx, const std::vector<int32_t>& input,
    const std::string& prompt) {
  qvac_lib_infer_llamacpp_embed::logging::llamaLogCallback(
      GGML_LOG_LEVEL_INFO,
      string_format("%s: prompt: '%s'\n", __func__, prompt.c_str()).c_str(),
      nullptr);
  qvac_lib_infer_llamacpp_embed::logging::llamaLogCallback(
      GGML_LOG_LEVEL_INFO,
      string_format(
          "%s: number of tokens in prompt = %zu\n", __func__, input.size())
          .c_str(),
      nullptr);
  for (int token : input) {
    qvac_lib_infer_llamacpp_embed::logging::llamaLogCallback(
        GGML_LOG_LEVEL_INFO,
        string_format(
            "%6d -> '%s'\n", token, common_token_to_piece(ctx, token).c_str())
            .c_str(),
        nullptr);
  }
}

void logTokenizationIfVerbose(
    bool verbose, llama_context* ctx,
    const std::vector<std::vector<int32_t>>& inputs,
    const std::vector<std::string>& prompts) {
  if (!verbose) {
    return;
  }
  for (std::size_t i = 0; i < inputs.size(); ++i) {
    logPrompt(ctx, inputs[i], prompts[i]);
  }
}

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

int getEffectiveContextSize(
    const llama_model* model, const llama_context* ctx) {
  return std::min(
      llama_model_n_ctx_train(model), static_cast<int>(llama_n_ctx(ctx)));
}

/// @brief Reads the model's trained context size from already-parsed GGUF
/// metadata. Emits an ERROR-level diagnostic and returns nullopt when the
/// architecture key or `<arch>.context_length` key is missing.
std::optional<int> readTrainedContextSize(const ModelMetaData& metadata) {
  auto logMetaFailure = [](const std::string& detail) {
    qvac_lib_infer_llamacpp_embed::logging::llamaLogCallback(
        GGML_LOG_LEVEL_ERROR,
        string_format(
            "readTrainedContextSize: %s; falling back to llama.cpp default "
            "ctx_size\n",
            detail.c_str())
            .c_str(),
        nullptr);
  };

  std::optional<std::string> architecture =
      metadata.tryGetString("general.architecture");
  if (!architecture.has_value() || architecture->empty()) {
    logMetaFailure("missing 'general.architecture' key");
    return std::nullopt;
  }

  const std::string contextLengthKey = *architecture + ".context_length";
  std::optional<uint32_t> trainedCtx =
      metadata.tryGetU32(contextLengthKey.c_str());
  if (!trainedCtx.has_value()) {
    logMetaFailure("missing '" + contextLengthKey + "' key");
    return std::nullopt;
  }

  return static_cast<int>(*trainedCtx);
}

/// @brief Adjusts @p params.n_ctx so the runtime context does not exceed the
/// model's trained context. When the caller did not configure ctx_size, the
/// trained context is used as the default (overriding llama.cpp's hard-coded
/// 4096 fallback). When the caller configured an oversized ctx_size, it is
/// capped and an ERROR-level message is emitted so users see it without
/// bumping verbosity.
void adjustEmbeddingContextSize(
    common_params& params, int trainedCtx, bool ctxSizeConfigured) {
  const int requestedCtx = params.n_ctx;

  if (!ctxSizeConfigured) {
    params.n_ctx = trainedCtx;
    return;
  }

  if (requestedCtx > trainedCtx) {
    params.n_ctx = trainedCtx;
    qvac_lib_infer_llamacpp_embed::logging::llamaLogCallback(
        GGML_LOG_LEVEL_ERROR,
        string_format(
            "%s: requested ctx_size %d exceeds model trained context size %d; "
            "capping to %d\n",
            __func__,
            requestedCtx,
            trainedCtx,
            trainedCtx)
            .c_str(),
        nullptr);
  }
}

} // namespace

BertEmbeddings::BertEmbeddings(
    std::vector<float> flatData, BertEmbeddings::Layout layout)
    : flat_embd_(std::move(flatData)), embeddingCount_(layout.embeddingCount),
      embeddingSize_(layout.embeddingSize) {}

std::span<const float> BertEmbeddings::operator[](std::size_t index) const {
  return std::span<const float>(flat_embd_)
      .subspan(index * embeddingSize_, embeddingSize_);
}

std::size_t BertEmbeddings::size() const { return embeddingCount_; }

std::size_t BertEmbeddings::embeddingSize() const { return embeddingSize_; }

bool applySplitDeviceSelection(
    common_params& params, std::unordered_map<std::string, std::string>& config,
    const backend_selection::SplitDeviceSelection& selection) {
  if (selection.devices.empty()) {
    return false;
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
    // Re-join from the tokens rather than forwarding the caller's string.
    // Fabric tokenizes on the regex [,/]+, so a run of delimiters collapses
    // there as it does here and '1,,2' is two shares on both sides. The
    // divergence is an empty or whitespace-only FIELD: fabric keeps it
    // (',1,2' yields a leading "", '1, ,2' a middle " ") and std::stof throws
    // on either, while split() trims and drops it. Such a value would be
    // counted as two shares here and then rejected by fabric's parser.
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
    // Cardinality decides how the list is read, in this order:
    //   1. one share per eligible device -> already in final order
    //   2. one share per registered GPU  -> remap through sourceGpuIndex
    //   3. anything else                 -> reject
    // Final order wins when both counts are equal: this addon pins
    // params.devices itself, so fabric applies share i to final device i.
    // The check runs even when the mapping did not move, because fabric
    // validates only against llama_max_devices; it zero-pads a short list,
    // silently leaving a participating GPU with no layers, and drops the tail
    // of a long one.
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
  return true;
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
    // Row split needs split buffers from every device in the split set and
    // no backend this addon admits provides them, so it never took effect;
    // fabric marks the mode deprecated. Reject it instead of silently
    // loading as 'layer'.
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        string_format(
            "%s: split-mode 'row' is not supported, must be 'none' or "
            "'layer'; use 'layer'.\n",
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

BertModelSetup setupParams(
    const std::string& modelGgufPath,
    std::unordered_map<std::string, std::string> configFilemap) {
  BertModelSetup result{};
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
            "[BertModel] no eligible GPU backend found; rejected ";
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
      // Name-based, unlike the split path, which carries the registry-aware
      // trait through splitBackendTraits. Returning the trait alongside the
      // name would change chooseBackend's signature in both addons, and the
      // gap is unreachable with shipped backends: ggml's OpenCL backend names
      // every device "GPUOpenCL", so name and registry always agree today.
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
            "[BertModel] main-gpu is ignored in multi-GPU split-mode\n",
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
                "[BertModel] split mode: pinning to %zu eligible device(s): "
                "%s\n",
                splitSelection.devices.size(),
                deviceList.c_str())
                .c_str(),
            nullptr);
      }
    } else if (
        chosenBackend.first == BackendType::CPU ||
        chosenBackend.first == BackendType::GPU) {
      result.resolvedBackendDevice = 0;
      params.split_mode = LLAMA_SPLIT_MODE_NONE;
      params.main_gpu = -1;
      if (splitMode != LLAMA_SPLIT_MODE_NONE) {
        qvac_lib_infer_llamacpp_embed::logging::llamaLogCallback(
            GGML_LOG_LEVEL_WARN,
            "[BertModel] split-mode, tensor-split and main-gpu ignored: "
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
      configVector.emplace_back(useGpu ? chosenBackend.second : "none");
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
          "[BertModel] OpenCL backend selected: disabling flash attention by "
          "default (not reliably supported on OpenCL)\n",
          nullptr);
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
} // namespace

void BertModel::resolveShardPaths(
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

BertModel::BertModel(
    const std::string& modelGgufPath,
    const std::unordered_map<std::string, std::string>& config,
    const std::string& backendsDir)
    : model_(nullptr), ctx_(nullptr), vocab_(nullptr), batch_{},
      pooling_type(LLAMA_POOLING_TYPE_NONE), n_embd(0), is_loaded_(false),
      loadingContext_(InitLoader::getLoadingContext("BertModel")),
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

BertModel::BertModel(BertModelSetup& setup)
    : model_(nullptr), ctx_(nullptr), vocab_(nullptr), batch_{},
      pooling_type(LLAMA_POOLING_TYPE_NONE), n_embd(0), is_loaded_(false),
      loadingContext_(InitLoader::getLoadingContext("BertModel")),
      shards_(GGUFShards::expandGGUFIntoShards(setup.params.model.path)),
      asyncWeightsLoader_(shards_, initLoader_, loadingContext_, &metadata_) {
  auto modelInit = [this](BertModelSetup s) { this->init(s); };

  initLoader_.init(InitLoader::LOADER_TYPE::DELAYED, modelInit, setup);
}

void BertModel::init(
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

  BertModelSetup setup = setupParams(modelGgufPath, configCopy);
  BertModel::init(setup);
}

void BertModel::init(BertModelSetup& setup) {
  ctxSizeConfigured_ = setup.ctxSizeConfigured;
  runtimeBackendDevice_ = setup.resolvedBackendDevice;
  common_params& params = setup.params;

  lazyCommonInit();
  initializeBackend();

  params.embedding = true;

  // if the number of prompts that would be encoded is known in advance, it's
  // more efficient to specify the
  //   --parallel argument accordingly. for convenience, if not specified, we
  //   fallback to unified KV cache in order to support any number of prompts
  if (params.n_parallel == 1) {
    qvac_lib_infer_llamacpp_embed::logging::llamaLogCallback(
        GGML_LOG_LEVEL_INFO,
        string_format(
            "%s: n_parallel == 1 -> unified KV cache is enabled\n", __func__)
            .c_str(),
        nullptr);
    params.kv_unified = true;
  }

  // For non-causal models, batch size must be equal to ubatch size
  params.n_ubatch = params.n_batch;

  initializeBackend();
  llama_numa_init(params.numa);

  const std::string errorWhenFailed = toString(UnableToLoadModel);

  if (!asyncWeightsLoader_.isStreaming()) {
    BertModel::resolveShardPaths(shards_, params.model.path);
  }

  metadata_.parse(
      params.model.path, shards_, asyncWeightsLoader_.isStreaming(), ADDON_ID);
  if (std::optional<int> trainedCtx = readTrainedContextSize(metadata_)) {
    adjustEmbeddingContextSize(params, *trainedCtx, ctxSizeConfigured_);
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
  vocab_ = llama_model_get_vocab(model_);
  batch_ = llama_batch_init(init_.params.n_batch, 0, 1);
  pooling_type = llama_pooling_type(ctx_);
  n_embd = llama_model_n_embd(model_);

  // Set up abort callback for cancellation support during llama_decode
  // The callback checks stopCancelled_ and returns true to abort if set
  llama_set_abort_callback(
      ctx_,
      [](void* data) -> bool {
        const auto* model = static_cast<const BertModel*>(data);
        return model->stopCancelled_.load();
      },
      const_cast<BertModel*>(this));

  if (llama_model_has_encoder(model_) && llama_model_has_decoder(model_)) {
    std::string msg = string_format(
        "%s: computing embeddings in encoder-decoder models is not supported",
        __func__);
    throw qvac_errors::StatusError(
        ADDON_ID, toString(UnsupportedEmbeddings), msg);
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
  is_loaded_ = true;
}

BertModel::~BertModel() { llama_batch_free(batch_); }

const llama_context* BertModel::getCtx() const { return ctx_; };

const llama_model* BertModel::getModel() const { return model_; }

std::vector<std::string>
BertModel::preprocessPrompt(const std::string& prompt) const {
  return splitLines(prompt, init_.params.embd_sep);
}

const common_params& BertModel::getCommonParams() const { return init_.params; }

bool BertModel::isLoaded() const {
  return is_loaded_ && model_ != nullptr && ctx_ != nullptr;
}

std::any BertModel::process(const std::any& input) {
  // Clear batch state from any previous inference to ensure deterministic
  // results
  reset();

  if (input.type() == typeid(std::string)) {
    const auto& text = std::any_cast<const std::string&>(input);
    BertEmbeddings result = encodeHostF32(text);
    return result;
  }
  if (input.type() == typeid(std::vector<std::string>)) {
    const auto& sequences =
        std::any_cast<const std::vector<std::string>&>(input);
    BertEmbeddings result = encodeHostF32Sequences(sequences);
    return result;
  }
  throw qvac_errors::StatusError(
      qvac_errors::general_error::InvalidArgument,
      "BertModel::process: unsupported input type");
}

void BertModel::initializeBackend(
    const std::string& backendsDir, const std::string& openclCacheDir) {
  backendsHandle_ = LlamaBackendsHandle(backendsDir, openclCacheDir);
}

void BertModel::reset() {
  stopCancelled_.store(false);
  // Clear the batch state - this is the most important part
  common_batch_clear(batch_);

  // Clear memory and KV cache (llama_memory_clear handles both)
  if (ctx_ != nullptr) {
    llama_memory_clear(llama_get_memory(ctx_), true);
  }
}

void BertModel::cancel() const { stopCancelled_.store(true); }

void BertModel::setWeightsForFile(
    const std::string& filename,
    std::unique_ptr<std::basic_streambuf<char>>&& shard) {
  asyncWeightsLoader_.setWeightsForFile(filename, std::move(shard));
}

std::vector<std::vector<int32_t>>
BertModel::tokenizeInput(const std::vector<std::string>& prompts) const {
  uint64_t nBatch = init_.params.n_batch;

  // tokenize all prompts first
  std::vector<std::vector<int32_t>> inputs = tokenizePrompts(ctx_, prompts);

  // Check for context overflow against the active runtime context, capped by
  // the model's trained context size.
  int effectiveContextSize = getEffectiveContextSize(model_, ctx_);
  for (std::size_t i = 0; i < inputs.size(); ++i) {
    if (std::cmp_greater(inputs[i].size(), effectiveContextSize)) {
      std::string msg = string_format(
          "%s: context overflow: number of tokens in prompt %zu (%zu) exceeds "
          "effective context size (%d)",
          __func__,
          i,
          inputs[i].size(),
          effectiveContextSize);
      throw qvac_errors::StatusError(ADDON_ID, toString(ContextOverflow), msg);
    }
  }

  // validate sizes against batch limits
  validateBatchLimitsOrThrow(inputs, nBatch);

  // ensure last token is the appropriate special token (SEP for BERT, EOS for
  // Gemma, etc.)
  ensureLastTokenIsSpecial(vocab_, inputs);

  // optionally log tokenization details
  logTokenizationIfVerbose(init_.params.verbose_prompt, ctx_, inputs, prompts);

  return inputs;
}

BertEmbeddings BertModel::processBatched(
    const std::vector<std::vector<int32_t>>& inputs,
    std::size_t nPrompts) const {
  // count number of embeddings
  std::size_t embeddingCount = 0;
  if (pooling_type == LLAMA_POOLING_TYPE_NONE) {
    for (std::size_t k = 0; k < nPrompts; k++) {
      embeddingCount += inputs[k].size();
    }
  } else {
    embeddingCount = nPrompts;
  }

  // allocate output
  std::vector<float> embeddings(
      embeddingCount * static_cast<std::size_t>(n_embd), 0.0F);
  float* emb = embeddings.data();

  // break into batches
  std::size_t numStoredEmbeddings = 0; // number of embeddings already stored
  std::size_t numPromptsInBatch = 0;   // number of prompts in current batch

  for (std::size_t k = 0; k < nPrompts && !stopCancelled_.load(); k++) {
    // clamp to n_batch tokens
    const auto& inp = inputs[k];

    uint64_t numTokensInPrompt = inp.size();

    // encode if at capacity
    if (batch_.n_tokens + numTokensInPrompt > init_.params.n_batch) {
      std::span<float> embSpan{emb, embeddings.size()};
      float* out =
          embSpan
              .subspan(numStoredEmbeddings * static_cast<std::size_t>(n_embd))
              .data();
      try {
        batchDecode(
            ctx_,
            batch_,
            out,
            static_cast<int>(numPromptsInBatch),
            n_embd,
            init_.params.embd_normalize);
      } catch (...) {
        if (stopCancelled_.load()) {
          throw std::runtime_error("Job cancelled");
        }
        throw;
      }
      numStoredEmbeddings +=
          (pooling_type == LLAMA_POOLING_TYPE_NONE ? batch_.n_tokens
                                                   : numPromptsInBatch);
      numPromptsInBatch = 0;
      common_batch_clear(batch_);
    }

    // add to batch
    batchAddSeq(batch_, inp, static_cast<llama_seq_id>(numPromptsInBatch));
    numPromptsInBatch += 1;
  }

  if (stopCancelled_.load()) {
    throw std::runtime_error("Job cancelled");
  }

  // final batch
  std::span<float> embSpan{emb, embeddings.size()};
  float* out =
      embSpan.subspan(numStoredEmbeddings * static_cast<std::size_t>(n_embd))
          .data();
  try {
    batchDecode(
        ctx_,
        batch_,
        out,
        static_cast<int>(numPromptsInBatch),
        n_embd,
        init_.params.embd_normalize);
  } catch (...) {
    if (stopCancelled_.load()) {
      throw std::runtime_error("Job cancelled");
    }
    throw;
  }
  return BertEmbeddings(
      std::move(embeddings),
      BertEmbeddings::Layout{
          .embeddingCount = embeddingCount,
          .embeddingSize = static_cast<std::size_t>(n_embd)});
}

BertEmbeddings
BertModel::encodeHostF32(const std::vector<std::string>& prompts) {
  initLoader_.waitForLoadInitialization();
  std::vector<std::vector<int32_t>> inputTokens = tokenizeInput(prompts);
  return processBatched(inputTokens, prompts.size());
}

BertEmbeddings BertModel::encodeHostF32(const std::string& prompt) {
  // Process as single sequence - delegate to vector version which handles
  // initialization
  std::vector<std::string> prompts = {prompt};
  return encodeHostF32(prompts);
}

BertEmbeddings BertModel::encodeHostF32Sequences(
    const std::vector<std::string>& sequenceArray) {
  initLoader_.waitForLoadInitialization();

  // Early return for empty array (no work needed)
  if (sequenceArray.empty()) {
    return BertEmbeddings(
        std::vector<float>{},
        BertEmbeddings::Layout{
            .embeddingCount = 0,
            .embeddingSize = static_cast<std::size_t>(n_embd)});
  }

  // Tokenize all sequences once and validate context size
  std::vector<std::vector<int32_t>> inputTokens;
  inputTokens.reserve(sequenceArray.size());

  int effectiveContextSize = getEffectiveContextSize(model_, ctx_);
  for (std::size_t i = 0; i < sequenceArray.size(); ++i) {
    if (stopCancelled_.load()) {
      throw std::runtime_error("Job cancelled");
    }
    const auto& sequence = sequenceArray[i];
    std::vector<int32_t> tokens = common_tokenize(ctx_, sequence, true, true);

    // Validate context size during tokenization
    if (std::cmp_greater(tokens.size(), effectiveContextSize)) {
      std::string msg = string_format(
          "%s: context overflow: number of tokens in sequence %zu (%zu) "
          "exceeds effective context size (%d)",
          __func__,
          i,
          tokens.size(),
          effectiveContextSize);
      throw qvac_errors::StatusError(ADDON_ID, toString(ContextOverflow), msg);
    }

    inputTokens.push_back(std::move(tokens));
  }

  // Apply all validations from tokenizeInput (reusing tokenized results)
  uint64_t nBatch = init_.params.n_batch;
  validateBatchLimitsOrThrow(inputTokens, nBatch);
  ensureLastTokenIsSpecial(vocab_, inputTokens);
  logTokenizationIfVerbose(
      init_.params.verbose_prompt, ctx_, inputTokens, sequenceArray);

  // Process tokenized sequences directly (avoids re-tokenization)
  return processBatched(inputTokens, sequenceArray.size());
}

qvac_lib_inference_addon_cpp::RuntimeStats BertModel::runtimeStats() const {
  constexpr double msPerSecond = 1000.0;

  qvac_lib_inference_addon_cpp::RuntimeStats stats;

  if (const llama_context* ctx = getCtx()) {
    auto perf = llama_perf_context(ctx);

    // Return proper format: vector of key-value pairs
    stats.emplace_back("total_tokens", static_cast<long long>(perf.n_p_eval));
    stats.emplace_back("total_time_ms", perf.t_p_eval_ms);

    if (perf.t_p_eval_ms > 0) {
      stats.emplace_back(
          "tokens_per_second", perf.n_p_eval * msPerSecond / perf.t_p_eval_ms);
    }

    stats.emplace_back(
        "batch_size", static_cast<long long>(init_.params.n_batch));
    stats.emplace_back(
        "trained_context_size",
        static_cast<long long>(llama_model_n_ctx_train(model_)));
    stats.emplace_back(
        "context_size", static_cast<long long>(llama_n_ctx(ctx_)));
    stats.emplace_back("backendDevice", runtimeBackendDevice_);
  }

  return stats;
}
