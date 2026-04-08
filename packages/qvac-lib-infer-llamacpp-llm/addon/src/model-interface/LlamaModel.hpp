#pragma once
#include <atomic>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <shared_mutex>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include <llama.h>
#include <picojson/picojson.h>

#include "AsyncWeightsLoader.hpp"
#include "CacheManager.hpp"
#include "LlamaFinetuningHelpers.hpp"
#include "LlamaFinetuningParams.hpp"
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
    double trainLossUncertainty = 0.0;
    double valLoss = 0.0;
    double valLossUncertainty = 0.0;
    double trainAccuracy = 0.0;
    double trainAccuracyUncertainty = 0.0;
    double valAccuracy = 0.0;
    double valAccuracyUncertainty = 0.0;
    double learningRate = 0.0;
    int64_t globalSteps = 0;
    int32_t epochsCompleted = 0;
  };

  std::string op;
  std::string status;
  std::optional<Stats> stats;
};

struct FinetuneConfigOverrides {
  bool active{false};
  int64_t batchSize{128};
  int64_t microBatchSize{128};
  int64_t contextLength{128};
  bool gpuSupportsF16OutProd{true};
  bool flashAttn{false};
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

  /// @brief Apply specific parameter defaults based on model metadata
  /// and detected Adreno GPU version by inserting entries into configFilemap.
  /// Must be called before commonParamsParse so inserted entries are processed.
  ///
  /// @param configFilemap The user-supplied config map (will be written to).
  /// @param metadata Model metadata (architecture, quantization info).
  /// @param adrenoVersion Detected Adreno GPU version, if any.
  /// @param finetuneOverrides If set, finetuning mode is active with these
  /// context/batch params and GPU caps.
  static void tuneConfigMap(
      std::unordered_map<std::string, std::string>& configFilemap,
      const ModelMetaData& metadata, const std::optional<int>& adrenoVersion,
      const FinetuneConfigOverrides& finetuneOverrides = {});

  /**
   * The Constructor for llama model.
   * @param modelPath - path to the model file.
   * @param projectionPath - path to the projector file.
   * @param configFilemap - map of configuration files.
   */
  LlamaModel(
      std::string&& modelPath, std::string&& projectionPath,
      std::unordered_map<std::string, std::string>&& configFilemap);

  struct ConstructionArgs {
    std::string modelPath;
    std::string projectionPath;
    std::unordered_map<std::string, std::string> configFilemap;
    InitLoader::LOADER_TYPE loaderType = InitLoader::LOADER_TYPE::DELAYED;
  };

  /**
   * The Destructor for llama model.
   * Members are destroyed in reverse order of declaration, ensuring
   * llmContext_ is destroyed before backendsHandle_.
   */
  ~LlamaModel() override = default;

  std::string getName() const final { return "LlamaModel"; }
  void setWeightsForFile(
      const std::string& filename,
      std::unique_ptr<std::basic_streambuf<char>>&& shard) final;
  void cancel() const final;

  using ProgressCallback = std::function<void(
      const llama_finetuning_helpers::FinetuneProgressStats&)>;

  struct Prompt {
    std::string input;
    bool prefill = false;
    GenerationParams generationParams;
    std::vector<std::vector<uint8_t>> media;
    std::function<void(const std::string&)> outputCallback;
    ProgressCallback progressCallback;
    std::optional<qvac_lib_inference_addon_llama::LlamaFinetuningParams>
        finetuningParams;
  };

  std::any process(const std::any& input) final;
  std::string processPrompt(const Prompt& prompt);

  /**
   * The Reset method.
   */
  void reset() {
    std::shared_lock lock(stateMtx_);
    resetState();
  }

  /// @brief Rebuilds reloadable model state using stored construction args.
  /// Acquires exclusive lock on stateMtx_; tries to cancel and blocks until
  /// any in-flight operation that access the state finishes, then safely swaps
  /// the state.
  /// @param newFinetuneOverrides  When provided, pendingFinetuneOverrides_ is
  ///   atomically replaced under the exclusive lock before the reload proceeds.
  ///   Omit (or std::nullopt) to leave pendingFinetuneOverrides_ unchanged.
  void reload(
      std::optional<FinetuneConfigOverrides> newFinetuneOverrides =
          std::nullopt);

  /**
   * Check if model is loaded.
   */
  bool isLoaded();

  /**
   * Get the nPast position before tool evaluation.
   * This is used to find the boundary in the KV cache after evaluating
   * conversation tokens but before tool tokens.
   * @return the nPast position, or -1 if not set.
   */
  llama_pos getNPastBeforeTools() const;

  void waitForLoadInitialization() final {
    std::shared_ptr<ReloadableState> localState;
    {
      std::shared_lock lock(stateMtx_);
      localState = state_;
    }
    localState->initLoader_.waitForLoadInitialization();
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
  // Impl without mutexes
  std::string processPromptImpl(const Prompt& prompt);
  void cancelImpl() const;

  struct ReloadableState {
    ReloadableState(
        const ConstructionArgs& args, const std::string& loadingContext,
        ModelMetaData& metadata)
        : shards_(GGUFShards::expandGGUFIntoShards(args.modelPath)),
          asyncWeightsLoader_(shards_, initLoader_, loadingContext, &metadata) {
    }

    GGUFShards shards_;
    friend class InitLoader;
    InitLoader initLoader_;
    AsyncWeightsLoader asyncWeightsLoader_;

    bool isTextLlm_ = false;

    // Backend handle must be declared before llmContext_ to ensure
    // llmContext_ is destroyed first (members destroyed in reverse order)
    std::optional<LlamaBackendsHandle> backendsHandle_;

    // Store the appropriate context (TextLlmContext or MtmdLlmContext)
    // Destroyed before backendsHandle_ to avoid use-after-free
    std::unique_ptr<LlmContext> llmContext_;

    // configuration values parsed from configFilemap
    llama_pos configuredNDiscarded_ = 0;
    std::optional<CacheManager> cacheManager_;

    bool lastRunWasPrefill_ = false;
  };

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
      common_params& params, std::optional<int>& outAdrenoVersion,
      bool& outToolsAtEnd);

  /**
   * The Format prompt method. It formats the prompt json to chat messages.
   *
   * @param input - input prompt.
   * @return formatted chat messages and tools.
   */
  std::pair<std::vector<common_chat_msg>, std::vector<common_chat_tool>>
  formatPrompt(const std::string& input);
  void resetState(bool resetStats = true);
  std::unique_ptr<LlmContext> createContext(
      std::string&& projectionPath, common_params& params,
      common_init_result&& llamaInit, bool toolsAtEnd);

  bool loadMedia(const std::vector<uint8_t>& input);

  void setInitLoader(
      std::optional<InitLoader::LOADER_TYPE> loaderType = std::nullopt,
      std::optional<FinetuneConfigOverrides> newFinetuneOverrides =
          std::nullopt);

  void init(bool acquireLock);

  const std::string loadingContext_;
  ModelMetaData metadata_;
  ConstructionArgs constructionArgs_;

  /// Shared lock for all methods that read/use state_ members; exclusive lock
  /// only in reload()
  mutable std::shared_mutex stateMtx_;
  std::shared_ptr<ReloadableState> state_;
  int64_t runtimeBackendDevice_ = 0;

  bool isBitnetModel() const;
  void validateBitnetQuantization();
  void validateModelForFinetuning();
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

  // Guarded by stateMtx_: written and read exclusively inside
  // setInitLoader() / init() → commonParamsParse(), both of which run
  // under the stateMtx_ unique_lock. Callers set it via reload()'s
  // newFinetuneOverrides parameter to avoid any unsynchronised window.
  FinetuneConfigOverrides pendingFinetuneOverrides_;

  mutable std::mutex checkpointStateMutex_;
  std::shared_ptr<llama_finetuning_helpers::TrainingCheckpointState>
      currentCheckpointState_;
  std::shared_ptr<llama_finetuning_helpers::TrainingCheckpointState>
      pausedCheckpointState_;
};
