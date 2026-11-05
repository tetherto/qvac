#pragma once

#include <any>
#include <atomic>
#include <cstdint>
#include <memory>
#include <span>
#include <streambuf>
#include <string>
#include <unordered_map>
#include <vector>

#include "LlamaModelLoader.hpp"
#include "ModelMetadata.hpp"
#include "inference-addon-cpp/ModelInterfaces.hpp"
#include "inference-addon-cpp/RuntimeStats.hpp"

/// @brief One relevance score per document, in the order the documents were
/// given.
///
/// A distinct type rather than a plain vector so the JS side can recognize the
/// output event by its type name.
struct RerankScores {
  std::vector<float> scores;
};

/// @brief Scores documents against a query with a reranker (cross-encoder)
/// GGUF, as llama-server's `/rerank`.
///
/// Each document is paired with the query, using the model's `rerank` chat
/// template when it has one and `[BOS]query[EOS][SEP]document[EOS]` otherwise,
/// and read out through RANK pooling. The score is the first classifier output
/// of the pair: higher is more relevant. It is the model's raw output, a logit
/// for most rerankers, and is not normalized.
class RerankModel : public qvac_lib_inference_addon_cpp::model::IModel,
                    public qvac_lib_inference_addon_cpp::model::IModelAsyncLoad,
                    public qvac_lib_inference_addon_cpp::model::IModelCancel {
public:
  /// The query, then the documents.
  using Input = std::vector<std::string>;
  using Output = RerankScores;

  /// @param config Load options. Only the keys that apply to a rerank load
  /// are accepted; any other key is rejected with InvalidConfiguration.
  RerankModel(
      const std::string& modelGgufPath,
      const std::unordered_map<std::string, std::string>& config,
      const std::string& backendsDir = "");

  ~RerankModel() override;
  RerankModel(const RerankModel&) = delete;
  RerankModel& operator=(const RerankModel&) = delete;
  RerankModel(RerankModel&&) = delete;
  RerankModel& operator=(RerankModel&&) = delete;

  [[nodiscard]] std::string getName() const final { return "RerankModel"; }

  /// @param input std::vector<std::string>: the query, then the documents.
  /// @returns RerankScores, one score per document.
  std::any process(const std::any& input) final;

  /// @see process
  RerankScores
  rerank(const std::string& query, std::span<const std::string> documents);

  /// @brief Fills a `rerank` chat template's `{query}` and `{document}` in one
  /// pass, so a placeholder inside the query or the document stays text.
  static std::string fillTemplate(
      const std::string& tmpl, const std::string& query,
      const std::string& document);

  /// @brief Forward-pass statistics of the last request.
  [[nodiscard]] qvac_lib_inference_addon_cpp::RuntimeStats
  runtimeStats() const final;

  void cancel() const final;

  void waitForLoadInitialization() final {
    loader_.waitForLoadInitialization();
  }

  void setWeightsForFile(
      const std::string& filename,
      std::unique_ptr<std::basic_streambuf<char>>&& shard) final;

  void initializeBackend(
      const std::string& backendsDir = "",
      const std::string& openclCacheDir = "");

  [[nodiscard]] bool isLoaded() const;

  /// @brief Read-only access to the context, null until loaded.
  [[nodiscard]] const llama_context* getCtx() const;

  /// @brief Throws InvalidConfiguration for a key a rerank load does not
  /// accept, or a thread count that is not a whole number up to the CPU count.
  static const std::unordered_map<std::string, std::string>&
  checkConfig(const std::unordered_map<std::string, std::string>& config);

private:
  LlamaModelLoader::Hooks loadHooks();
  /// Rejects a GGUF whose pooling is not RANK, then sets up a context that
  /// scores whole batches of pairs in one pass.
  void configureParams(
      common_params& params, const ModelMetaData& metadata,
      bool ctxSizeConfigured);
  void onLoaded(llama_model* model, llama_context* ctx);

  /// Scores pairs [first, first + count) in one forward pass, writing each
  /// pair's score to @p scores at the pair's index.
  void decodeBatch(
      const std::vector<std::vector<int32_t>>& pairs, std::size_t first,
      std::size_t count, std::vector<float>& scores);

  llama_batch batch_{};
  mutable std::atomic<bool> stopCancelled_{false};

  int32_t lastTokens_ = 0;
  int32_t lastPasses_ = 0;
  std::size_t lastDocuments_ = 0;
  double lastMs_ = 0.0;

  // Last member: destroyed first, so the llama context goes before the abort
  // callback's target.
  LlamaModelLoader loader_;
};
