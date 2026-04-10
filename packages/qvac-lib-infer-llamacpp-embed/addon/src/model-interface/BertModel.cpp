#include "BertModel.hpp"

#include <algorithm>
#include <any>
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
#include "logging.hpp"
#include "qvac-lib-inference-addon-cpp/GGUFShards.hpp"
#include "qvac-lib-inference-addon-cpp/LlamacppUtils.hpp"
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
    qvac_lib_infer_llamacpp_embed::logging::llamaLogCallback(
        GGML_LOG_LEVEL_ERROR,
        string_format("%s : failed to process\n", __func__).c_str(),
        nullptr);
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
          *batch.seq_id
               [i]); // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
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

namespace {
common_params setupParams(
    const std::string& modelGgufPath,
    std::unordered_map<std::string, std::string> configFilemap,
    int64_t& resolvedBackendDevice) {
  // Default params
  common_params params;

  // Override default params
  std::vector<std::string> configVector;
  // Add program name as first arg
  configVector.emplace_back("llama");
  configVector.emplace_back("--model");
  configVector.emplace_back(modelGgufPath);

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
    const std::pair<BackendType, std::string> chosenBackend =
        chooseBackend(preferredBackend, llamaLogCallback, mainGpu);

    if (chosenBackend.first != BackendType::GPU &&
        chosenBackend.first != BackendType::CPU) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InternalError,
          "preferredDeviceFromString: wrong deduced device, must be 'gpu' or "
          "'cpu'.\n");
    }
    if (chosenBackend.first == BackendType::GPU) {
      resolvedBackendDevice = 1;
    } else {
      resolvedBackendDevice = 0;
    }
    configVector.emplace_back("--device");
    configVector.emplace_back(chosenBackend.second);
    configFilemap.erase(deviceIt);
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

  return params;
}
} // namespace

BertModel::BertModel(
    const std::string& modelGgufPath,
    const std::unordered_map<std::string, std::string>& config,
    const std::string& backendsDir)
    : model_(nullptr), ctx_(nullptr), vocab_(nullptr), batch_{},
      pooling_type(LLAMA_POOLING_TYPE_NONE), n_embd(0), is_loaded_(false),
      loadingContext_(InitLoader::getLoadingContext("BertModel")),
      shards_(GGUFShards::expandGGUFIntoShards(modelGgufPath)) {
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

BertModel::BertModel(common_params& params)
    : model_(nullptr), ctx_(nullptr), vocab_(nullptr), batch_{},
      pooling_type(LLAMA_POOLING_TYPE_NONE), n_embd(0), is_loaded_(false),
      loadingContext_(InitLoader::getLoadingContext("BertModel")),
      shards_(GGUFShards::expandGGUFIntoShards(params.model.path)) {
  auto modelInit = [this](common_params commonParams) {
    this->init(commonParams);
  };

  initLoader_.init(InitLoader::LOADER_TYPE::DELAYED, modelInit, params);
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
  if (auto it = configCopy.find("openclCacheDir"); it != configCopy.end()) {
    openclCacheDir = it->second;
    configCopy.erase(it);
  }

  lazyCommonInit();
  initializeBackend(backendsDir, openclCacheDir);

  common_params params =
      setupParams(modelGgufPath, configCopy, runtimeBackendDevice_);
  BertModel::init(params);
}

void BertModel::init(common_params& params) {
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
  common_init_result llamaInit = initFromConfig(
      params,
      params.model.path,
      singleGgufStreamedFiles_,
      shards_,
      loadingContext_,
      isStreaming_,
      ADDON_ID,
      errorWhenFailed);

  init_.params = params;
  init_.result = std::move(llamaInit);
  model_ = init_.result.model.get();
  ctx_ = init_.result.context.get();
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

  int nCtxTrain = llama_model_n_ctx_train(model_);
  int nCtx = static_cast<int>(llama_n_ctx(ctx_));

  if (llama_model_has_encoder(model_) && llama_model_has_decoder(model_)) {
    std::string msg = string_format(
        "%s: computing embeddings in encoder-decoder models is not supported",
        __func__);
    throw qvac_errors::StatusError(
        ADDON_ID, toString(UnsupportedEmbeddings), msg);
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
  isStreaming_ = true;

  if (shards_.gguf_files.empty()) {
    // Store it and make it available when `init` is called
    singleGgufStreamedFiles_[filename] = std::move(shard);
    return;
  }

  // Asynchronous shard loading - ensure background initialization has started
  initLoader_.ensureLoadInBackground();

  if (!llama_model_load_fulfill_split_future(
          filename.c_str(), loadingContext_.c_str(), std::move(shard))) {
    std::string msg = string_format(
        "%s: failed to load model from %s", __func__, filename.c_str());
    throw std::runtime_error(msg);
  }

  static int fulfilledFiles = 0;
  fulfilledFiles++;
  if (fulfilledFiles == static_cast<int>(shards_.gguf_files.size()) + 1) {
    initLoader_.waitForLoadInitialization();
  }
}

std::vector<std::vector<int32_t>>
BertModel::tokenizeInput(const std::vector<std::string>& prompts) const {
  uint64_t nBatch = init_.params.n_batch;

  // tokenize all prompts first
  std::vector<std::vector<int32_t>> inputs = tokenizePrompts(ctx_, prompts);

  // Check for context overflow: compare against model's training context size
  int nCtxTrain = llama_model_n_ctx_train(model_);
  for (std::size_t i = 0; i < inputs.size(); ++i) {
    if (static_cast<int>(inputs[i].size()) > nCtxTrain) {
      std::string msg = string_format(
          "%s: context overflow: number of tokens in prompt %zu (%zu) exceeds "
          "model training context size (%d)",
          __func__,
          i,
          inputs[i].size(),
          nCtxTrain);
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

  auto earlyReturn = [&]() {
    stopCancelled_.store(false);
    return BertEmbeddings(
        std::move(embeddings),
        BertEmbeddings::Layout{
            numStoredEmbeddings, static_cast<std::size_t>(n_embd)});
  };

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
      batchDecode(
          ctx_,
          batch_,
          out,
          static_cast<int>(numPromptsInBatch),
          n_embd,
          init_.params.embd_normalize);
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
    return earlyReturn();
  }

  // final batch
  std::span<float> embSpan{emb, embeddings.size()};
  float* out =
      embSpan.subspan(numStoredEmbeddings * static_cast<std::size_t>(n_embd))
          .data();
  batchDecode(
      ctx_,
      batch_,
      out,
      static_cast<int>(numPromptsInBatch),
      n_embd,
      init_.params.embd_normalize);
  return BertEmbeddings(
      std::move(embeddings),
      BertEmbeddings::Layout{embeddingCount, static_cast<std::size_t>(n_embd)});
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
        BertEmbeddings::Layout{0, static_cast<std::size_t>(n_embd)});
  }

  // Tokenize all sequences once and validate context size
  std::vector<std::vector<int32_t>> inputTokens;
  inputTokens.reserve(sequenceArray.size());

  int nCtxTrain = llama_model_n_ctx_train(model_);
  for (std::size_t i = 0; i < sequenceArray.size(); ++i) {
    if (stopCancelled_.load()) {
      throw std::runtime_error("Job cancelled");
    }
    const auto& sequence = sequenceArray[i];
    std::vector<int32_t> tokens = common_tokenize(ctx_, sequence, true, true);

    // Validate context size during tokenization
    if (static_cast<int>(tokens.size()) > nCtxTrain) {
      std::string msg = string_format(
          "%s: context overflow: number of tokens in sequence %zu (%zu) "
          "exceeds model training context size (%d)",
          __func__,
          i,
          tokens.size(),
          nCtxTrain);
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
        "context_size",
        static_cast<long long>(llama_model_n_ctx_train(model_)));
    stats.emplace_back("backendDevice", runtimeBackendDevice_);
  }

  return stats;
}
