#include "BertModel.hpp"

#include <algorithm>
#include <any>
#include <stdexcept>
#include <utility>

#include <common/common.h>
#include <inference-addon-cpp/Errors.hpp>
#include <llama-cpp.h>
#include <llama.h>

#include "ModelMetadata.hpp"
#include "addon/BertErrors.hpp"
#include "inference-addon-cpp/GGUFShards.hpp"
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

/// @brief RANK pooling yields n_cls_out classifier scores per sequence, not an
/// n_embd vector: batchDecode would read n_embd floats past their end.
qvac_errors::StatusError
rankPoolingUnsupported(const char* func, const std::string& scores) {
  return qvac_errors::StatusError(
      ADDON_ID,
      toString(UnsupportedEmbeddings),
      string_format(
          "%s: rank pooling returns classifier scores%s, not embeddings, and "
          "is not supported; load reranker models with Reranker",
          func,
          scores.c_str()));
}

/// @brief A copy of @p config without the projector options, which are
/// stored in @p options: llama.cpp's argument parser rejects them for an
/// embedding load. They need a projection model (see takeMultimodalOptions).
std::unordered_map<std::string, std::string> withoutMultimodalOptions(
    std::unordered_map<std::string, std::string> config,
    const std::string& projectionPath, MultimodalOptions& options) {
  options = takeMultimodalOptions(config, !projectionPath.empty());
  return config;
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

BertModel::BertModel(
    const std::string& modelGgufPath,
    const std::unordered_map<std::string, std::string>& config,
    const std::string& backendsDir, const std::string& projectionPath)
    : model_(nullptr), ctx_(nullptr), vocab_(nullptr), batch_{},
      pooling_type(LLAMA_POOLING_TYPE_NONE), n_embd(0),
      projectionPath_(projectionPath),
      loader_(
          "BertModel", loadHooks(), modelGgufPath,
          withoutMultimodalOptions(config, projectionPath, multimodalOptions_),
          backendsDir) {}

BertModel::BertModel(BertModelSetup& setup)
    : model_(nullptr), ctx_(nullptr), vocab_(nullptr), batch_{},
      pooling_type(LLAMA_POOLING_TYPE_NONE), n_embd(0),
      loader_("BertModel", loadHooks(), setup) {}

void BertModel::resolveShardPaths(
    GGUFShards& shards, const std::string& modelPath) {
  LlamaModelLoader::resolveShardPaths(shards, modelPath);
}

LlamaModelLoader::Hooks BertModel::loadHooks() {
  return {
      .configureParams =
          [this](
              common_params& params,
              const ModelMetaData& metadata,
              bool ctxSizeConfigured) {
            configureParams(params, metadata, ctxSizeConfigured);
          },
      .onLoaded =
          [this](llama_model* model, llama_context* ctx) {
            onLoaded(model, ctx);
          }};
}

void BertModel::configureParams(
    common_params& params, const ModelMetaData& metadata,
    bool ctxSizeConfigured) {
  // Reject RANK pooling before the weights load: set in the config, or the
  // GGUF's default when the config leaves pooling unset.
  const bool rankPooling =
      params.pooling_type == LLAMA_POOLING_TYPE_RANK ||
      (params.pooling_type == LLAMA_POOLING_TYPE_UNSPECIFIED &&
       metadata.tryGetPoolingType() ==
           static_cast<uint32_t>(LLAMA_POOLING_TYPE_RANK));
  if (rankPooling) {
    throw rankPoolingUnsupported(__func__, "");
  }

  params.embedding = true;

  // if the number of prompts that would be encoded is known in advance, it's
  // more efficient to specify the
  //   --parallel argument accordingly. for convenience, if not specified, we
  //   fallback to unified KV cache in order to support any number of prompts
  const bool unifiedFallback = params.n_parallel == 1;
  if (unifiedFallback) {
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

  if (std::optional<int> trainedCtx = readTrainedContextSize(metadata)) {
    adjustEmbeddingContextSize(params, *trainedCtx, ctxSizeConfigured);
  }

  // The unified cache does not lift the batch's sequence limit: every seq_id
  // must be below n_seq_max. Sized from the final context and batch.
  if (unifiedFallback) {
    params.n_parallel = unifiedSequenceLimit(params);
  }
}

void BertModel::onLoaded(llama_model* model, llama_context* ctx) {
  // configureParams rejects RANK from the config and the GGUF; this catches
  // a context that ends up with it any other way.
  if (llama_pooling_type(ctx) == LLAMA_POOLING_TYPE_RANK) {
    throw rankPoolingUnsupported(
        __func__,
        string_format(
            " (n_cls_out = %u per sequence)", llama_model_n_cls_out(model)));
  }

  model_ = model;
  ctx_ = ctx;
  pooling_type = llama_pooling_type(ctx_);
  vocab_ = llama_model_get_vocab(model_);
  batch_ = llama_batch_init(loader_.params().n_batch, 0, 1);
  // The pooled embedding has the output size, which differs from the hidden
  // size on models with an output projection (e.g. EmbeddingGemma 2).
  n_embd = llama_model_n_embd_out(model_);

  // Abort a pass in llama_decode once cancel() is requested.
  abortDecodeWhen(ctx_, stopCancelled_);

  if (llama_model_has_encoder(model_) && llama_model_has_decoder(model_)) {
    std::string msg = string_format(
        "%s: computing embeddings in encoder-decoder models is not supported",
        __func__);
    throw qvac_errors::StatusError(
        ADDON_ID, toString(UnsupportedEmbeddings), msg);
  }

  if (!projectionPath_.empty()) {
    // A multimodal input yields one pooled embedding (RANK is rejected above).
    if (pooling_type == LLAMA_POOLING_TYPE_NONE) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(UnsupportedEmbeddings),
          string_format(
              "%s: a projection model needs mean, cls or last pooling",
              __func__));
    }
    multimodal_ = std::make_unique<MultimodalEmbedder>(
        projectionPath_,
        model_,
        ctx_,
        loader_.params(),
        loader_.runtimeBackendDevice() == 1,
        multimodalOptions_);
  }
}

BertModel::~BertModel() {
  // The projector refers to the text model, which loader_ frees.
  multimodal_.reset();
  llama_batch_free(batch_);
}

const llama_context* BertModel::getCtx() const { return ctx_; };

const llama_model* BertModel::getModel() const { return model_; }

std::vector<std::string>
BertModel::preprocessPrompt(const std::string& prompt) const {
  return splitLines(prompt, loader_.params().embd_sep);
}

const common_params& BertModel::getCommonParams() const {
  return loader_.params();
}

bool BertModel::isLoaded() const { return loader_.isLoaded(); }

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
  if (input.type() == typeid(std::vector<MultimodalInput>)) {
    const auto& inputs =
        std::any_cast<const std::vector<MultimodalInput>&>(input);
    return encodeHostF32Multimodal(inputs);
  }
  throw qvac_errors::StatusError(
      qvac_errors::general_error::InvalidArgument,
      "BertModel::process: unsupported input type");
}

void BertModel::initializeBackend(
    const std::string& backendsDir, const std::string& openclCacheDir) {
  loader_.initializeBackend(backendsDir, openclCacheDir);
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
  loader_.setWeightsForFile(filename, std::move(shard));
}

std::vector<std::vector<int32_t>>
BertModel::tokenizeInput(const std::vector<std::string>& prompts) const {
  uint64_t nBatch = loader_.params().n_batch;

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
  logTokenizationIfVerbose(
      loader_.params().verbose_prompt, ctx_, inputs, prompts);

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

    // encode if at capacity: tokens, or sequence ids the context admits
    if (batch_.n_tokens + numTokensInPrompt > loader_.params().n_batch ||
        numPromptsInBatch >= llama_n_seq_max(ctx_)) {
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
            loader_.params().embd_normalize);
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
        loader_.params().embd_normalize);
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
  loader_.waitForLoadInitialization();
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
  loader_.waitForLoadInitialization();

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
  uint64_t nBatch = loader_.params().n_batch;
  validateBatchLimitsOrThrow(inputTokens, nBatch);
  ensureLastTokenIsSpecial(vocab_, inputTokens);
  logTokenizationIfVerbose(
      loader_.params().verbose_prompt, ctx_, inputTokens, sequenceArray);

  // Process tokenized sequences directly (avoids re-tokenization)
  return processBatched(inputTokens, sequenceArray.size());
}

BertEmbeddings
BertModel::encodeHostF32Multimodal(const std::vector<MultimodalInput>& inputs) {
  loader_.waitForLoadInitialization();
  if (!multimodal_) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(InvalidRequest),
        "media input needs a projection model (files.projectionModel)");
  }

  const auto embeddingSize = static_cast<std::size_t>(n_embd);
  std::vector<float> embeddings(inputs.size() * embeddingSize, 0.0F);
  std::span<float> embSpan{embeddings};
  for (std::size_t i = 0; i < inputs.size(); ++i) {
    if (stopCancelled_.load()) {
      throw std::runtime_error("Job cancelled");
    }
    multimodal_->embed(
        inputs[i],
        embSpan.subspan(i * embeddingSize, embeddingSize),
        loader_.params().embd_normalize,
        stopCancelled_);
  }
  return BertEmbeddings(
      std::move(embeddings),
      BertEmbeddings::Layout{
          .embeddingCount = inputs.size(), .embeddingSize = embeddingSize});
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
        "batch_size", static_cast<long long>(loader_.params().n_batch));
    stats.emplace_back(
        "trained_context_size",
        static_cast<long long>(llama_model_n_ctx_train(model_)));
    stats.emplace_back(
        "context_size", static_cast<long long>(llama_n_ctx(ctx_)));
    stats.emplace_back("backendDevice", loader_.runtimeBackendDevice());
  }

  return stats;
}
