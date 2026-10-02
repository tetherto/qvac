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
#include <unordered_set>
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
#include "LoadFitNormalization.hpp"
#include "ModelMetadata.hpp"
#include "common/chat.h"
#include "inference-addon-cpp/BlobsStream.hpp"
#include "inference-addon-cpp/GGUFShards.hpp"
#include "inference-addon-cpp/InitLoader.hpp"
#include "inference-addon-cpp/Logger.hpp"
#include "inference-addon-cpp/ModelInterfaces.hpp"
#include "inference-addon-cpp/RuntimeStats.hpp"
#include "utils/JobCancelRegistry.hpp"

using namespace qvac_lib_inference_addon_cpp::model;

namespace batching = qvac_lib_inference_addon_llama::batching;

class LlamaModel : public IModel,
                   public IModelAsyncLoad,
                   public IModelCancel,
                   public IModelMultiprocessor,
                   public IModelCancelById,
                   public IModelJobStats,
                   public IModelJobLifecycle {
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
  /// Whole-model cancel. On the continuous-batching path this only records
  /// the request (ContinuousBatchScheduler::requestCancelAll); the batch
  /// worker applies it later, draining the active slots and pending queue
  /// present AT APPLY TIME — not pinned to the set that existed when this
  /// call returned. That falls short of IModelCancel's point-in-time
  /// obligation, which is why every scheduler cancel entry point reaches
  /// this model per id (IModelCancelById) and never through here. A direct
  /// caller of this surface must not admit new work concurrently, or the
  /// late drain can sweep jobs nobody cancelled.
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

  /// Multi-job entry carrying the admitting job id. An eligible single Prompt
  /// (text generation or a cache-persisting prefill; see isConcurrentEligible)
  /// routes through the scheduler as a one-item batch so it overlaps with
  /// other concurrent jobs; its `seqId` is recorded against @p id so
  /// `cancelById` can target it. Finetune and a model without a scheduler
  /// fall back to the single-job path; a live-only prefill is rejected on a
  /// parallel model (its warmed single-context state would be unreachable and
  /// running it would race peers on the shared context).
  std::any
  process(const std::any& input, qvac_lib_inference_addon_cpp::JobId id) final;

  /// Cancel the in-flight job admitted under @p id: a concurrent job by
  /// cancelling its scheduler slot, a single-path job (no scheduler) by
  /// stopping the single-prompt context. No-op when @p id is unknown
  /// (already finished or never admitted).
  void cancelById(qvac_lib_inference_addon_cpp::JobId id) const final;

  /// Scheduler dequeue announcement (see IModelJobLifecycle): registers the
  /// job in the cancel registry, unarmed, while the scheduler still holds its
  /// admission lock. Any cancel that no longer finds the job queued therefore
  /// finds it registered here, and parks until the job arms its cancel action
  /// — closing the window where a cancel would silently no-op between dequeue
  /// and the model's own per-path registration.
  void jobStarting(qvac_lib_inference_addon_cpp::JobId id) final;

  /// The complete terminal snapshot for a finished concurrent run (see
  /// IModelJobStats), used as the tagged jobEnded payload: the scheduler
  /// stats at the moment the run finished with the job's own observed
  /// figures in place of `TTFT` (enqueue -> first token, ms), `TPS`
  /// (observed generation rate), `generatedTokens` and `promptTokens`. For
  /// a tagged group run these are the group aggregates (rates averaged,
  /// counts summed). The snapshot is built when the run finishes; consuming
  /// it touches no live scheduler or llama_context state (in particular it
  /// never resets the llama perf counters — only the explicit whole-model
  /// runtimeStats() does). Take-once: hands over and erases the entry;
  /// unknown ids yield an empty snapshot.
  [[nodiscard]] qvac_lib_inference_addon_cpp::RuntimeStats
  consumeJobStats(qvac_lib_inference_addon_cpp::JobId id) const final;

  std::string processPrompt(const Prompt& prompt);

  /// Run several prompts in parallel via the continuous-batching session
  /// and return their generated texts in input order. Each output entry
  /// matches the prompt at the same index. Media prompts are accepted on
  /// multimodal models, and per-prompt cache (`cacheKey` / `saveCacheToDisk`)
  /// round-trips media KV via the shared GGSQ sequence-state format. Throws
  /// when batching is unsupported or any prompt is rejected by the session
  /// (oversize,
  /// empty, or capacity exhausted with no room to queue). Output
  /// streaming via `Prompt::outputCallback` is honoured per-slot.
  std::vector<std::string>
  processPromptBatch(const std::vector<Prompt>& prompts);

  /// @brief True when the model was loaded with continuous batching active
  /// (`n_seq_max > 1`, i.e. `parallel >= 2`).
  [[nodiscard]] bool supportsBatching() const;

  /// @brief Requests occupying or waiting for a batch slot (active + pending).
  /// 0 when no batch scheduler is active (`parallel: 1`, or between reloads),
  /// where capacity is a job count instead — an admission check must therefore
  /// take the max of this and the scheduler's job count, never this alone.
  [[nodiscard]] unsigned activeSlots() const;

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

  /// @brief Access the LoRA finetuner that owns finetune state and lifecycle
  /// for this model. The reference remains valid for the lifetime of the
  /// `LlamaModel` instance.
  LlamaFinetuner& finetuner() { return finetuner_; }
  const LlamaFinetuner& finetuner() const { return finetuner_; }

  /// Record the checkpoint mode a cancel(savePauseCheckpoint) wants for every
  /// job id in its snapshot: the JS binding arms this right before routing
  /// the snapshotted ids through the scheduler's per-id cancel, so the mode
  /// rides with the targeted cancel instead of a direct "pause whichever
  /// finetune is running" call. Keyed by the snapshot ids themselves — never
  /// by the model's current-finetune marker — so a mode armed while its
  /// finetune is still between the scheduler queue and beginFinetuneJob()
  /// survives until the dispatch reaches the job after it binds.
  /// requestFinetuneCancel consumes exactly its own id's entry;
  /// discardFinetuneCancelSaveModes removes what the dispatch never consumed.
  void setFinetuneCancelSavesCheckpoint(
      bool save,
      const std::vector<qvac_lib_inference_addon_cpp::JobId>& cancelledJobs);

  /// Drop the recorded checkpoint modes for @p cancelledJobs — the
  /// canceller's own snapshot — once its per-id dispatch has returned.
  /// Entries for inference ids, queued jobs that never started, or jobs that
  /// finished first were never consumed and must not outlive the cancel that
  /// armed them.
  void discardFinetuneCancelSaveModes(
      const std::vector<qvac_lib_inference_addon_cpp::JobId>& cancelledJobs);

private:
  friend class LlamaFinetuner;
  // Unit tests reach internals (scheduler, single-prompt context) through this
  // peer instead of public `*ForTesting()` accessors. See
  // test_internal_peers.hpp.
  friend class LlamaModelTestPeer;

  // Impl without mutexes
  std::string processPromptImpl(const Prompt& prompt);

  /// Observes the scheduler `seqId` each request is admitted on, in input
  /// order, at slot admission — before the slot decodes anything. Runs on the
  /// scheduler's worker thread with the scheduler lock held, so it must not
  /// call back into the scheduler; returning true instead makes the scheduler
  /// tear the slot down before it decodes (a cancel that arrived before the
  /// slot existed). `admissionId` is the slot's ownership token for this
  /// admission — the identity a cancel action must carry, since the bare
  /// seqId is recycled to unrelated successors the moment the slot drains.
  /// Lets the concurrent path bind a job id to its slot without the
  /// single-prompt batch callers paying for it.
  using SeqAssignedObserver = std::function<bool(
      size_t requestIndex, uint32_t seqId, uint64_t admissionId)>;
  /// Observes the slot's end (fired from onDone, any outcome).
  using SeqObserver = std::function<void(size_t requestIndex, uint32_t seqId)>;
  /// @p groupTag (non-zero) tags the scheduler group with the job id, so a
  /// cancel can settle it while its requests are still queued for slots.
  batching::BatchResult processPromptBatchImpl(
      const std::vector<Prompt>& prompts,
      const SeqAssignedObserver& onSeqAssigned = {},
      const SeqObserver& onSeqDone = {}, uint64_t groupTag = 0);
  void cancelInference() const;
  void cancelImpl() const;

  /// Pause the active tagged finetune when @p id still owns it, saving a
  /// checkpoint only when armed via setFinetuneCancelSavesCheckpoint.
  void requestFinetuneCancel(qvac_lib_inference_addon_cpp::JobId id) const;
  void beginFinetuneJob(qvac_lib_inference_addon_cpp::JobId id);
  void closeFinetuneCancellationWindow();

  /// True for a single Prompt that may run on the scheduler concurrently:
  /// text generation, or a prefill that persists its cache to disk
  /// (saveCacheToDisk with a cacheKey). Finetune and live-only prefill (whose
  /// sole product is warm state in the shared single context, which a lane
  /// cannot deliver) stay off the concurrent path.
  static bool isConcurrentEligible(const Prompt& prompt);

  /// Route a single Prompt through the scheduler as a one-item batch, recording
  /// its assigned `seqId` against @p id for the lifetime of the run so
  /// `cancelById` can target this job. Reuses processPromptBatchImpl machinery.
  std::string processConcurrent(
      const Prompt& prompt, qvac_lib_inference_addon_cpp::JobId id);

  /// Tagged group run (a runBatched call admitted as one multi-job): runs the
  /// prompts through the scheduler and leaves group-level observed figures
  /// behind for consumeJobStats (rates averaged, counts summed). Records the
  /// group's live seqIds against @p id so cancelById tears down exactly this
  /// group's slots — peers keep running.
  std::vector<std::string> processConcurrentBatch(
      const std::vector<Prompt>& prompts,
      qvac_lib_inference_addon_cpp::JobId id);

  /// Build the JS-facing `RuntimeStats` from the scheduler's live stats
  /// (single source of truth across all in-flight / queued batch work).
  /// Never reads or resets the llama_context perf counters: it runs
  /// concurrently with in-flight batch decodes. Caller must hold
  /// `stateMtx_` shared.
  qvac_lib_inference_addon_cpp::RuntimeStats batchRuntimeStatsLocked() const;
  /// Compose one finished job's complete terminal snapshot from the
  /// scheduler stats its run returned (`BatchResult::stats`, captured under
  /// the scheduler mutex when the group completed) and the job's observed
  /// figures. Mirrors batchRuntimeStatsLocked's key set but reads no live
  /// scheduler or llama_context state, so a finishing job can never race a
  /// peer still decoding on the shared context.
  qvac_lib_inference_addon_cpp::RuntimeStats jobTerminalStats(
      const batching::RuntimeStatsSnapshot& stats,
      const batching::ObservedRequestStats& observed) const;
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

    // Store the appropriate context (TextLlmContext or MtmdLlmContext)
    // Destroyed before backendsHandle_ to avoid use-after-free
    std::unique_ptr<LlmContext> llmContext_;

    /// Set when llama_n_seq_max > 1, null otherwise.
    std::unique_ptr<batching::ContinuousBatchScheduler> batchScheduler_;

    // configuration values parsed from configFilemap
    std::optional<load_fit_normalization::NormalizedFitSnapshot>
        normalizedFitSnapshot_;
    std::optional<CacheManager> cacheManager_;

    /// Mode flags for the most recent `processPrompt*` call, used by
    /// `runtimeStats()` to dispatch between the single-prompt and batch
    /// stat sources. The numbers themselves are NOT cached here: the
    /// scheduler is the single source of truth for batch stats (it
    /// already accumulates across every concurrent `processBatch` caller
    /// in the same idle epoch), and `llama_perf_context` is the source
    /// for single-prompt stats. Per-run reset is a single atomic store of a
    /// fresh `LastRunInfo`.
    struct LastRunInfo {
      bool wasPrefill = false;
      bool wasBatch = false;
    };
    /// Atomic so concurrent `processPrompt*` callers (which hold only a shared
    /// lock on `stateMtx_`) publish the mode flags in one trivially-copyable
    /// store and `runtimeStats()` reads them without tearing. A struct that
    /// small is lock-free on every target.
    std::atomic<LastRunInfo> lastRun_{LastRunInfo{}};

    /// Serializes the entry section of processPromptBatchImpl (the
    /// activeBatchJobs_ check, cache invalidation, and KV wipe). Released
    /// before scheduler.processBatch() so concurrent batch calls can still
    /// overlap during generation.
    std::mutex batchEntryMutex_;
  };

  /// Continuous-batching gate. Active when the user opted into multi-sequence
  /// decoding via `n_parallel >= 2` (which llama.cpp maps directly to
  /// `n_seq_max`); applies to text and multimodal models alike.
  static bool isMultiBatchActivated(ReloadableState& state);

  static std::unique_ptr<batching::ContinuousBatchScheduler>
  initBatchScheduler(ReloadableState& state);

  struct ResolvedPrompt {
    std::vector<common_chat_msg> chatMsgs;
    std::vector<common_chat_tool> tools;
    bool isCacheLoaded = false;
    bool shouldResetAfterInference = false;
  };

  ResolvedPrompt resolveChatAndTools(const Prompt& prompt);

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
      common_init_result_ptr llamaInit);

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

  /// Owner of the single-prompt context: the tagged single-path job whose
  /// armed cancel action may stop it (kNoJobId when none runs). The action
  /// validates its own id against this before stopping — the run-counter
  /// gate alone cannot tell a cancel for the running job from one that
  /// outlived its target (entry still live during the job's completion
  /// tail, or an action copy executing after removal), and such a cancel
  /// must not stop a successor. The scheduler path pins the same ownership
  /// with its (seqId, admissionId) pair.
  std::atomic<qvac_lib_inference_addon_cpp::JobId> currentSingleJobId_{
      qvac_lib_inference_addon_cpp::kNoJobId};

  int64_t runtimeBackendDevice_ = 0;
  /// QVAC-23763: which GPU backend family ran, and why a higher-priority one
  /// did not. Reported alongside backendDevice, which is only cpu/gpu.
  int64_t runtimeBackendFamily_ = 0;
  int64_t runtimeBackendSkipReason_ = 0;

  /// Live tagged jobs and each one's cancel action: a concurrent job binds
  /// its scheduler-slot teardown at slot admission (see SeqAssignedObserver),
  /// a batch group binds one action tearing down all of its live slots, a
  /// single-path job (prefill-only, or no scheduler) arms the single-prompt
  /// context stop on entry, and a finetune job binds requestFinetuneCancel.
  mutable JobCancelRegistry liveJobs_;

  /// Tagged finetune currently in setup or training. This lifecycle marker is
  /// independent of stateMtx_ so cancellation can target setup-time reloads.
  mutable std::atomic<qvac_lib_inference_addon_cpp::JobId>
      currentFinetuneJobId_{qvac_lib_inference_addon_cpp::kNoJobId};
  mutable std::mutex finetuneCancelMtx_;

  /// Checkpoint mode per snapshotted job id for an in-flight
  /// cancel(savePauseCheckpoint): armed for every id in the canceller's
  /// snapshot (independent of whether the finetune has opened its
  /// cancellation window yet), consumed one-shot by that id's
  /// requestFinetuneCancel, leftovers discarded by the canceller after its
  /// dispatch returns and by the job's own window teardown — so an
  /// unconsumed mode can never carry a stale save/no-save choice into a
  /// later finetune's cancellation. Bounded by the snapshot size. Guarded by
  /// finetuneCancelMtx_; mutable like liveJobs_: the const cancel paths
  /// consume it.
  mutable std::unordered_map<qvac_lib_inference_addon_cpp::JobId, bool>
      finetuneCancelSaveModes_;

  /// Count of finetune cancellation requests this model has forwarded to the
  /// finetuner (requestFinetuneCancel() calls). Bumped in every build so
  /// tests can observe the cancel→finetuner contract even in the standalone
  /// test build, where requestFinetuneCancel's finetuner forward is compiled
  /// out (see LlamaModelTestPeer::finetuneCancelRequests).
  mutable std::atomic<unsigned> finetuneCancelRequests_{0};

  /// The complete terminal snapshot a finished concurrent job leaves behind
  /// for consumeJobStats() (see jobTerminalStats). Guarded by
  /// `jobStatsMtx_`. Bounded by the job lifecycle: written only when the
  /// job's run returns, consumed (erased) by the output queue's jobEnded
  /// event right after; a throwing job writes nothing.
  mutable std::mutex jobStatsMtx_;
  mutable std::unordered_map<
      qvac_lib_inference_addon_cpp::JobId,
      qvac_lib_inference_addon_cpp::RuntimeStats>
      jobStats_;

  /// Cache keys being persisted by in-flight scheduler runs. Reserved at
  /// admission in processPromptBatchImpl and released when the run returns;
  /// a second request saving the same key while it is reserved would race on
  /// the same file, so its admission is refused. Guarded by
  /// `inflightSaveKeysMtx_`.
  std::mutex inflightSaveKeysMtx_;
  std::unordered_set<std::string> inflightSaveKeys_;

  bool isBitnetModel() const;
  void validateBitnetQuantization();

  // Guarded by stateMtx_: written and read exclusively inside
  // setInitLoader() / init() → normalizeLoadForFit(), both of which run
  // under the stateMtx_ unique_lock. Callers set it via reload()'s
  // newFinetuneOverrides parameter to avoid any unsynchronised window.
  FinetuneConfigOverrides pendingFinetuneOverrides_;

  // Declared last so it is destroyed first; the finetuner stores a
  // reference back to this model. Mutable like liveJobs_: cancel paths are
  // const and must reach requestPause().
  mutable LlamaFinetuner finetuner_{*this};
};
