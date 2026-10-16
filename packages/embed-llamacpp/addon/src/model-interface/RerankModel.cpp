#include "RerankModel.hpp"

#include <chrono>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_set>
#include <utility>

#include <common/common.h>
#include <inference-addon-cpp/Errors.hpp>
#include <llama.h>

#include "addon/BertErrors.hpp"
#include "utils.hpp"

using namespace qvac_lib_infer_llamacpp_embed::errors;

namespace {

// Keys a rerank load accepts. Everything that shapes the context (pooling,
// ctx_size, ubatch, attention, parallel) is fixed by the scoring setup, and
// embedding options (embd_normalize) do not apply.
const std::unordered_set<std::string>& allowedConfigKeys() {
  static const std::unordered_set<std::string> keys = {
      "device",        "gpu_layers",    "gpu-layers",   "batch_size",
      "batch-size",    "verbosity",     "main-gpu",     "main_gpu",
      "split-mode",    "split_mode",    "tensor-split", "tensor_split",
      "flash_attn",    "flash-attn",    "backend",      "threads",
      "threads-batch", "threads_batch", "poll",         "poll-batch",
      "poll_batch",    "openclCacheDir"};
  return keys;
}

/// Tokens of each query-document pair, as llama-server's format_prompt_rerank
/// lays them out. The query's side is resolved once per request.
class PairTokenizer {
public:
  PairTokenizer(const llama_model* model, const std::string& query)
      : vocab_(llama_model_get_vocab(model)),
        template_(llama_model_chat_template(model, "rerank")), query_(query) {
    if (template_ != nullptr) {
      return;
    }
    // [BOS]query[EOS][SEP]document[EOS], each special token only where the
    // vocab adds it; SEP stands in for a missing EOS.
    llama_token eos = llama_vocab_eos(vocab_);
    if (eos == LLAMA_TOKEN_NULL) {
      eos = llama_vocab_sep(vocab_);
    }
    if (llama_vocab_get_add_bos(vocab_)) {
      head_.push_back(llama_vocab_bos(vocab_));
    }
    const std::vector<int32_t> queryTokens =
        common_tokenize(vocab_, query, false, false);
    head_.insert(head_.end(), queryTokens.begin(), queryTokens.end());
    if (llama_vocab_get_add_eos(vocab_)) {
      head_.push_back(eos);
      tail_.push_back(eos);
    }
    if (llama_vocab_get_add_sep(vocab_)) {
      head_.push_back(llama_vocab_sep(vocab_));
    }
  }

  [[nodiscard]] std::vector<int32_t>
  operator()(const std::string& document) const {
    // The filled template is tokenized with special tokens parsed, including
    // in the query and the document, as llama-server and llama-embedding do,
    // so scores match theirs.
    if (template_ != nullptr) {
      return common_tokenize(
          vocab_,
          RerankModel::fillTemplate(template_, query_, document),
          false,
          true);
    }
    std::vector<int32_t> tokens = head_;
    const std::vector<int32_t> documentTokens =
        common_tokenize(vocab_, document, false, false);
    tokens.insert(tokens.end(), documentTokens.begin(), documentTokens.end());
    tokens.insert(tokens.end(), tail_.begin(), tail_.end());
    return tokens;
  }

private:
  const llama_vocab* vocab_;
  const char* template_;
  const std::string& query_;
  std::vector<int32_t> head_;
  std::vector<int32_t> tail_;
};

} // namespace

std::string RerankModel::fillTemplate(
    const std::string& tmpl, const std::string& query,
    const std::string& document) {
  static constexpr std::string_view kQuery = "{query}";
  static constexpr std::string_view kDocument = "{document}";
  std::string out;
  out.reserve(tmpl.size() + query.size() + document.size());
  std::size_t pos = 0;
  while (pos < tmpl.size()) {
    const std::string_view rest = std::string_view(tmpl).substr(pos);
    if (rest.starts_with(kQuery)) {
      out += query;
      pos += kQuery.size();
    } else if (rest.starts_with(kDocument)) {
      out += document;
      pos += kDocument.size();
    } else {
      out += tmpl[pos];
      ++pos;
    }
  }
  return out;
}

const std::unordered_map<std::string, std::string>& RerankModel::checkConfig(
    const std::unordered_map<std::string, std::string>& config) {
  checkLoadOptions(
      config,
      allowedConfigKeys(),
      __func__,
      "rerank",
      "device, gpu_layers, batch_size, verbosity, main-gpu, split-mode, "
      "tensor-split, flash_attn, backend, threads, threads-batch, poll, "
      "poll-batch, openclCacheDir");
  return config;
}

RerankModel::RerankModel(
    const std::string& modelGgufPath,
    const std::unordered_map<std::string, std::string>& config,
    const std::string& backendsDir)
    : loader_(
          "RerankModel", loadHooks(), modelGgufPath, checkConfig(config),
          backendsDir) {}

RerankModel::~RerankModel() { llama_batch_free(batch_); }

LlamaModelLoader::Hooks RerankModel::loadHooks() {
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

void RerankModel::configureParams(
    common_params& params, const ModelMetaData& metadata,
    bool /*ctxSizeConfigured*/) {
  // Reject a model that cannot score pairs before its weights load: RANK
  // pooling over it would score with a slice of a hidden state.
  //
  // An embedding model declares its pooling; a reranker declares RANK or, as
  // many converted cross-encoders do, nothing.
  if (const std::optional<uint32_t> pooling = metadata.tryGetPoolingType();
      pooling.has_value() && *pooling != LLAMA_POOLING_TYPE_RANK) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnsupportedModel),
        string_format(
            "%s: not a reranker: the GGUF's pooling_type is %u, not rank (%d); "
            "load embedding models with GGMLBert",
            __func__,
            *pooling,
            static_cast<int>(LLAMA_POOLING_TYPE_RANK)));
  }
  // A reranker scores with a classifier head: `cls` (BERT-style rerankers)
  // and/or `cls.output` (e.g. Qwen3-Reranker). A chat model declares no
  // pooling and has neither. A streamed model's tensor table is not on disk,
  // so it is not checked.
  if (metadata.hasAnyTensor({"cls.weight", "cls.output.weight"}) == false) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnsupportedModel),
        string_format(
            "%s: not a reranker: the GGUF has no classifier head (cls.weight "
            "or cls.output.weight)",
            __func__));
  }

  // As llama-server's --reranking, in llama-laya's single-pass context.
  configureSinglePassRankContext(params);
}

void RerankModel::onLoaded(llama_model* /*model*/, llama_context* ctx) {
  batch_ = llama_batch_init(static_cast<int32_t>(llama_n_batch(ctx)), 0, 1);

  // Abort a pass in llama_decode once cancel() is requested.
  abortDecodeWhen(ctx, stopCancelled_);
}

std::any RerankModel::process(const std::any& input) {
  if (input.type() != typeid(std::vector<std::string>)) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "RerankModel::process: the input must be the query, then the "
        "documents");
  }
  const auto& sequences = std::any_cast<const std::vector<std::string>&>(input);
  if (sequences.empty()) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(InvalidRequest),
        "RerankModel::process: missing the query");
  }
  return rerank(
      sequences.front(), std::span<const std::string>(sequences).subspan(1));
}

void RerankModel::decodeBatch(
    const std::vector<std::vector<int32_t>>& pairs, std::size_t first,
    std::size_t count, std::vector<float>& scores) {
  llama_context* ctx = loader_.context();

  common_batch_clear(batch_);
  // common_batch_add takes the sequence ids by vector: fill one per pair
  // rather than building one per token.
  std::vector<llama_seq_id> seqIds(1);
  for (std::size_t seq = 0; seq < count; ++seq) {
    const std::vector<int32_t>& tokens = pairs[first + seq];
    seqIds[0] = static_cast<llama_seq_id>(seq);
    for (std::size_t pos = 0; pos < tokens.size(); ++pos) {
      common_batch_add(
          batch_, tokens[pos], static_cast<llama_pos>(pos), seqIds, true);
    }
  }

  llama_memory_clear(llama_get_memory(ctx), true);
  if (llama_decode(ctx, batch_) != 0) {
    if (stopCancelled_.load()) {
      throw std::runtime_error("Job cancelled");
    }
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(DecodeFailed),
        string_format("%s: llama_decode failed", __func__));
  }

  for (std::size_t seq = 0; seq < count; ++seq) {
    const float* out =
        llama_get_embeddings_seq(ctx, static_cast<llama_seq_id>(seq));
    if (out == nullptr) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(FailedToGetSequenceEmbeddings),
          string_format("%s: no score for pair %zu", __func__, first + seq));
    }
    scores[first + seq] = out[0];
  }
}

RerankScores RerankModel::rerank(
    const std::string& query, std::span<const std::string> documents) {
  loader_.waitForLoadInitialization();
  stopCancelled_.store(false);

  const auto start = std::chrono::steady_clock::now();
  const llama_context* ctx = loader_.context();
  const auto nBatch = static_cast<std::size_t>(llama_n_batch(ctx));
  const auto maxSeqs = static_cast<std::size_t>(llama_n_seq_max(ctx));
  const auto trainedCtx =
      static_cast<std::size_t>(llama_model_n_ctx_train(loader_.model()));

  const PairTokenizer tokenizePair(loader_.model(), query);
  std::vector<std::vector<int32_t>> pairs;
  pairs.reserve(documents.size());
  int32_t totalTokens = 0;
  for (std::size_t i = 0; i < documents.size(); ++i) {
    std::vector<int32_t> tokens = tokenizePair(documents[i]);
    if (tokens.size() > trainedCtx) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(ContextOverflow),
          string_format(
              "%s: document %zu with the query is %zu tokens, more than the "
              "model's trained context (%zu)",
              __func__,
              i,
              tokens.size(),
              trainedCtx));
    }
    if (tokens.size() > nBatch) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(InputTokensExceedBatchSize),
          string_format(
              "%s: document %zu with the query is %zu tokens, more than "
              "batch_size (%zu); increase batch_size",
              __func__,
              i,
              tokens.size(),
              nBatch));
    }
    totalTokens += static_cast<int32_t>(tokens.size());
    pairs.push_back(std::move(tokens));
  }

  // Pack whole pairs into each pass, up to batch_size tokens and the
  // context's sequence limit.
  std::vector<float> scores(pairs.size(), 0.0F);
  int32_t passes = 0;
  std::size_t first = 0;
  while (first < pairs.size()) {
    if (stopCancelled_.load()) {
      throw std::runtime_error("Job cancelled");
    }
    std::size_t count = 0;
    std::size_t tokens = 0;
    while (first + count < pairs.size() && count < maxSeqs &&
           tokens + pairs[first + count].size() <= nBatch) {
      tokens += pairs[first + count].size();
      ++count;
    }
    decodeBatch(pairs, first, count, scores);
    first += count;
    ++passes;
  }

  lastTokens_ = totalTokens;
  lastPasses_ = passes;
  lastDocuments_ = documents.size();
  lastMs_ = std::chrono::duration<double, std::milli>(
                std::chrono::steady_clock::now() - start)
                .count();

  return RerankScores{std::move(scores)};
}

qvac_lib_inference_addon_cpp::RuntimeStats RerankModel::runtimeStats() const {
  qvac_lib_inference_addon_cpp::RuntimeStats stats;
  if (!isLoaded()) {
    return stats;
  }
  stats.emplace_back("total_tokens", static_cast<long long>(lastTokens_));
  stats.emplace_back("total_time_ms", lastMs_);
  stats.emplace_back("documents", static_cast<long long>(lastDocuments_));
  stats.emplace_back("forward_passes", static_cast<long long>(lastPasses_));
  stats.emplace_back(
      "batch_size", static_cast<long long>(llama_n_batch(loader_.context())));
  stats.emplace_back(
      "context_size", static_cast<long long>(llama_n_ctx(loader_.context())));
  stats.emplace_back("backendDevice", loader_.runtimeBackendDevice());
  return stats;
}

void RerankModel::cancel() const { stopCancelled_.store(true); }

void RerankModel::setWeightsForFile(
    const std::string& filename,
    std::unique_ptr<std::basic_streambuf<char>>&& shard) {
  loader_.setWeightsForFile(filename, std::move(shard));
}

void RerankModel::initializeBackend(
    const std::string& backendsDir, const std::string& openclCacheDir) {
  loader_.initializeBackend(backendsDir, openclCacheDir);
}

const llama_context* RerankModel::getCtx() const { return loader_.context(); }

bool RerankModel::isLoaded() const { return loader_.isLoaded(); }
