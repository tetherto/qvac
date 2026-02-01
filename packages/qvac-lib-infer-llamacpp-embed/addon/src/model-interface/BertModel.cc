#include "BertModel.h"

#include <cctype>
#include <cstring>
#include <stdexcept>

#include <common/common.h>
#include <llama.h>
#include <llama/common/arg.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>

#include "BackendSelection.hpp"
#include "LlamaLazyInitializeBackend.hpp"
#include "addon/BertErrors.hpp"
#include "logging.h"
#include "qvac-lib-inference-addon-cpp/GGUFShards.hpp"
#include "qvac-lib-inference-addon-cpp/LlamacppUtils.hpp"
#include "utils.h"

using namespace qvac_lib_infer_llamacpp_embed::errors;
using namespace qvac_lib_infer_llamacpp_embed::logging;

namespace {

void batchAddSeq(
    llama_batch& batch, const std::vector<int32_t>& tokens,
    llama_seq_id seqId) {
  size_t numTokens = tokens.size();
  for (size_t i = 0; i < numTokens; i++) {
    common_batch_add(batch, tokens[i], static_cast<llama_pos>(i), {seqId}, true);
  }
}

// NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
void batchDecode(
    llama_context* ctx, llama_batch& batch, float* output, std::size_t numSeq, // NOLINT(bugprone-easily-swappable-parameters)
    int numEmbd, int embeddingNorm) /* NOLINT(bugprone-easily-swappable-parameters) */ {
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
    qvac_lib_infer_llamacpp_embed::logging::llamaLogCallback(
        GGML_LOG_LEVEL_ERROR,
        string_format("%s : failed to process\n", __func__).c_str(),
        nullptr);
  }

  std::span<const int8_t> logitsSpan{batch.logits, static_cast<std::size_t>(batch.n_tokens)};

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
            AddonID,
            toString(FailedToGetTokenEmbeddings),
            "Failed to get token embeddings");
      }
    } else {
      // try to get sequence embeddings - supported only when pooling_type is
      // not NONE
      embd = llama_get_embeddings_seq(ctx, *batch.seq_id[i]); // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      // NOLINTNEXTLINE(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      embeddingPos = *batch.seq_id[i];
      if (embd == nullptr) {
        throw qvac_errors::StatusError(
            AddonID,
            toString(FailedToGetSequenceEmbeddings),
            "Failed to get sequence embeddings");
      }
    }

    std::size_t outputIndexOffset = static_cast<std::size_t>(embeddingPos) * static_cast<std::size_t>(numEmbd);
    std::size_t capacityCount = (poolingType == LLAMA_POOLING_TYPE_NONE)
                                          ? static_cast<std::size_t>(batch.n_tokens)
                                          : numSeq;
    std::span<float> outputSpan{output, capacityCount * static_cast<std::size_t>(numEmbd)};
    float* out = outputSpan.subspan(outputIndexOffset).data();
    common_embd_normalize(embd, out, numEmbd, embeddingNorm);
  }
}

// Helper functions to reduce cognitive complexity in tokenizeInput
std::vector<std::vector<int32_t>> tokenizePrompts(llama_context* ctx, const std::vector<std::string>& prompts) {
  std::vector<std::vector<int32_t>> results;
  results.reserve(prompts.size());
  for (const auto& prompt : prompts) {
    results.emplace_back(common_tokenize(ctx, prompt, true, true));
  }
  return results;
}

void validateBatchLimitsOrThrow(const std::vector<std::vector<int32_t>>& inputs, uint64_t nBatch) {
  for (const auto& inp : inputs) {
    if (inp.size() > nBatch) {
      std::string msg = string_format(
          "%s: batch overflow: number of tokens in input line (%zu) exceeds "
          "batch size (%llu), increase batch size and re-run",
          __func__,
          inp.size(),
          static_cast<unsigned long long>(nBatch));
      throw qvac_errors::StatusError(
          AddonID, toString(InputTokensExceedBatchSize), msg);
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

void logPrompt(llama_context* ctx, const std::vector<int32_t>& input, const std::string& prompt) {
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

void logTokenizationIfVerbose(bool verbose, llama_context* ctx,
                              const std::vector<std::vector<int32_t>>& inputs,
                              const std::vector<std::string>& prompts) {
  if (!verbose) { return; }
  for (std::size_t i = 0; i < inputs.size(); ++i) {
    logPrompt(ctx, inputs[i], prompts[i]);
  }
}

} // namespace

BertEmbeddings::BertEmbeddings(
    std::vector<float> flatData, BertEmbeddings::Layout layout)
    : flat_embd_(std::move(flatData)),
      embeddingCount_(layout.embeddingCount),
      embeddingSize_(layout.embeddingSize) {}

std::span<const float> BertEmbeddings::operator[](std::size_t index) const {
    return std::span<const float>(flat_embd_).subspan(index * embeddingSize_, embeddingSize_);
}

std::size_t BertEmbeddings::size() const { return embeddingCount_; }

std::size_t BertEmbeddings::embeddingSize() const { return embeddingSize_; }

namespace {
common_params
setupParams(const std::string& modelGgufPath, std::string_view config) {
  // Default params
  common_params params;

  // Override default params
  std::vector<std::string> args;
  // Add program name as first arg
  args.emplace_back("llama");
  args.emplace_back("--model");
  args.emplace_back(modelGgufPath);

  // Extract main-gpu from config if present (quick first pass)
  std::optional<backend_selection::MainGpu> mainGpu = std::nullopt;
  {
    std::stringstream configStream(std::string{config});
    std::string lineStr;
    while (std::getline(configStream, lineStr, '\n')) {
      std::stringstream line(lineStr);
      std::string token;
      while (std::getline(line, token, '	')) {
        if (token.empty()) {
          continue;
        }
        if ((token == "--main-gpu" || token == "-main-gpu") &&
            std::getline(line, token, '	') && !token.empty()) {
          try {
            mainGpu = backend_selection::parseMainGpu(token);
          } catch (const qvac_errors::StatusError&) {
            qvac_lib_infer_llamacpp_embed::logging::llamaLogCallback(
                GGML_LOG_LEVEL_WARN,
                string_format(
                    "%s: invalid main-gpu value: %s\n", __func__, token.c_str())
                    .c_str(),
                nullptr);
          }
          break;
        }
      }
      if (mainGpu.has_value()) {
        break;
      }
    }
  }

  auto getDeviceStr = [&args, mainGpu](auto devToken) {
    using namespace backend_selection;
    using namespace qvac_lib_infer_llamacpp_embed::logging;
    const BackendType PREFERRED_BACKEND =
        preferredBackendTypeFromString(devToken);
    const std::pair<BackendType, std::string> CHOSEN_BACKEND =
        chooseBackend(PREFERRED_BACKEND, llamaLogCallback, mainGpu);

    if (CHOSEN_BACKEND.first == BackendType::GPU ||
        CHOSEN_BACKEND.first == BackendType::CPU) {
      return CHOSEN_BACKEND.second;
    }
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InternalError,
        "preferredDeviceFromString: wrong deduced device, must be 'gpu' or "
        "'cpu'.\n");
  };

  // Split config string on newlines and tabs
  bool emplacedDevice = false;
  std::stringstream configStream(std::string{config});
  std::string lineStr;
  while (std::getline(configStream, lineStr, '\n')) {
    std::stringstream line(lineStr);
    std::string token;
    while (std::getline(line, token, '	')) {
      if (token.empty()) {
        continue;
      }
      // Skip main-gpu tokens (already processed)
      if (token == "--main-gpu" || token == "-main-gpu") {
        std::getline(line, token, '	'); // Skip the value
        continue;
      }
      if ((token == "cpu" || token == "gpu") && args.back() == "-dev") {
        args.emplace_back(getDeviceStr(token));
        emplacedDevice = true;
      } else if (args.back() == "-dev") {
        args.pop_back();
      } else {
        args.emplace_back(token);
      }
    }
  }

  if (!emplacedDevice) {
    args.emplace_back("-dev");
    args.emplace_back(getDeviceStr("gpu"));
  }

  // Convert to argc/argv format
  std::vector<char*> argv;
  argv.reserve(args.size());
  for (std::string& argString : args) {
    argv.push_back(argString.data());
  }
  int argc = static_cast<int>(argv.size());

  if (!common_params_parse(
          argc, argv.data(), params, LLAMA_EXAMPLE_EMBEDDING)) {
    throw qvac_errors::StatusError(AddonID, toString(InvalidConfiguration), "Invalid configuration parameters.");
  }

  return params;
}
} // namespace

BertModel::BertModel(
    const std::string& modelGgufPath, const std::string& config,
    const std::string& backendsDir)
    : _model(nullptr), _ctx(nullptr), _vocab(nullptr), _batch{},
      pooling_type(LLAMA_POOLING_TYPE_NONE), n_embd(0), is_loaded_(false),
      loading_context(InitLoader::getLoadingContext("BertModel")),
      _shards(GGUFShards::expandGGUFIntoShards(modelGgufPath)) {
  auto modelInit = [this](
                       const std::string& path,
                       const std::string& cfg,
                       const std::string& backendsDir) {
    this->init(path, cfg, backendsDir);
  };
  initLoader.init(
      InitLoader::LOADER_TYPE::DELAYED,
      modelInit,
      modelGgufPath,
      config,
      backendsDir);
}

BertModel::BertModel(common_params &params)
    : _model(nullptr), _ctx(nullptr), _vocab(nullptr), _batch{}, pooling_type(LLAMA_POOLING_TYPE_NONE), n_embd(0), is_loaded_(false), loading_context(InitLoader::getLoadingContext("BertModel")),
      _shards(GGUFShards::expandGGUFIntoShards(params.model.path)) {
  auto modelInit = [this](common_params& commonParams) {
    this->init(commonParams);
  };

  initLoader.init(InitLoader::LOADER_TYPE::DELAYED, modelInit, params);
}

void BertModel::init(
    const std::string& modelGgufPath, const std::string& config,
    const std::string& backendsDir) {
  // Need to initialize backend before setupParams to properly
  // detect available backends and choose properly among them

  // Extract and set verbosity level from config (modifies configCopy)
  std::string configCopy = config;
  auto verbosityConfig = extractVerbosityConfig(configCopy);
  SetVerbosityLevel(verbosityConfig);
  lazyCommonInit();
  initializeBackend(backendsDir);

  common_params params =
      setupParams(modelGgufPath, std::string_view{configCopy});
  BertModel::init(params);
}

void BertModel::init(common_params &params) {
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

  const std::string ERROR_WHEN_FAILED = toString(UnableToLoadModel);
  common_init_result llamaInit = initFromConfig(
      params,
      params.model.path,
      singleGgufStreamedFiles,
      _shards,
      loading_context,
      isStreaming,
      AddonID,
      ERROR_WHEN_FAILED);

  _init.params = params;
  _init.result = std::move(llamaInit);
  _model = _init.result.model.get();
  _ctx = _init.result.context.get();
  _vocab = llama_model_get_vocab(_model);
  _batch = llama_batch_init(_init.params.n_batch, 0, 1);
  pooling_type = llama_pooling_type(_ctx);
  n_embd = llama_model_n_embd(_model);

  int nCtxTrain = llama_model_n_ctx_train(_model);
  int nCtx = static_cast<int>(llama_n_ctx(_ctx));

  if (llama_model_has_encoder(_model) && llama_model_has_decoder(_model)) {
    std::string msg = string_format(
        "%s: computing embeddings in encoder-decoder models is not supported",
        __func__);
    throw qvac_errors::StatusError(
        AddonID, toString(UnsupportedEmbeddings), msg);
  }

  if (nCtx > nCtxTrain) {
    qvac_lib_infer_llamacpp_embed::logging::llamaLogCallback(
        GGML_LOG_LEVEL_WARN,
        string_format(
            "%s: warning: model was trained on only %d context tokens (%d "
            "specified)\n",
            __func__,
            nCtxTrain,
            nCtx)
            .c_str(),
        nullptr);
  }

  // print system information
  {
    qvac_lib_infer_llamacpp_embed::logging::llamaLogCallback(
        GGML_LOG_LEVEL_INFO,
        string_format(
            "%s\n", common_params_get_system_info(_init.params).c_str())
            .c_str(),
        nullptr);
  }
  is_loaded_ = true;
}

BertModel::~BertModel() { llama_batch_free(_batch); }

const llama_context* BertModel::get_ctx() const { return _ctx; };

const llama_model* BertModel::get_model() const { return _model; }

std::vector<std::string>
BertModel::preprocess_prompt(const std::string& prompt) const {
  return splitLines(prompt, _init.params.embd_sep);
}

BertEmbeddings BertModel::process(
    const Input& input,
    const std::function<void(const BertEmbeddings&)>& callback) {
  // Use std::visit to handle variant input
  return std::visit(
      [&callback, this](const auto& inputValue) -> BertEmbeddings {
        using T = std::decay_t<decltype(inputValue)>;

        if constexpr (std::is_same_v<T, std::string>) {
          // Handle string input
          BertEmbeddings result = encode_host_f32(inputValue);
          if (callback) {
            callback(result);
          }
          return result;
        } else if constexpr (std::is_same_v<T, std::vector<std::string>>) {
          // Handle vector of strings input
          BertEmbeddings result = encode_host_f32_sequences(inputValue);
          if (callback) {
            callback(result);
          }
          return result;
        }
      },
      input);
}

bool BertModel::isLoaded() const {
    return is_loaded_ && _model != nullptr && _ctx != nullptr;
}

void BertModel::initializeBackend(const std::string& backendsDir) {
  backendsHandle_ = LlamaBackendsHandle(backendsDir);
}

void BertModel::reset() {
  // Clear the batch state - this is the most important part
  common_batch_clear(_batch);

  // Clear memory and KV cache (llama_memory_clear handles both)
  if (_ctx != nullptr) {
    llama_memory_clear(llama_get_memory(_ctx), true);
  }
}

void BertModel::set_weights_for_file(
    const std::string& filename,
    std::unique_ptr<std::basic_streambuf<char>>&& shard) {
  isStreaming = true;

  if (_shards.gguf_files.empty()) {
    // Store it and make it available when `init` is called
    singleGgufStreamedFiles[filename] = std::move(shard);
    return;
  }

  // Asynchronous shard loading - ensure background initialization has started
  initLoader.ensureLoadInBackground();

  if (!llama_model_load_fulfill_split_future(
          filename.c_str(), loading_context.c_str(), std::move(shard))) {
    std::string msg = string_format(
        "%s: failed to load model from %s", __func__, filename.c_str());
    throw std::runtime_error(msg);
  }

  static int fulfilledFiles = 0;
  fulfilledFiles++;
  if (fulfilledFiles == static_cast<int>(_shards.gguf_files.size()) + 1) {
    initLoader.waitForLoadInitialization();
  }
}

std::vector<std::vector<int32_t>>
BertModel::tokenizeInput(const std::vector<std::string> & prompts) const {
  uint64_t nBatch = _init.params.n_batch;

  // tokenize all prompts first
  std::vector<std::vector<int32_t>> inputs = tokenizePrompts(_ctx, prompts);

  // Check for context overflow: compare against model's training context size
  int nCtxTrain = llama_model_n_ctx_train(_model);
  for (std::size_t i = 0; i < inputs.size(); ++i) {
    if (static_cast<int>(inputs[i].size()) > nCtxTrain) {
      std::string msg = string_format(
          "%s: context overflow: number of tokens in prompt %zu (%zu) exceeds "
          "model training context size (%d)",
          __func__,
          i,
          inputs[i].size(),
          nCtxTrain);
      throw qvac_errors::StatusError(AddonID, toString(ContextOverflow), msg);
    }
  }

  // validate sizes against batch limits
  validateBatchLimitsOrThrow(inputs, nBatch);

  // ensure last token is the appropriate special token (SEP for BERT, EOS for
  // Gemma, etc.)
  ensureLastTokenIsSpecial(_vocab, inputs);

  // optionally log tokenization details
  logTokenizationIfVerbose(_init.params.verbose_prompt, _ctx, inputs, prompts);

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
  std::vector<float> embeddings(embeddingCount * static_cast<std::size_t>(n_embd), 0.0F);
  float* emb = embeddings.data();

  // break into batches
  std::size_t numStoredEmbeddings = 0; // number of embeddings already stored
  std::size_t numPromptsInBatch = 0; // number of prompts in current batch
  for (std::size_t k = 0; k < nPrompts; k++) {
    // clamp to n_batch tokens
    const auto& inp = inputs[k];

    uint64_t numTokensInPrompt = inp.size();

    // encode if at capacity
    if (_batch.n_tokens + numTokensInPrompt > _init.params.n_batch) {
      std::span<float> embSpan{emb, embeddings.size()};
      float* out = embSpan.subspan(numStoredEmbeddings * static_cast<std::size_t>(n_embd)).data();
      batchDecode(_ctx, _batch, out, static_cast<int>(numPromptsInBatch), n_embd, _init.params.embd_normalize);
      numStoredEmbeddings += (pooling_type == LLAMA_POOLING_TYPE_NONE ? _batch.n_tokens : numPromptsInBatch);
      numPromptsInBatch = 0;
      common_batch_clear(_batch);
    }

    // add to batch
    batchAddSeq(_batch, inp, static_cast<llama_seq_id>(numPromptsInBatch));
    numPromptsInBatch += 1;
  }

  // final batch
  std::span<float> embSpan{emb, embeddings.size()};
      float* out = embSpan.subspan(numStoredEmbeddings * static_cast<std::size_t>(n_embd)).data();
  batchDecode(_ctx, _batch, out, static_cast<int>(numPromptsInBatch), n_embd, _init.params.embd_normalize);
  return BertEmbeddings(std::move(embeddings), BertEmbeddings::Layout{embeddingCount, static_cast<std::size_t>(n_embd)});
}

BertEmbeddings
BertModel::encode_host_f32(const std::vector<std::string>& prompts) {
  initLoader.waitForLoadInitialization();
  std::vector<std::vector<int32_t>> inputTokens = tokenizeInput(prompts);
  return processBatched(inputTokens, prompts.size());
}

BertEmbeddings BertModel::encode_host_f32(const std::string& prompt) {
  // Process as single sequence - delegate to vector version which handles
  // initialization
  std::vector<std::string> prompts = {prompt};
  return encode_host_f32(prompts);
}

BertEmbeddings BertModel::encode_host_f32_sequences(
    const std::vector<std::string>& sequenceArray) {
  initLoader.waitForLoadInitialization();

  // Early return for empty array (no work needed)
  if (sequenceArray.empty()) {
    return BertEmbeddings(
        std::vector<float>{},
        BertEmbeddings::Layout{0, static_cast<std::size_t>(n_embd)});
  }

  // Tokenize all sequences once and validate context size
  std::vector<std::vector<int32_t>> inputTokens;
  inputTokens.reserve(sequenceArray.size());

  int nCtxTrain = llama_model_n_ctx_train(_model);
  for (std::size_t i = 0; i < sequenceArray.size(); ++i) {
    const auto& sequence = sequenceArray[i];
    std::vector<int32_t> tokens = common_tokenize(_ctx, sequence, true, true);

    // Validate context size during tokenization
    if (static_cast<int>(tokens.size()) > nCtxTrain) {
      std::string msg = string_format(
          "%s: context overflow: number of tokens in sequence %zu (%zu) "
          "exceeds model training context size (%d)",
          __func__,
          i,
          tokens.size(),
          nCtxTrain);
      throw qvac_errors::StatusError(AddonID, toString(ContextOverflow), msg);
    }

    inputTokens.push_back(std::move(tokens));
  }

  // Apply all validations from tokenizeInput (reusing tokenized results)
  uint64_t nBatch = _init.params.n_batch;
  validateBatchLimitsOrThrow(inputTokens, nBatch);
  ensureLastTokenIsSpecial(_vocab, inputTokens);
  logTokenizationIfVerbose(
      _init.params.verbose_prompt, _ctx, inputTokens, sequenceArray);

  // Process tokenized sequences directly (avoids re-tokenization)
  return processBatched(inputTokens, sequenceArray.size());
}

qvac_lib_inference_addon_cpp::RuntimeStats BertModel::runtimeStats() const {
  constexpr double MS_PER_SECOND = 1000.0;

  qvac_lib_inference_addon_cpp::RuntimeStats stats;

  if (const llama_context* ctx = get_ctx()) {
    auto perf = llama_perf_context(ctx);

    // Return proper format: vector of key-value pairs
    stats.emplace_back("total_tokens", static_cast<long long>(perf.n_p_eval));
    stats.emplace_back("total_time_ms", perf.t_p_eval_ms);

    if (perf.t_p_eval_ms > 0) {
      stats.emplace_back(
          "tokens_per_second",
          perf.n_p_eval * MS_PER_SECOND / perf.t_p_eval_ms);
    }

    stats.emplace_back(
        "batch_size", static_cast<long long>(_init.params.n_batch));
    stats.emplace_back(
        "context_size",
        static_cast<long long>(llama_model_n_ctx_train(_model)));
  }

  return stats;
}
