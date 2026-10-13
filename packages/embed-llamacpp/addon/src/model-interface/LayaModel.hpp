#pragma once

#include <any>
#include <atomic>
#include <cstdint>
#include <memory>
#include <streambuf>
#include <string>
#include <unordered_map>

#include <llama/common/laya.h>

#include "LlamaModelLoader.hpp"
#include "ModelMetadata.hpp"
#include "inference-addon-cpp/ModelInterfaces.hpp"
#include "inference-addon-cpp/RuntimeStats.hpp"

/// @brief Laya's response to one request, serialized as JSON.
///
/// A distinct type rather than a plain string so the JS side can recognize the
/// output event by its type name.
struct LayaDecisionResult {
  std::string json;
};

/// @brief Typed decisions with Laya checkpoints
/// (https://github.com/NandhaKishorM/laya): a ModernBERT/mmBERT encoder with a
/// decision head that answers `choice`, `score` and `noul` questions in one
/// forward pass per question.
///
/// A request is laya's JSON request, `{"state" | "states", "questions"}`, and
/// the result is laya's response in the format of `Agent.predict` /
/// `predict_batch`. Request handling, batching and answer decoding are fabric's
/// `common_laya_predict`; this class loads the model and maps errors.
class LayaModel : public qvac_lib_inference_addon_cpp::model::IModel,
                  public qvac_lib_inference_addon_cpp::model::IModelAsyncLoad,
                  public qvac_lib_inference_addon_cpp::model::IModelCancel {
public:
  using Input = std::string;
  using Output = LayaDecisionResult;

  /// @param config Load options. Only the keys that apply to a Laya load are
  /// accepted; any other key is rejected with InvalidConfiguration.
  LayaModel(
      const std::string& modelGgufPath,
      const std::unordered_map<std::string, std::string>& config,
      const std::string& backendsDir = "");

  ~LayaModel() override = default;
  LayaModel(const LayaModel&) = delete;
  LayaModel& operator=(const LayaModel&) = delete;
  LayaModel(LayaModel&&) = delete;
  LayaModel& operator=(LayaModel&&) = delete;

  [[nodiscard]] std::string getName() const final { return "LayaModel"; }

  /// @brief Answers one request.
  /// @param input std::string holding laya's request JSON.
  /// @returns LayaDecisionResult holding laya's response JSON.
  std::any process(const std::any& input) final;

  /// @see process
  LayaDecisionResult predict(const std::string& requestJson);

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

  /// @brief Throws InvalidConfiguration for a key a Laya load does not
  /// accept, or a thread count that is not a whole number up to the CPU count.
  static const std::unordered_map<std::string, std::string>&
  checkConfig(const std::unordered_map<std::string, std::string>& config);

private:
  LlamaModelLoader::Hooks loadHooks();
  /// Single-pass decision context, as llama-laya sets it up.
  void configureParams(
      common_params& params, const ModelMetaData& metadata,
      bool ctxSizeConfigured);
  /// Prepares laya's tokenizer and configuration and warms the backends up.
  void onLoaded(llama_model* model, llama_context* ctx);

  common_laya_ptr laya_;
  mutable std::atomic<bool> stopCancelled_{false};

  int32_t lastTokens_ = 0;
  int32_t lastPasses_ = 0;
  std::size_t lastSequences_ = 0;
  double lastMs_ = 0.0;

  // Last member: destroyed first, so the llama context goes before laya_ and
  // the abort callback's target.
  LlamaModelLoader loader_;
};
