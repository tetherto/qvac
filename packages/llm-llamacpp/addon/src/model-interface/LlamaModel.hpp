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
#include "ContinuousBatchScheduler.hpp"
#include "LlamaFinetuner.hpp"
#include "LlamaFinetuningHelpers.hpp"
#include "LlamaFinetuningParams.hpp"
#include "LlamaLazyInitializeBackend.hpp"
#include "LlmContext.hpp"
#include "ModelMetadata.hpp"
#include "ToolsCompactController.hpp"
#include "common/chat.h"
#include "inference-addon-cpp/BlobsStream.hpp"
#include "inference-addon-cpp/GGUFShards.hpp"
#include "inference-addon-cpp/InitLoader.hpp"
#include "inference-addon-cpp/Logger.hpp"
#include "inference-addon-cpp/ModelInterfaces.hpp"
#include "inference-addon-cpp/RuntimeStats.hpp"

using namespace qvac_lib_inference_addon_cpp::model;

namespace batching = qvac_lib_inference_addon_llama::batching;

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
  /// @param isOpenCl True when the chosen GPU backend is OpenCL; used to
  /// disable flash-attn by default since it is not reliably supported on
  /// the OpenCL backend.
  static void tuneConfigMap(
      std::unordered_map<std::string, std::string>& configFilemap,
      const ModelMetaData& metadata, const std::optional<int>& adrenoVersion,
      const FinetuneConfigOverrides& finetuneOverrides = {},
      bool isOpenCl = false);

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

  struct Prompt {
    std::string input;
    bool prefill = false;
    GenerationParams generationParams;
    std::vector<std::vector<uint8_t>> media;
    std::function<void(const std::string&)> outputCallback;
    LlamaFinetuner::ProgressCallback progressCallback;
    std::optional<qvac_lib_inference_addon_llama::LlamaFinetuningParams>
        finetuningParams;

    std::string cacheKey;
    bool saveCacheToDisk = false;
  };

  std::any process(const std::any& input) final;
  std::string processPrompt(const Prompt& prompt);

  /// Run several prompts in parallel via the continuous-batching session
  /// and return their generated texts in input order. Each output entry
  /// matches the prompt at the same index. Throws when batching is
  /// unsupported (multimodal context) or any prompt is rejected by the
  /// session (oversize, empty, or capacity exhausted with no room to
  /// queue). Output streaming via `Prompt::outputCallback` is honoured
  /// per-slot.
  std::vector<std::string>
  processPromptBatch(const std::vector<Prompt>& prompts);

  /// @brief True when the model was loaded with continuous batching active
  /// (text-only context with `n_seq_max > 1`, i.e. `parallel >= 2`).
  [[nodiscard]] bool supportsBatching() const;

  /**
   * The Reset method.
   */
  void reset() {
    std::shared_lock lock(stateMtx_);
    resetState();
  }

  // Thread-safety: safe to call from any thread (e.g. OS memory-pressure
  // callback). Must NOT be called from a thread that synchronously drives
  // unload() — that would deadlock (shared vs exclusive on stateMtx_).
  void onMemoryWarning() {
    std::shared_lock lock(stateMtx_);
    if (state_->llmContext_) {
      state_->llmContext_->onMemoryWarning();
    }
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
  qvac_lib_inference_addon_cpp::RuntimeStats runtimeDebugStats() const;
  static void
  llamaLogCallback(ggml_log_level level, const char* text, void* userData);

  /// @brief Access the LoRA finetuner that owns finetune state and lifecycle
  /// for this model. The reference remains valid for the lifetime of the
  /// `LlamaModel` instance.
  LlamaFinetuner& finetuner() { return finetuner_; }
  const LlamaFinetuner& finetuner() const { return finetuner_; }

  /// For unit tests only: access the internal batch scheduler so tests can
  /// inject a decode stub via setDecodeFuncForTesting(). Returns null when
  /// batching is not active (n_parallel < 2 or multimodal model).
  batching::ContinuousBatchScheduler* batchSchedulerForTesting();

private:
  friend class LlamaFinetuner;

  // Impl without mutexes
  std::string processPromptImpl(const Prompt& prompt);
  std::vector<std::string>
  processPromptBatchImpl(const std::vector<Prompt>& prompts);
  void cancelImpl() const;

  /// Build the JS-facing `RuntimeStats` from the scheduler's live stats
  /// (single source of truth across all in-flight / queued batch work).
  /// Caller must hold `stateMtx_` shared.
  qvac_lib_inference_addon_cpp::RuntimeStats batchRuntimeStatsLocked() const;
  /// Build the JS-facing `RuntimeStats` from `llama_perf_context` for
  /// single-prompt runs. Caller must hold `stateMtx_` shared.
  qvac_lib_inference_addon_cpp::RuntimeStats singleRuntimeStatsLocked() const;

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

    // tools_compact controller - owned by ReloadableState, lifetime matches
    // the state. Must be declared before llmContext_ so it is destroyed
    // after contexts that hold references to it.
    std::unique_ptr<ToolsCompactController> toolsCompact_;

    // Store the appropriate context (TextLlmContext or MtmdLlmContext)
    // Destroyed before backendsHandle_ to avoid use-after-free
    std::unique_ptr<LlmContext> llmContext_;

    /// Set when llama_n_seq_max > 1, null otherwise.
    std::unique_ptr<batching::ContinuousBatchScheduler> batchScheduler_;

    // configuration values parsed from configFilemap
    llama_pos configuredNDiscarded_ = 0;
    std::optional<CacheManager> cacheManager_;

    /// Mode flags for the most recent `processPrompt*` call, used by
    /// `runtimeStats()` to dispatch between the single-prompt and batch
    /// stat sources. The numbers themselves are NOT cached here: the
    /// scheduler is the single source of truth for batch stats (it
    /// already accumulates across every concurrent `processBatch` caller
    /// in the same idle epoch), and `llama_perf_context` is the source
    /// for single-prompt stats. Per-run reset is a single value-assign
    /// (`lastRun_ = {}`).
    struct LastRunInfo {
      bool wasPrefill = false;
      bool wasBatch = false;
    };
    LastRunInfo lastRun_;
  };

  /// Continuous-batching gate. Active when the model is text-only and the
  /// user opted into multi-sequence decoding via `n_parallel >= 2`
  /// (which llama.cpp maps directly to `n_seq_max`).
  static bool isMultiBatchActivated(ReloadableState& state);

  static std::unique_ptr<batching::ContinuousBatchScheduler>
  initBatchScheduler(ReloadableState& state);

  struct ResolvedPrompt {
    std::vector<common_chat_msg> chatMsgs;
    std::vector<common_chat_tool> tools;
    PromptLayout layout;
    bool isCacheLoaded = false;
    bool shouldResetAfterInference = false;
  };

  enum class ToolsCompactResolution {
    NotRequested,
    RequestedUnsupported,
    RequestedSupported
  };

  struct ResolvedToolsCompactConfig {
    ToolsCompactResolution resolution = ToolsCompactResolution::NotRequested;
    std::optional<ToolsCompactProfile> profile;
  };

  ResolvedPrompt resolveChatAndTools(const Prompt& prompt);
  ResolvedToolsCompactConfig
  resolveToolsCompactConfig(bool toolsCompactRequested) const;

  void commonParamsParse(
      const std::string& modelPath,
      std::unordered_map<std::string, std::string>& configFilemap,
      common_params& params, std::optional<int>& outAdrenoVersion,
      ResolvedToolsCompactConfig& outToolsCompactConfig);

  /**
   * The Format prompt method. It formats the prompt json to chat messages.
   *
   * @param input - input prompt.
   * @return formatted chat messages and tools.
   */
  ParsedPromptPayload formatPrompt(const std::string& input);
  void resetState(bool resetStats = true);
  std::unique_ptr<LlmContext> createContext(
      std::string&& projectionPath, common_params& params,
      common_init_result_ptr llamaInit, ToolsCompactController& tools,
      std::size_t visionCacheBudgetBytes);

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

  /// In-flight run counters per execution engine, used by cancelImpl() to
  /// route a cancel to the engine actually running work. Lock-free on
  /// purpose: cancel() can arrive on the scheduler's worker thread from a
  /// streaming callback that holds the scheduler mutex, so routing must not
  /// take any scheduler lock. Routing also isolates cancel state per
  /// engine — an unconditional broadcast left a stale stop flag on the idle
  /// engine that silently cancelled its next, unrelated run.
  mutable std::atomic<unsigned> activeSingleJobs_{0};
  mutable std::atomic<unsigned> activeBatchJobs_{0};
  int64_t runtimeBackendDevice_ = 0;

  bool isBitnetModel() const;
  void validateBitnetQuantization();

  // Guarded by stateMtx_: written and read exclusively inside
  // setInitLoader() / init() → commonParamsParse(), both of which run
  // under the stateMtx_ unique_lock. Callers set it via reload()'s
  // newFinetuneOverrides parameter to avoid any unsynchronised window.
  FinetuneConfigOverrides pendingFinetuneOverrides_;

  // Declared last so it is destroyed first; the finetuner stores a
  // reference back to this model.
  LlamaFinetuner finetuner_{*this};
};
