#pragma once
#include <atomic>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include <llama.h>
#include <picojson/picojson.h>

#include "AsyncWeightsLoader.hpp"
#include "CacheManager.hpp"
#include "LlamaFinetuningParams.hpp"
#include "LlamaFinetuningHelpers.hpp"
#include "LlamaLazyInitializeBackend.hpp"
#include "LlmContext.hpp"
#include "ModelMetadata.hpp"
#include "common/chat.h"
#include "qvac-lib-inference-addon-cpp/BlobsStream.hpp"
#include "qvac-lib-inference-addon-cpp/GGUFShards.hpp"
#include "qvac-lib-inference-addon-cpp/InitLoader.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"
#include "qvac-lib-inference-addon-cpp/ModelInterfaces.hpp"
#include "qvac-lib-inference-addon-cpp/RuntimeStats.hpp"

using namespace qvac_lib_inference_addon_cpp::model;

struct FinetuneTerminalResult {
  struct Stats {
    double trainLoss = 0.0;
    double valLoss = 0.0;
    double trainAccuracy = 0.0;
    double valAccuracy = 0.0;
    double learningRate = 0.0;
    int64_t globalSteps = 0;
    int32_t epochsCompleted = 0;
  };

  std::string op;
  std::string status;
  std::optional<Stats> stats;
};

class LlamaModel : public IModel, public IModelAsyncLoad, public IModelCancel {
public:
  LlamaModel(const LlamaModel&) = delete;
  LlamaModel& operator=(const LlamaModel&) = delete;
  LlamaModel(LlamaModel&&) = delete;
  LlamaModel& operator=(LlamaModel&&) = delete;

  /// @brief Resolves shard basenames in-place to absolute paths relative to
  /// the parent directory of @p modelPath.
  static void
  resolveShardPaths(GGUFShards& shards, const std::string& modelPath);

  /**
   * The Constructor for llama model.
   * @param modelPath - path to the model file.
   * @param projectionPath - path to the projector file.
   * @param configFilemap - map of configuration files.
   */
  LlamaModel(
      std::string&& modelPath, std::string&& projectionPath,
      std::unordered_map<std::string, std::string>&& configFilemap);
  ~LlamaModel() override = default;

  std::string getName() const final { return "LlamaModel"; }
  void setWeightsForFile(
      const std::string& filename,
      std::unique_ptr<std::basic_streambuf<char>>&& shard) final;
  void cancel() const final;

  using ProgressCallback =
      std::function<void(const llama_finetuning_helpers::FinetuneProgressStats&)>;

  struct Prompt {
    std::string input;
    bool prefill = false;
    std::optional<std::vector<uint8_t>> media;
    std::function<void(const std::string&)> outputCallback;
    ProgressCallback progressCallback;
    std::optional<qvac_lib_inference_addon_llama::LlamaFinetuningParams>
        finetuningParams;
  };

  std::any process(const std::any& input) final;
  std::string processPrompt(const Prompt& prompt);
  void reset() { resetState(); }
  void initializeBackend(const std::string& backendsDir = "");
  bool isLoaded();

  void waitForLoadInitialization() final {
    initLoader_.waitForLoadInitialization();
  }

  llama_context* getContext();
  llama_model* getModel();
  common_params& getCommonParams();

  qvac_lib_inference_addon_cpp::RuntimeStats runtimeStats() const final;
  static void
  llamaLogCallback(ggml_log_level level, const char* text, void* userData);

  std::string finetune(
      const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params,
      FinetuneTerminalResult::Stats* outStats = nullptr,
      ProgressCallback progressCallback = nullptr);
  bool isFinetuneRunning() const;
  bool requestPause();
  void clearPauseRequest();

  /** Block until the training thread has completed the finetuning pause path.
   */
  void waitUntilFinetuningPauseComplete();

private:
  struct ResolvedPrompt {
    std::vector<common_chat_msg> chatMsgs;
    std::vector<common_chat_tool> tools;
    bool isCacheLoaded = false;
    bool shouldResetAfterInference = false;
  };
  ResolvedPrompt resolveChatAndTools(const std::string& input);

  void commonParamsParse(
      const std::string& modelPath,
      std::unordered_map<std::string, std::string>& configFilemap,
      common_params& params);
  std::pair<std::vector<common_chat_msg>, std::vector<common_chat_tool>>
  formatPrompt(const std::string& input);
  void resetState(bool resetStats = true);
  std::unique_ptr<LlmContext> createContext(
      std::string&& projectionPath, common_params& params,
      common_init_result&& llamaInit);
  bool loadMedia(const std::vector<uint8_t>& input);
  void init(
      std::string&& modelPath, std::string&& projectionPath,
      std::unordered_map<std::string, std::string>&& configFilemap);

  const std::string loadingContext_;
  GGUFShards shards_;
  friend class InitLoader;
  InitLoader initLoader_;
  ModelMetaData metadata_;
  AsyncWeightsLoader asyncWeightsLoader_;

  bool isTextLlm_ = false;

  // Backend handle must be declared before llmContext_ to ensure
  // llmContext_ is destroyed first (members destroyed in reverse order)
  std::optional<LlamaBackendsHandle> backendsHandle_;
  std::unique_ptr<LlmContext> llmContext_;
  llama_pos configuredNDiscarded_ = 0;
  std::optional<CacheManager> cacheManager_;

  void validateFinetuningParams(
      const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params);
  ggml_opt_dataset_t prepareTrainingDataset(
      const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params);
  ggml_opt_dataset_t prepareEvalDataset(
      const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params);
  ggml_opt_dataset_t prepareDatasetFromPath(
      const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params,
      const std::string& datasetPath, const char* errorLabel,
      const char* constructKind);
  void initializeLoraAdapter(
      const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params,
      uint32_t targetModules, llama_adapter_lora*& adapter);
  llama_finetuning_helpers::LoraLrSchedulerState createLrScheduler(
      const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params,
      int64_t totalSteps);
  std::shared_ptr<llama_finetuning_helpers::TrainingCheckpointState>
  initializeCheckpointing(
      const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params,
      llama_adapter_lora* adapter,
      llama_finetuning_helpers::LoraLrSchedulerState* scheduler);
  void configureOptimizer(
      const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params,
      llama_adapter_lora* adapter,
      llama_finetuning_helpers::LoraLrSchedulerState& scheduler,
      llama_finetuning_helpers::TrainingCheckpointState* checkpointState,
      bool loadOptimizerState = false);
  void executeTrainingLoop(
      const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params,
      ggml_opt_dataset_t dataset, int64_t trainSplit, int64_t evalSplit,
      llama_finetuning_helpers::LoraLrSchedulerState& scheduler,
      llama_finetuning_helpers::TrainingCheckpointState* checkpointState,
      uint32_t startEpoch = 0, bool resumingFromPause = false,
      ggml_opt_dataset_t evalDataset = nullptr,
      int64_t evalDatasetSampleCount = 0,
      FinetuneTerminalResult::Stats* outStats = nullptr);
  void saveLoraAdapter(
      llama_adapter_lora* adapter,
      const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params);

  std::shared_ptr<llama_finetuning_helpers::TrainingCheckpointState>
  getCurrentCheckpointStateShared() const;
  void setCurrentCheckpointStateShared(
      std::shared_ptr<llama_finetuning_helpers::TrainingCheckpointState> state);
  void clearCurrentCheckpointStateShared();
  std::shared_ptr<llama_finetuning_helpers::TrainingCheckpointState>
  getPausedCheckpointStateShared() const;
  void setPausedCheckpointStateShared(
      std::shared_ptr<llama_finetuning_helpers::TrainingCheckpointState> state);
  void clearPausedCheckpointStateShared();

  mutable std::mutex checkpointStateMutex_;
  std::shared_ptr<llama_finetuning_helpers::TrainingCheckpointState>
      currentCheckpointState_;
  std::shared_ptr<llama_finetuning_helpers::TrainingCheckpointState>
      pausedCheckpointState_;
  bool optimizerInitialized_ = false;
};
