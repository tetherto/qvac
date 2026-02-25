#pragma once
#include <atomic>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include <llama.h>
#include <picojson/picojson.h>

#include "CacheManager.hpp"
#include "LlamaFinetuningParams.hpp"
#include "LlamaFinetuningHelpers.hpp"
#include "LlamaLazyInitializeBackend.hpp"
#include "LlmContext.hpp"
#include "common/chat.h"
#include "qvac-lib-inference-addon-cpp/BlobsStream.hpp"
#include "qvac-lib-inference-addon-cpp/GGUFShards.hpp"
#include "qvac-lib-inference-addon-cpp/InitLoader.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"
#include "qvac-lib-inference-addon-cpp/ModelInterfaces.hpp"
#include "qvac-lib-inference-addon-cpp/RuntimeStats.hpp"

using namespace qvac_lib_inference_addon_cpp::model;

class LlamaModel : public IModel, public IModelAsyncLoad, public IModelCancel {
public:
  LlamaModel(const LlamaModel&) = delete;
  LlamaModel& operator=(const LlamaModel&) = delete;
  LlamaModel(LlamaModel&&) = delete;
  LlamaModel& operator=(LlamaModel&&) = delete;
  LlamaModel(
      std::string&& modelPath, std::string&& projectionPath,
      std::unordered_map<std::string, std::string>&& configFilemap);
  ~LlamaModel() override = default;

  std::string getName() const final { return "LlamaModel"; }
  void setWeightsForFile(
      const std::string& filename,
      std::unique_ptr<std::basic_streambuf<char>>&& shard) final;
  void cancel() const final;

  struct Prompt {
    std::string input;
    bool prefill = false;
    std::optional<std::vector<uint8_t>> media;
    std::function<void(const std::string&)> outputCallback;
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
      const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params);
  bool isFinetuneRunning() const;
  bool requestPause();
  void clearPauseRequest();
  llama_finetuning_helpers::TrainingCheckpointState* getCurrentCheckpointState()
      const;

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
  const GGUFShards shards_;
  friend class InitLoader;
  InitLoader initLoader_;
  bool isTextLlm_ = false;
  bool isStreaming_ = false;
  std::map<std::string, std::unique_ptr<std::basic_streambuf<char>>>
      singleGgufStreamedFiles_;
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
  std::unique_ptr<llama_finetuning_helpers::TrainingCheckpointState>
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
      int64_t evalDatasetSampleCount = 0);
  void saveLoraAdapter(
      llama_adapter_lora* adapter,
      const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params);

  std::atomic<llama_finetuning_helpers::TrainingCheckpointState*>
      currentCheckpointState_{nullptr};
  std::unique_ptr<llama_finetuning_helpers::TrainingCheckpointState>
      pausedCheckpointState_;
  bool optimizerInitialized_ = false;
};
