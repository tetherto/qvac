#include "LlamaModel.hpp"

#include <algorithm>
#include <cctype>
#include <cinttypes>
#include <cstddef>
#include <filesystem>
#include <mutex>
#include <optional>
#include <shared_mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include <common/arg.h>
#include <common/chat.h>
#include <common/common.h>
#include <common/log.h>
#include <inference-addon-cpp/Errors.hpp>
#include <llama.h>
#ifdef __APPLE__
#include <TargetConditionals.h>
#endif
#include <llama/mtmd/mtmd.h>
#include <picojson/picojson.h>

#include "BatchEntryGuard.hpp"
#include "MediaLoadOrder.hpp"
#include "MtmdLlmContext.hpp"
#include "TextLlmContext.hpp"
#include "addon/LlmErrors.hpp"
#include "handlers/LoadConfigHandlers.hpp"
#include "inference-addon-cpp/LlamacppUtils.hpp"
#include "utils/BackendSelection.hpp"
#include "utils/ChatTemplateUtils.hpp"
#include "utils/LoggingMacros.hpp"
#include "utils/ScopeGuard.hpp"
#include "utils/SharedSnapshot.hpp"

using namespace qvac_lib_inference_addon_llama::errors;
using namespace qvac_lib_inference_addon_cpp::logger;
using namespace qvac_lib_inference_addon_llama::logging;

/// @brief Persist the active KV cache to disk when the caller opted in via
/// `saveCacheToDisk`. Shared by the prefill and post-generation paths so
/// both honour the option identically. No-op when no cache is active.
static void maybeSaveCacheToDisk(
    bool saveCacheToDisk, std::optional<CacheManager>& cacheManager) {
  if (saveCacheToDisk && cacheManager.has_value() &&
      cacheManager->hasActiveCache()) {
    cacheManager->saveCache();
  }
}

void LlamaModel::resolveShardPaths(
    GGUFShards& shards, const std::string& modelPath) {
  if (shards.gguf_files.empty())
    return;
  auto baseDir = std::filesystem::path(modelPath).parent_path();
  if (baseDir.empty())
    return;
  for (auto& f : shards.gguf_files)
    f = (baseDir / f).string();
  shards.tensors_file = (baseDir / shards.tensors_file).string();
}

LlamaModel::LlamaModel(
    std::string&& modelPath, std::string&& projectionPath,
    std::unordered_map<std::string, std::string>&& configFilemap)
    : loadingContext_(InitLoader::getLoadingContext("LlamaModel")),
      constructionArgs_{
          std::move(modelPath),
          std::move(projectionPath),
          std::move(configFilemap)} {
  setInitLoader(InitLoader::LOADER_TYPE::DELAYED);
}

void LlamaModel::reload(
    std::optional<FinetuneConfigOverrides> newFinetuneOverrides) {
  {
    std::shared_lock lock(stateMtx_);
    if (state_->asyncWeightsLoader_.isStreaming()) {
      // TODO: Make Fabric support moving/streaming existing loaded tensors
      // TODO: to a different backend.
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(ReloadNotSupportedForStreamedModel),
          "Cannot reload a model that was loaded via streamed shards; "
          "the streamed weights have already been consumed.");
    }
  }
  setInitLoader(InitLoader::LOADER_TYPE::IMMEDIATE, newFinetuneOverrides);
}

void LlamaModel::setInitLoader(
    std::optional<InitLoader::LOADER_TYPE> loaderType,
    std::optional<FinetuneConfigOverrides> newFinetuneOverrides) {
  cancelInference();
  std::unique_lock lock(stateMtx_);
  // Unconditionally stop the old contexts before destroying them, regardless
  // of job counters. cancel() above only routes to active engines (counters >
  // 0), but reload() must clean up *any* residual state in the old context
  // (e.g. after finetuning, which doesn't increment the counters) before
  // discarding it. Without this, stale stop flags or other state can survive
  // into the next operation and cause decode failures.
  if (state_) {
    if (state_->batchScheduler_) {
      state_->batchScheduler_->requestCancelAll();
    }
    if (state_->llmContext_) {
      state_->llmContext_->stop();
    }
  }
  if (newFinetuneOverrides.has_value()) {
    pendingFinetuneOverrides_ = *newFinetuneOverrides;
  }
  if (loaderType.has_value()) {
    constructionArgs_.loaderType = loaderType.value();
  }
  state_ = std::make_shared<ReloadableState>(
      constructionArgs_, loadingContext_, metadata_);
  bool callerHoldsLock =
      constructionArgs_.loaderType == InitLoader::LOADER_TYPE::IMMEDIATE;
  state_->initLoader_.init(
      constructionArgs_.loaderType,
      [this, acquireLock = !callerHoldsLock]() { this->init(acquireLock); });
}

void LlamaModel::init(bool acquireLock) {
  SharedSnapshot snap(state_, stateMtx_);
  if (!acquireLock) {
    snap.disable();
  }
  snap.lockRead();

  // Defensive guard: not reachable under normal usage because reload() is
  // only called after waitForLoadInitialization() returns, at which point the
  // delayed init callback has already completed. Protects against a misuse
  // scenario where reload() races with the initial delayed load.
  if (snap->llmContext_) {
    return;
  }

  const auto& modelPath = constructionArgs_.modelPath;
  auto configFilemap = constructionArgs_.configFilemap;

  setVerbosityLevel(configFilemap);

  if (!snap->asyncWeightsLoader_.isStreaming()) {
    if (!snap.promoteToWrite()) {
      return;
    }
    resolveShardPaths(snap->shards_, modelPath);
    snap.demoteToRead();
  }

  metadata_.parse(
      modelPath,
      snap->shards_,
      snap->asyncWeightsLoader_.isStreaming(),
      ADDON_ID);
  {
    auto fileType = metadata_.tryGetU32("general.file_type");
    QLOG_IF(
        Priority::DEBUG,
        string_format(
            "[LlamaModel] general.file_type = %s\n",
            fileType.has_value() ? std::to_string(*fileType).c_str()
                                 : "unknown"));
  }

  if (!snap.promoteToWrite()) {
    return;
  }

  {
    std::string backendsDir;
    if (auto it = configFilemap.find("backendsDir");
        it != configFilemap.end()) {
      backendsDir = it->second;
      configFilemap.erase(it);
    }
    std::string openclCacheDir;
    if (auto it = configFilemap.find("openclCacheDir");
        it != configFilemap.end()) {
      openclCacheDir = it->second;
      configFilemap.erase(it);
    }
    snap->backendsHandle_ = LlamaBackendsHandle(backendsDir, openclCacheDir);
  }

  auto normalized = load_fit_normalization::normalizeLoadForFit(
      modelPath,
      std::move(configFilemap),
      metadata_,
      pendingFinetuneOverrides_,
      load_fit_normalization::productionDependencies(
          LlamaModel::llamaLogCallback));
  snap->normalizedFitSnapshot_ = normalized.fitSnapshot;
  runtimeBackendDevice_ = normalized.runtimeBackendDevice;
  common_params params = std::move(normalized.params);

  const std::string errorWhenFailed = toString(UnableToLoadModel);
  auto streamedFiles =
      snap->asyncWeightsLoader_.extractIndividualStreamedFiles();

  snap.demoteToRead();

  common_init_result_ptr llamaInit = initFromConfig(
      params,
      modelPath,
      streamedFiles,
      snap->shards_,
      loadingContext_,
      snap->asyncWeightsLoader_.isStreaming(),
      ADDON_ID,
      errorWhenFailed);

  if (!snap.promoteToWrite()) {
    return;
  }

  snap->isTextLlm_ = constructionArgs_.projectionPath.empty();
  snap->llmContext_ = createContext(
      std::string(constructionArgs_.projectionPath),
      params,
      std::move(llamaInit));

  if (snap->llmContext_) {
    snap->cacheManager_.emplace(
        snap->llmContext_.get(),
        [this](bool resetStats) { this->resetState(resetStats); });
  }

  if (isMultiBatchActivated(*snap)) {
    snap->batchScheduler_ = initBatchScheduler(*snap);
  }
}

bool LlamaModel::isMultiBatchActivated(ReloadableState& state) {
  return state.llmContext_ && llama_n_seq_max(state.llmContext_->getCtx()) > 1;
}

namespace {

// Single source of truth for per-slot driver selection. The model layer owns
// this decision because driver construction needs model-owned handles (the
// shared llama context and the already-loaded mmproj); the scheduler stays
// agnostic of any concrete driver type. `sharedVision` is the loaded mmproj
// (`state.llmContext_` outlives the scheduler, see ReloadableState
// declaration order); null for text-only contexts selects the text driver.
// Capability is queried via `visionContext()` rather than an RTTI cast, so a
// future multimodal context is picked up without inheriting MtmdLlmContext.
batching::DriverFactory
buildDriverFactory(LlmModelContext shared, mtmd_context* sharedVision) {
  return [shared, sharedVision](
             const common_params& params,
             uint32_t seqId,
             llama_pos perSeqCtxCeiling) -> std::unique_ptr<SequenceDriver> {
    const auto sid = static_cast<llama_seq_id>(seqId);
    if (sharedVision != nullptr) {
      return std::make_unique<MtmdLlmContext>(
          params, shared, sharedVision, sid, perSeqCtxCeiling);
    }
    return std::make_unique<TextLlmContext>(
        params, shared, sid, perSeqCtxCeiling);
  };
}

} // namespace

std::unique_ptr<batching::ContinuousBatchScheduler>
LlamaModel::initBatchScheduler(ReloadableState& state) {
  llama_context* ctx = state.llmContext_->getCtx();
  llama_model* mdl = state.llmContext_->getModel();
  const common_params& cparams = state.llmContext_->getParams();
  const auto batchSize = static_cast<size_t>(llama_n_seq_max(ctx));
  const auto ctxTotalTokens = static_cast<unsigned>(llama_n_ctx(ctx));
  const auto batchCapacity = static_cast<int32_t>(cparams.n_batch);
  const auto maxChunkSize = static_cast<unsigned>(cparams.n_ubatch);
  LlmModelContext shared{
      .model = mdl,
      .lctx = ctx,
      .vocab = mdl != nullptr ? llama_model_get_vocab(mdl) : nullptr,
  };
  // The scheduler validates its own geometry (ctxTotalTokens / batchSize, and
  // batchCapacity >= batchSize) with std::invalid_argument, which would escape
  // load unmapped. Both traps are really a `parallel` misconfiguration, so
  // they are reported as InvalidArgument naming the knobs the caller sets.
  try {
    return std::make_unique<batching::ContinuousBatchScheduler>(
        shared,
        maxChunkSize,
        ctxTotalTokens,
        batchSize,
        batchCapacity,
        cparams,
        buildDriverFactory(shared, state.llmContext_->visionContext()));
  } catch (const std::invalid_argument& e) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        string_format(
            "[LlamaModel] parallel=%zu is too large for this context "
            "(ctx_size=%u, batch_size=%d): %s",
            batchSize,
            ctxTotalTokens,
            batchCapacity,
            e.what()));
  }
}

void LlamaModel::setWeightsForFile(
    const std::string& filename,
    std::unique_ptr<std::basic_streambuf<char>>&& shard) {
  std::shared_lock lock(stateMtx_);
  state_->asyncWeightsLoader_.setWeightsForFile(filename, std::move(shard));
}

bool LlamaModel::isLoaded() {
  std::shared_lock lock(stateMtx_);
  return static_cast<bool>(state_->llmContext_);
}

llama_context* LlamaModel::getContext() {
  if (!state_->llmContext_) {
    return nullptr;
  }
  return state_->llmContext_->getCtx();
}

llama_model* LlamaModel::getModel() {
  if (!state_->llmContext_) {
    return nullptr;
  }
  return state_->llmContext_->getModel();
}

common_params& LlamaModel::getCommonParams() {
  if (!state_->llmContext_) {
    throw std::runtime_error("Model context not initialized");
  }
  return state_->llmContext_->getParams();
}

void LlamaModel::llamaLogCallback(
    ggml_log_level level, const char* text, void* userData) {
  (void)userData;
  // Convert ggml_log_level to QLOG Priority
  Priority priority = Priority::DEBUG;
  switch (level) {
  case GGML_LOG_LEVEL_ERROR:
    priority = Priority::ERROR;
    break;
  case GGML_LOG_LEVEL_WARN:
    priority = Priority::WARNING;
    break;
  case GGML_LOG_LEVEL_INFO:
    priority = Priority::INFO;
    break;
  case GGML_LOG_LEVEL_DEBUG:
  case GGML_LOG_LEVEL_NONE:
  case GGML_LOG_LEVEL_CONT:
  default:
    priority = Priority::DEBUG;
    break;
  }

  // Only log if the message priority is at or above the configured verbosity
  // level
  QLOG_IF(priority, string_format("[Llama.cpp] %s", text));
}

void LlamaModel::cancel() const {
  const auto finetuneId = currentFinetuneJobId_.load();
  if (finetuneId != qvac_lib_inference_addon_cpp::kNoJobId) {
    requestFinetuneCancel(finetuneId);
  }
  std::shared_lock lock(stateMtx_, std::try_to_lock);
  if (!lock.owns_lock()) {
    // If lock could not be acquired, it means reload
    // is in progress. It would be pointless to cancel
    // after it finishes reloading since there would be
    // nothing executing.
    return;
  }
  cancelImpl();
}

void LlamaModel::cancelInference() const {
  std::shared_lock lock(stateMtx_, std::try_to_lock);
  if (lock.owns_lock()) {
    cancelImpl();
  }
}

void LlamaModel::cancelImpl() const {
  // Guarded by the run counters, never by the scheduler's `hasWork()`:
  // the per-token streaming callback runs on the scheduler's worker
  // thread while it holds the scheduler `mutex_`, so any locking
  // scheduler method called from a cancel issued inside that callback
  // self-deadlocks. The counters are also what keeps cancel state
  // isolated per engine: only the engine with work in flight gets its
  // stop flag set, so an idle engine never carries a stale flag into
  // its next run.
  if (state_ && state_->batchScheduler_ && activeBatchJobs_.load() > 0) {
    state_->batchScheduler_->requestCancelAll();
  }
  if (state_ && state_->llmContext_ && activeSingleJobs_.load() > 0) {
    state_->llmContext_->stop();
  }
  // Park a cancel on every registered job. The engine stops above only reach
  // work the run counters already see; a job the scheduler dequeued but that
  // has not armed its cancel action yet (jobStarting ran, the engine slot has
  // not) is invisible to them — it consumes the parked cancel when it arms
  // and stops before its first decode. Park-only: running armed actions here
  // could take engine locks, and this cancel may be issued from a streaming
  // callback on the engine's own worker thread (see above).
  liveJobs_.parkAll();
}

void LlamaModel::setFinetuneCancelSavesCheckpoint(
    const bool save,
    const std::vector<qvac_lib_inference_addon_cpp::JobId>& cancelledJobs) {
  std::scoped_lock lock(finetuneCancelMtx_);
  // Keyed by the snapshot itself, never by currentFinetuneJobId_: the
  // canceller can arm while its snapshotted finetune still sits between the
  // scheduler queue and beginFinetuneJob(), and the mode must still be
  // waiting when that job's per-id cancel dispatches after bind. Scheduler
  // ids are never reused, so an entry can only ever reach the job it names.
  for (const auto id : cancelledJobs) {
    finetuneCancelSaveModes_[id] = save;
  }
}

void LlamaModel::discardFinetuneCancelSaveModes(
    const std::vector<qvac_lib_inference_addon_cpp::JobId>& cancelledJobs) {
  std::scoped_lock lock(finetuneCancelMtx_);
  for (const auto id : cancelledJobs) {
    finetuneCancelSaveModes_.erase(id);
  }
}

void LlamaModel::requestFinetuneCancel(
    const qvac_lib_inference_addon_cpp::JobId id) const {
  std::scoped_lock lock(finetuneCancelMtx_);
  if (currentFinetuneJobId_.load() != id) {
    return;
  }
  // One-shot take of exactly this job's mode; absent means the canceller
  // never chose one (whole-model teardown, internal paths) — no checkpoint.
  bool save = false;
  if (const auto found = finetuneCancelSaveModes_.find(id);
      found != finetuneCancelSaveModes_.end()) {
    save = found->second;
    finetuneCancelSaveModes_.erase(found);
  }
  finetuneCancelRequests_.fetch_add(1);
#ifndef STANDALONE_TEST_BUILD
  finetuner_.requestPause(save);
#else
  static_cast<void>(save);
#endif
}

void LlamaModel::beginFinetuneJob(
    const qvac_lib_inference_addon_cpp::JobId id) {
  std::scoped_lock lock(finetuneCancelMtx_);
  currentFinetuneJobId_.store(id);
}

void LlamaModel::closeFinetuneCancellationWindow() {
  std::scoped_lock lock(finetuneCancelMtx_);
  // Defensive teardown: the job is gone and its id is never reissued, so a
  // mode its cancel never consumed is dead weight from here on.
  finetuneCancelSaveModes_.erase(currentFinetuneJobId_.load());
  currentFinetuneJobId_.store(qvac_lib_inference_addon_cpp::kNoJobId);
}

void LlamaModel::jobStarting(const qvac_lib_inference_addon_cpp::JobId id) {
  // Runs under the scheduler's admission lock (see IModelJobLifecycle), so
  // it must stay quick and must not call back into the scheduler. Registering
  // unarmed here makes every later cancel park instead of no-op.
  liveJobs_.add(id);
}

std::any LlamaModel::process(const std::any& input) {
  std::shared_lock lock(stateMtx_);
  if (input.type() != typeid(Prompt) &&
      input.type() != typeid(std::vector<Prompt>)) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(qvac_errors::general_error::InvalidArgument),
        "Invalid input type");
  }
  if (input.type() == typeid(std::vector<Prompt>)) {
    const auto& prompts = std::any_cast<const std::vector<Prompt>&>(input);
    return {processPromptBatchImpl(prompts).outputs};
  }
  validateBitnetQuantization();
  const auto& prompt = std::any_cast<const Prompt&>(input);
#ifndef STANDALONE_TEST_BUILD
  if (prompt.finetuningParams.has_value()) {
    FinetuneTerminalResult::Stats stats{};
    // Release the shared lock before finetune() because reload() inside it
    // acquires an exclusive lock on stateMtx_; safe because finetuning is
    // admitted through MultiJobScheduler::runExclusiveJob, so no inference job
    // holds stateMtx_ while this one runs.
    lock.unlock();
    std::string status = finetuner_.finetune(
        *prompt.finetuningParams, &stats, prompt.progressCallback);
    FinetuneTerminalResult result{"finetune", std::move(status)};
    if (stats.globalSteps > 0 || stats.epochsCompleted > 0) {
      result.stats = stats;
    }
    return std::any(std::move(result));
  }
#else
  if (prompt.finetuningParams.has_value()) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(qvac_errors::general_error::InvalidArgument),
        "Finetuning not available in standalone test build");
  }
#endif
  return {processPromptImpl(prompt)};
}

bool LlamaModel::isConcurrentEligible(const Prompt& prompt) {
  if (prompt.finetuningParams.has_value()) {
    return false;
  }
  // A prefill earns a lane exactly when its product survives the slot
  // teardown: the cache file persisted under its key. A live-only prefill's
  // product is warm state in the shared single context, which a lane wipes.
  return !prompt.prefill ||
         (prompt.saveCacheToDisk && !prompt.cacheKey.empty());
}

std::any LlamaModel::process(
    const std::any& input, qvac_lib_inference_addon_cpp::JobId id) {
  const bool isSingle = input.type() == typeid(Prompt);
  const bool isBatch = input.type() == typeid(std::vector<Prompt>);
  // The scheduler registered this id at dequeue (jobStarting); make sure no
  // path out of here — bad input type, finetune, batch, or an early throw —
  // leaves that entry behind. Inner guards removing the same id first are
  // fine: remove is idempotent, unknown ids (kNoJobId) are a no-op.
  ScopeGuard lifecycleGuard([this, id] { liveJobs_.remove(id); });
  if (id == qvac_lib_inference_addon_cpp::kNoJobId || (!isSingle && !isBatch)) {
    return process(input);
  }
  // A tagged single-path prompt owns no scheduler slot: its cancel action
  // stops the single-prompt context. The run-counter gate keeps a late
  // cancel from leaving a stale stop flag on an idle engine, and the
  // ownership check keeps a cancel that outlived its job — the registry
  // entry is still live through the run's completion tail, and cancel()
  // executes an action copy outside the registry lock — from stopping a
  // successor; the action runs under the canceller's shared stateMtx_ (see
  // cancelById), so state_ stays valid.
  const auto processSinglePath = [this, &input, id] {
    // An escaped cancel for a previous job may have set the context's stop
    // flag after that run's last check. Cleared before the run counter is
    // visible and before the parked-cancel re-issue below, so every stop
    // aimed at THIS job — counter-gated or re-issued — lands after the
    // clear.
    {
      std::shared_lock stateLock(stateMtx_);
      if (state_ && state_->llmContext_) {
        state_->llmContext_->resetStopFlag();
      }
    }
    // Counted before arming: both the armed action and the whole-model
    // cancelImpl gate their context stop on this counter, so a cancel landing
    // any time from arming onwards can stop the eval loop; the loop consumes
    // the flag at its first check, before any decode.
    activeSingleJobs_.fetch_add(1);
    currentSingleJobId_.store(id);
    ScopeGuard countGuard([this] {
      currentSingleJobId_.store(qvac_lib_inference_addon_cpp::kNoJobId);
      activeSingleJobs_.fetch_sub(1);
    });
    const bool parkedCancel = liveJobs_.add(id, [this, id] {
      if (state_ && state_->llmContext_ && activeSingleJobs_.load() > 0 &&
          currentSingleJobId_.load() == id) {
        state_->llmContext_->stop();
      }
    });
    ScopeGuard registrationGuard([this, id] { liveJobs_.remove(id); });
    if (parkedCancel) {
      // A cancel landed while the job sat between the scheduler queue and
      // this slot (jobStarting parked it). Re-issue it through the armed
      // action: the counter above is already visible, so the context stop
      // lands and the request cancels with the usual rollback.
      cancelById(id);
    }
    return process(input);
  };
  if (isSingle) {
    const auto& prompt = std::any_cast<const Prompt&>(input);
    if (prompt.finetuningParams.has_value()) {
      beginFinetuneJob(id);
      ScopeGuard finetuneGuard([this] {
        // Window first: once currentFinetuneJobId_ is cleared no cancel can
        // latch a new pause (requestFinetuneCancel serializes on the same
        // mutex), so the discard leaves nothing behind for the next finetune.
        // Covers the exits finetune() never sees: the parked-cancel PAUSED
        // return below and setup throws before the finetuner's own catch.
        closeFinetuneCancellationWindow();
        finetuner_.discardPendingPauseRequest();
      });
      // Arm the finetune cancel so cancelById(id) reaches the finetuner; a
      // cancel parked before this point aborts the job before training starts.
      if (liveJobs_.bind(id, [this, id] { requestFinetuneCancel(id); })) {
        return std::any(FinetuneTerminalResult{"finetune", "PAUSED"});
      }
      return process(input);
    }
    if (!isConcurrentEligible(prompt)) {
      // Live-only prefill: its warmed single-context state is unreachable by
      // lane-based followups, and running it beside admitted peers would race
      // on the shared context. Reject on a parallel model; without a
      // scheduler the single path is the only worker and stays safe.
      {
        std::shared_lock rejectLock(stateMtx_);
        if (state_ && state_->batchScheduler_) {
          throw qvac_errors::StatusError(
              ADDON_ID,
              toString(qvac_errors::general_error::InvalidArgument),
              "prefill without saveCacheToDisk and a cacheKey cannot run on "
              "a parallel model: its warmed context is unreachable by "
              "concurrent jobs; persist the cache or load with parallel=1");
        }
      }
      return processSinglePath();
    }
  }
  std::shared_lock lock(stateMtx_);
  if (!state_ || !state_->batchScheduler_) {
    lock.unlock();
    return isSingle ? processSinglePath() : process(input);
  }
  if (isBatch) {
    return {processConcurrentBatch(
        std::any_cast<const std::vector<Prompt>&>(input), id)};
  }
  return {processConcurrent(std::any_cast<const Prompt&>(input), id)};
}

std::vector<std::string> LlamaModel::processConcurrentBatch(
    const std::vector<Prompt>& prompts,
    const qvac_lib_inference_addon_cpp::JobId id) {
  // Tag the scheduler group with the job id so a cancel can target it before
  // any admission. Job ids are minted monotonically and never reused, so a tag
  // cannot be confused with a later group's.
  const auto groupTag = static_cast<uint64_t>(id);
  // The group's live slots, shared with its cancel action: every admission's
  // (seqId -> admissionId) ownership pair. A slot joins at admission and
  // leaves the moment it ends — the scheduler may recycle the seqId to a
  // peer job, so a late group cancel must never see it; and because a
  // snapshot taken before that removal can still race the recycle, each
  // cancel also carries the admissionId so the scheduler itself rejects a
  // stale target. `cancelled` marks the whole group: requests admitted after
  // the cancel are torn down at admission instead of outliving their group.
  struct GroupSlots {
    std::mutex mtx;
    std::unordered_map<uint32_t, uint64_t> seqs;
    bool cancelled = false;
  };
  auto slots = std::make_shared<GroupSlots>();

  // The group's cancel action: tear down every slot it currently holds, and
  // settle the group when some of its requests are still queued — those have
  // no slot to tear down, and waiting for them to be admitted means waiting on
  // whichever unrelated group currently holds the pool. Runs under the
  // canceller's shared stateMtx_ (see cancelById), so state_ stays valid; it
  // releases slots->mtx before touching the scheduler, so it never holds both
  // locks at once.
  const auto cancelGroup = [this, slots, groupTag] {
    std::vector<std::pair<uint32_t, uint64_t>> seqs;
    {
      std::lock_guard<std::mutex> seqsLock(slots->mtx);
      slots->cancelled = true;
      seqs.assign(slots->seqs.begin(), slots->seqs.end());
      slots->seqs.clear();
    }
    if (state_ && state_->batchScheduler_) {
      for (const auto& [seqId, admissionId] : seqs) {
        state_->batchScheduler_->cancel(seqId, admissionId);
      }
      // No-op once every request of the group holds a slot: the loop above
      // already covers it, and the scheduler keeps the graceful in-slot cancel.
      state_->batchScheduler_->cancelGroupQueued(groupTag);
    }
  };

  // Armed BEFORE submission: a cancel that arrives while the group is still
  // entirely queued must reach the drain above, not sit parked until the group
  // is finally admitted. The arming registration also hands back a cancel
  // parked between the scheduler dequeue and here (jobStarting -> parkAll),
  // which is refused as Cancelled — the structured code consumers already
  // match on for every other cancellation terminal, rather than a bare
  // runtime_error whose message they would have to string-match.
  if (liveJobs_.add(id, cancelGroup)) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_lib_inference_addon_llama::errors::toString(
            qvac_lib_inference_addon_llama::errors::Cancelled),
        "LlamaModel: batch cancelled before it could run (cancelled between "
        "the scheduler dequeue and admission)");
  }
  ScopeGuard mapGuard([this, id] { liveJobs_.remove(id); });

  const SeqAssignedObserver onSeqAssigned =
      [this, id, slots, cancelGroup](
          size_t, uint32_t seqId, uint64_t admissionId) {
        {
          std::lock_guard<std::mutex> seqsLock(slots->mtx);
          if (slots->cancelled) {
            return true;
          }
          slots->seqs[seqId] = admissionId;
        }
        // Re-arming per admission is idempotent — the action reads the live
        // set. A true return means a cancel parked before the group had any
        // slot: mark the group so later admissions die too, and let the
        // scheduler kill this one before it decodes.
        if (liveJobs_.bind(id, cancelGroup)) {
          std::lock_guard<std::mutex> seqsLock(slots->mtx);
          slots->cancelled = true;
          slots->seqs.erase(seqId);
          return true;
        }
        return false;
      };
  const SeqObserver onSeqDone = [slots](size_t, uint32_t seqId) {
    std::lock_guard<std::mutex> seqsLock(slots->mtx);
    slots->seqs.erase(seqId);
  };

  batching::BatchResult result =
      processPromptBatchImpl(prompts, onSeqAssigned, onSeqDone, groupTag);
  // Leave the group's complete terminal snapshot behind for the tagged
  // jobEnded event: model-level figures from the run's own stats snapshot,
  // TTFT/TPS averaged over the group's requests that produced them, token
  // counts summed (see aggregateObservedStats).
  if (!result.requestStats.empty()) {
    qvac_lib_inference_addon_cpp::RuntimeStats terminal = jobTerminalStats(
        result.stats, batching::aggregateObservedStats(result.requestStats));
    std::lock_guard<std::mutex> statsLock(jobStatsMtx_);
    jobStats_[id] = std::move(terminal);
  }
  return std::move(result.outputs);
}

std::string LlamaModel::processConcurrent(
    const Prompt& prompt, qvac_lib_inference_addon_cpp::JobId id) {
  // Tagged like the batch path, so a cancel arriving while this request is
  // still queued behind a wider group settles it now instead of waiting for
  // that group to release a slot.
  const auto groupTag = static_cast<uint64_t>(id);
  // The job's slot identity, shared with its ONE cancel action — the same
  // shape the batch path uses (GroupSlots), for the same reason: the action is
  // installed once and re-reads live state, so ordering against admission
  // cannot matter. Replacing the action at admission instead (the previous
  // design) lost exactly that race: JobCancelRegistry::cancel copies the
  // action out and runs it outside the registry lock, so a copy of the
  // queued-only action could run after admission had already made
  // cancelGroupQueued a no-op (admittedCount == totalCount) — the freshly
  // bound slot action was never invoked, the cancel evaporated, and the
  // caller's promise waited out the whole generation.
  struct SlotIdentity {
    std::mutex mtx;
    std::optional<std::pair<uint32_t, uint64_t>> admission;
    bool cancelled = false;
  };
  auto slot = std::make_shared<SlotIdentity>();

  // The cancel action: tear down the slot when one is held (the scheduler
  // validates the admission id, so a stale pair can never hit the seqId's
  // next occupant), and settle the request through cancelGroupQueued while it
  // is still queued (a no-op once admitted). Whichever side of admission the
  // cancel lands on, exactly one mechanism acts. Runs under the canceller's
  // shared stateMtx_ (see cancelById), so state_ stays valid; slot->mtx is
  // released before touching the scheduler, so it never holds both locks.
  const auto cancelSingle = [this, slot, groupTag] {
    std::optional<std::pair<uint32_t, uint64_t>> admission;
    {
      std::lock_guard<std::mutex> slotLock(slot->mtx);
      slot->cancelled = true;
      admission = slot->admission;
    }
    if (state_ && state_->batchScheduler_) {
      if (admission.has_value()) {
        state_->batchScheduler_->cancel(admission->first, admission->second);
      }
      state_->batchScheduler_->cancelGroupQueued(groupTag);
    }
  };
  // Armed BEFORE submission, for the same reason the batch path is: until
  // admission there is no slot to cancel, and a parked cancel would otherwise
  // only be consumed once a slot frees. Arming here also surfaces a cancel
  // parked between the scheduler dequeue and this call (jobStarting ->
  // parkAll), refused as Cancelled — the same structured terminal the batch
  // path gives it, so consumers never string-match a message.
  if (liveJobs_.add(id, cancelSingle)) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_lib_inference_addon_llama::errors::toString(
            qvac_lib_inference_addon_llama::errors::Cancelled),
        "LlamaModel: request cancelled before it could run (cancelled between "
        "the scheduler dequeue and admission)");
  }
  ScopeGuard mapGuard([this, id] { liveJobs_.remove(id); });

  const SeqAssignedObserver onSeqAssigned =
      [this, id, slot, cancelSingle](
          size_t, uint32_t seqId, uint64_t admissionId) {
        {
          std::lock_guard<std::mutex> slotLock(slot->mtx);
          if (slot->cancelled) {
            return true;
          }
          slot->admission = {seqId, admissionId};
        }
        // Idempotent re-arm of the SAME action, exactly like the batch path:
        // a true return means a whole-model cancel parked between add() and
        // this admission — mark the job cancelled and let the scheduler kill
        // the slot before it decodes.
        if (liveJobs_.bind(id, cancelSingle)) {
          std::lock_guard<std::mutex> slotLock(slot->mtx);
          slot->cancelled = true;
          slot->admission.reset();
          return true;
        }
        return false;
      };
  // Drop the job the moment the slot ends. The scheduler frees the seqId
  // here and may hand it to a peer job before this call returns and mapGuard
  // runs; removing now stops the stale action from making cancelById target
  // that peer's slot.
  const SeqObserver onSeqDone = [this, id](size_t, uint32_t) {
    liveJobs_.remove(id);
  };

  const std::vector<Prompt> singleBatch{prompt};
  batching::BatchResult result =
      processPromptBatchImpl(singleBatch, onSeqAssigned, onSeqDone, groupTag);
  // Leave the job's complete terminal snapshot behind for the tagged
  // jobEnded event (consumeJobStats), queued right after this returns. A
  // throwing job never gets a jobEnded, so nothing is stored on that path.
  if (!result.requestStats.empty()) {
    qvac_lib_inference_addon_cpp::RuntimeStats terminal =
        jobTerminalStats(result.stats, result.requestStats.front());
    std::lock_guard<std::mutex> statsLock(jobStatsMtx_);
    jobStats_[id] = std::move(terminal);
  }
  return result.outputs.empty() ? std::string{}
                                : std::move(result.outputs.front());
}

qvac_lib_inference_addon_cpp::RuntimeStats LlamaModel::jobTerminalStats(
    const batching::RuntimeStatsSnapshot& stats,
    const batching::ObservedRequestStats& observed) const {
  // batchRuntimeStatsLocked's key set with the job's own observed figures in
  // place of the aggregate values. Composed purely from the run's returned
  // snapshot — no live scheduler read, no llama_perf_context_reset: a peer
  // job may be mid-decode on the shared context, and the reset belongs only
  // to the explicitly requested whole-model runtimeStats().
  qvac_lib_inference_addon_cpp::RuntimeStats terminal = {
      {"TTFT", observed.ttftMs},
      {"TPS", observed.genTps},
      {"ppTPS", stats.prefillTokensPerSecond()},
      {"CacheTokens", stats.cacheTokens},
      {"generatedTokens", observed.generatedTokens},
      {"promptTokens", observed.promptTokens},
      {"thinkingBlockDiscards", stats.thinkingBlockDiscards},
      // visionEncodeMs/Tiles intentionally omitted, matching
      // batchRuntimeStatsLocked: concurrent prompts share the one
      // per-context accumulator, so a per-job value would be misattributed.
      {"avgConcurrentSeq", stats.avgConcurrentSeq()},
      {"backendDevice", runtimeBackendDevice_}};
  // Unlike the vision counters, the stop reason IS per-sequence, so a job can
  // report its own without misattribution — a single concurrent prompt would
  // otherwise silently lose the stat the sequential path emits. Present only
  // when it is honest: absent for a group whose requests disagree (see
  // aggregateObservedStats), which addon.js tolerates by mapping only a
  // numeric value.
  if (observed.stopReason.has_value()) {
    terminal.emplace_back(
        "stopReason", static_cast<int64_t>(*observed.stopReason));
  }
  return terminal;
}

qvac_lib_inference_addon_cpp::RuntimeStats LlamaModel::consumeJobStats(
    const qvac_lib_inference_addon_cpp::JobId id) const {
  // Pure take of the snapshot built when the job finished (see
  // jobTerminalStats): the jobEnded path must not touch live model state.
  std::lock_guard<std::mutex> statsLock(jobStatsMtx_);
  const auto found = jobStats_.find(id);
  if (found == jobStats_.end()) {
    return {};
  }
  qvac_lib_inference_addon_cpp::RuntimeStats stats = std::move(found->second);
  jobStats_.erase(found);
  return stats;
}

void LlamaModel::cancelById(qvac_lib_inference_addon_cpp::JobId id) const {
  // The shared lock keeps state_ alive for whatever cancel action runs —
  // each job registered the action that stops its own engine.
  std::shared_lock lock(stateMtx_);
  if (!state_) {
    return;
  }
  liveJobs_.cancel(id);
}

LlamaModel::ResolvedPrompt
LlamaModel::resolveChatAndTools(const Prompt& prompt) {
  ResolvedPrompt resolved;
  // Load all prompt media (hoisted byte buffers and inline paths) in
  // prompt-marker order so each bitmap binds to its own MTMD marker.
  auto loadPlannedMedia = [this, &prompt](const ParsedPromptPayload& parsed) {
    if (state_->isTextLlm_ && !parsed.mediaPlan.empty()) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(MediaNotSupported),
          "Media not supported by text-only models");
    }
    validateByteBufferCount(parsed.mediaPlan, prompt.media.size());
    for (const auto& step : computeMediaLoadOrder(parsed.mediaPlan)) {
      if (step.source == MediaSource::ByteBuffer) {
        loadMedia(prompt.media[step.byteIndex]);
      } else {
        state_->llmContext_->loadMedia(step.path);
      }
    }
  };
  if (state_->cacheManager_.has_value()) {
    ParsedPromptPayload parsedPrompt;
    resolved.isCacheLoaded = state_->cacheManager_->handleCache(
        parsedPrompt,
        prompt.input,
        [this](const std::string& inputPrompt) {
          return this->formatPrompt(inputPrompt);
        },
        prompt.cacheKey);
    loadPlannedMedia(parsedPrompt);
    resolved.chatMsgs = std::move(parsedPrompt.chatMsgs);
    resolved.tools = std::move(parsedPrompt.tools);
    resolved.shouldResetAfterInference =
        state_->cacheManager_->isCacheDisabled() ||
        !state_->cacheManager_->wasCacheUsedInLastPrompt();
  } else {
    ParsedPromptPayload parsedPrompt = formatPrompt(prompt.input);
    loadPlannedMedia(parsedPrompt);
    resolved.chatMsgs = std::move(parsedPrompt.chatMsgs);
    resolved.tools = std::move(parsedPrompt.tools);
    resolved.shouldResetAfterInference = true;
  }
  return resolved;
}

std::string LlamaModel::processPrompt(const Prompt& prompt) {
  std::shared_lock lock(stateMtx_);
  return processPromptImpl(prompt);
}

std::string LlamaModel::processPromptImpl(const Prompt& prompt) {
  activeSingleJobs_.fetch_add(1);
  ScopeGuard jobGuard([this] { activeSingleJobs_.fetch_sub(1); });
  state_->lastRun_.store(
      ReloadableState::LastRunInfo{.wasPrefill = prompt.prefill},
      std::memory_order_relaxed);
  if (state_->batchScheduler_) {
    state_->batchScheduler_->resetRuntimeStats();
  }

  // Reset per-inference counters so they don't leak across runs.
  state_->llmContext_->resetThinkingBlockDiscards();
  state_->llmContext_->resetVisionEncodeMs();

  // Prompt media (both hoisted byte buffers and inline paths) is loaded by
  // resolveChatAndTools in prompt-marker order; see computeMediaLoadOrder.
  std::string out;
  ResolvedPrompt resolved = resolveChatAndTools(prompt);

  if (resolved.shouldResetAfterInference &&
      state_->llmContext_->getNPast() > 0) {
    resetState(true);
  }

  auto resetAndInvalidateActiveCache = [this]() {
    resetState(false);
    if (state_->cacheManager_.has_value()) {
      state_->cacheManager_->invalidate();
    }
  };

  bool shouldSaveCache = false;
  bool shouldResetAfterInference = false;

  if (resolved.chatMsgs.empty() && resolved.tools.empty()) {
    QLOG_IF(Priority::INFO, "No messages to process - returning early\n");
    return out;
  }

  auto restore =
      state_->llmContext_->applyGenerationParams(prompt.generationParams);

  try {
    ScopeGuard paramsGuard([&] { restore(); });

    const LlmContext::EvalMessageResult evalResult =
        resolved.tools.empty()
            ? state_->llmContext_->evalMessage(
                  resolved.chatMsgs, resolved.isCacheLoaded, prompt.prefill)
            : state_->llmContext_->evalMessageWithTools(
                  resolved.chatMsgs,
                  resolved.tools,
                  resolved.isCacheLoaded,
                  prompt.prefill);

    if (!evalResult.ok) {
      QLOG_IF(
          Priority::DEBUG,
          "Inference was interrupted during prompt evaluation\n");
      if (!evalResult.rollbackOk) {
        resetAndInvalidateActiveCache();
      }
      return out;
    }

    if (prompt.prefill) {
      // On prefill, no logits are accessed so llama.cpp's synchronize() is
      // never triggered. Force it here so t_p_eval_ms is committed to the perf
      // context before the caller reads runtimeStats().
      llama_synchronize(state_->llmContext_->getCtx());
      shouldSaveCache = true;
    } else {
      std::ostringstream oss;
      auto callback = prompt.outputCallback;
      if (!prompt.outputCallback) {
        callback = [&](const std::string& token) { oss << token; };
      }

      const LlmContext::GenerateResponseResult generationResult =
          state_->llmContext_->generateResponse(callback);
      if (!generationResult.ok) {
        resetState();
        std::string errorMsg =
            string_format("%s: context overflow\n", __func__);
        throw qvac_errors::StatusError(
            ADDON_ID, toString(ContextOverflow), errorMsg);
      }

      if (!prompt.outputCallback) {
        out = oss.str();
      }

      if (generationResult.rollbackOk) {
        shouldSaveCache = true;
        shouldResetAfterInference = resolved.shouldResetAfterInference;
      } else {
        // The driver could not prove the live recurrent state was rolled back
        // to the pre-request cursor. Skipping this prompt's save protects the
        // file immediately, but the active cache session must also be dropped:
        // otherwise a later same-key prompt could reuse dirty live state, or a
        // cache-key transition could save that dirty state under the old key.
        resetAndInvalidateActiveCache();
      }
    }
  } catch (...) {
    // Once `handleCache()` has activated or loaded a cache session, any thrown
    // eval / generation failure must leave no active session behind. In
    // particular, strict `remove_thinking_from_context` compaction failures
    // throw after local rollback/wipe; keeping the old cacheKey active would
    // let a later prompt reuse or auto-save that recovery state over the last
    // known-good on-disk cache. Do not catch policy-validation failures before
    // admission; explicit save failures below have their own cleanup gate.
    resetAndInvalidateActiveCache();
    throw;
  }

  if (shouldSaveCache) {
    try {
      maybeSaveCacheToDisk(prompt.saveCacheToDisk, state_->cacheManager_);
    } catch (...) {
      // The request completed, but the active cache key could not be flushed.
      // Drop both live state and the active cache session so the next prompt
      // does not retry the same failing path or keep using an unsaved session.
      resetAndInvalidateActiveCache();
      throw;
    }
  }

  if (shouldResetAfterInference) {
    resetState(false);
  }
  return out;
}

std::vector<std::string>
LlamaModel::processPromptBatch(const std::vector<Prompt>& prompts) {
  std::shared_lock lock(stateMtx_);
  return processPromptBatchImpl(prompts).outputs;
}

bool LlamaModel::supportsBatching() const {
  std::shared_lock lock(stateMtx_);
  return state_ && isMultiBatchActivated(*state_);
}

unsigned LlamaModel::activeSlots() const {
  std::shared_lock lock(stateMtx_);
  if (!state_ || !state_->batchScheduler_) {
    return 0;
  }
  return state_->batchScheduler_->occupancy();
}

batching::BatchResult LlamaModel::processPromptBatchImpl(
    const std::vector<Prompt>& prompts,
    const SeqAssignedObserver& onSeqAssigned, const SeqObserver& onSeqDone,
    const uint64_t groupTag) {
  // `onSeqAssigned` (optional) fires once per request when the scheduler
  // assigns its seqId. Serialize the entry section (prior-count check, cache
  // invalidation, KV wipe) under batchEntryMutex_: without it a second caller
  // can see activeBatchJobs_ == 0 before the first increments it, skip the
  // wipe, and reach scheduler.processBatch() while the first is still clearing
  // KV — wiping the second caller's sequences. The lock is released before
  // processBatch() so concurrent batch calls still overlap; jobGuard outlives
  // it so its decrement spans the whole job.
  std::optional<batching::BatchEntryGuard> jobGuard;
  {
    std::lock_guard<std::mutex> entryLock(state_->batchEntryMutex_);
    jobGuard.emplace(
        activeBatchJobs_, [this] { validateBitnetQuantization(); });
    const unsigned priorBatchJobs = jobGuard->prior();
    state_->lastRun_.store(
        ReloadableState::LastRunInfo{.wasBatch = true},
        std::memory_order_relaxed);

    // Invalidate single-prompt cache state and clear any stale KV left by
    // single-prompt runs so the batch scheduler starts on clean KV. Only the
    // first batch job entering does this: while another batch job is already in
    // flight the scheduler owns the live KV slots, and an unconditional wipe
    // here would clear that active job's sequences before its own admission.
    if (priorBatchJobs == 0) {
      if (state_->cacheManager_.has_value()) {
        state_->cacheManager_->invalidate();
      }
      if (llama_context* lctx = getContext(); lctx != nullptr) {
        if (llama_memory_t mem = llama_get_memory(lctx); mem != nullptr) {
          const int nSeqMax = llama_n_seq_max(lctx);
          for (int seqId = 0; seqId < nSeqMax; seqId++) {
            llama_memory_seq_rm(mem, static_cast<llama_seq_id>(seqId), -1, -1);
          }
        }
        // Clear stale llama perf counters (single-prompt leftovers or a
        // previous batch epoch) here, at the only point that is exclusive
        // with respect to the scheduler: no batch job is in flight, so the
        // worker is idle — the same reasoning that makes the KV wipe above
        // safe. batchRuntimeStatsLocked() deliberately never resets them:
        // it runs under a shared stateMtx_ while peers may be mid-decode.
        llama_perf_context_reset(lctx);
      }
    }
  }

  if (prompts.empty()) {
    return {};
  }

  if (!state_->batchScheduler_) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(qvac_errors::general_error::InvalidArgument),
        "Model is not configured for continuous batching: requires "
        "n_seq_max > 1");
  }
  auto& scheduler = *state_->batchScheduler_;

  std::vector<batching::SubmitRequest> requests;
  requests.reserve(prompts.size());
  // This call's cacheKey reservations, released when the run returns (any
  // path). Reserving in the shared inflightSaveKeys_ set refuses both a
  // duplicate inside this batch and a concurrent caller saving the same key —
  // either would race two writers on one file.
  std::unordered_set<std::string> saveCacheKeys;
  ScopeGuard keysGuard([this, &saveCacheKeys] {
    if (saveCacheKeys.empty()) {
      return;
    }
    std::lock_guard<std::mutex> keysLock(inflightSaveKeysMtx_);
    for (const auto& key : saveCacheKeys) {
      inflightSaveKeys_.erase(key);
    }
  });
  for (size_t i = 0; i < prompts.size(); i++) {
    const Prompt& prompt = prompts[i];
    if (prompt.saveCacheToDisk && !prompt.cacheKey.empty()) {
      std::lock_guard<std::mutex> keysLock(inflightSaveKeysMtx_);
      if (!inflightSaveKeys_.insert(prompt.cacheKey).second) {
        throw qvac_errors::StatusError(
            ADDON_ID,
            toString(qvac_errors::general_error::InvalidArgument),
            "processPromptBatch: cacheKey '" + prompt.cacheKey +
                "' is already being saved by an in-flight request; "
                "concurrent saves would overwrite each other — use a "
                "distinct key per save");
      }
      saveCacheKeys.insert(prompt.cacheKey);
    }
    if (!prompt.media.empty() && state_->isTextLlm_) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(qvac_errors::general_error::InvalidArgument),
          "processPromptBatch: media requires a multimodal model");
    }
    if (prompt.finetuningParams.has_value()) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(qvac_errors::general_error::InvalidArgument),
          "processPromptBatch: finetuning is not a batch processing operation");
    }
    // Same live-only prefill policy as the single-prompt path: batch items
    // always run in scheduler lanes, and a lane wipes its warmed KV at
    // teardown, so a prefill without persistence produces nothing reachable.
    if (!isConcurrentEligible(prompt)) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(qvac_errors::general_error::InvalidArgument),
          "processPromptBatch: prefill without saveCacheToDisk and a "
          "cacheKey cannot run on a parallel model: its warmed context is "
          "unreachable by concurrent jobs; persist the cache or load with "
          "parallel=1");
    }
    ParsedPromptPayload parsed = formatPrompt(prompt.input);
    if (parsed.chatMsgs.empty()) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(EmptyPrompt),
          "processPromptBatch: prompt produced no chat messages");
    }
    if (!parsed.mediaPaths.empty() && state_->isTextLlm_) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(qvac_errors::general_error::InvalidArgument),
          "processPromptBatch: media requires a multimodal model");
    }
    batching::SubmitRequest sr;
    sr.chatMsgs = std::move(parsed.chatMsgs);
    sr.tools = std::move(parsed.tools);
    sr.media = prompt.media;
    sr.mediaPlan = std::move(parsed.mediaPlan);
    sr.prefill = prompt.prefill;
    sr.cacheKey = prompt.cacheKey;
    sr.saveCacheToDisk = prompt.saveCacheToDisk;
    sr.overrides = prompt.generationParams;
    // `seen` fires the seq observer exactly once per slot: at admission
    // (onAdmitted), with onToken/onDone as a fallback latch. Only the
    // admission carries the slot's real ownership token; the fallback
    // latches pass the never-matching sentinel, so a cancel action armed
    // through them could never target a slot — acceptable because the
    // scheduler always fires onAdmitted first and the latches only close a
    // theoretical gap.
    auto seen = std::make_shared<std::atomic<bool>>(false);
    auto notifySeq = [onSeqAssigned, seen, requestIndex = i](
                         uint32_t seqId, uint64_t admissionId) {
      if (onSeqAssigned && !seen->exchange(true)) {
        return onSeqAssigned(requestIndex, seqId, admissionId);
      }
      return false;
    };
    sr.streams.onAdmitted = notifySeq;
    sr.streams.onToken = [userCb = prompt.outputCallback,
                          notifySeq](uint32_t seqId, const std::string& piece) {
      notifySeq(seqId, batching::K_UNKNOWN_ADMISSION_ID);
      if (userCb) {
        userCb(piece);
      }
    };
    sr.streams.onDone =
        [notifySeq, onSeqDone, requestIndex = i](uint32_t seqId) {
          notifySeq(seqId, batching::K_UNKNOWN_ADMISSION_ID);
          if (onSeqDone) {
            onSeqDone(requestIndex, seqId);
          }
        };

    requests.push_back(std::move(sr));
  }

  return scheduler.processBatch(std::move(requests), groupTag);
}

qvac_lib_inference_addon_cpp::RuntimeStats LlamaModel::runtimeStats() const {
  std::shared_lock lock(stateMtx_);
  const auto lastRun = state_->lastRun_.load(std::memory_order_relaxed);
  if (lastRun.wasBatch && state_->batchScheduler_) {
    return batchRuntimeStatsLocked();
  }
  return singleRuntimeStatsLocked();
}

qvac_lib_inference_addon_cpp::RuntimeStats
LlamaModel::batchRuntimeStatsLocked() const {
  // Pull the live snapshot from the scheduler. It already aggregates
  // across every `processBatch` caller in the current idle epoch
  // (`stats_.reset()` only fires when the queue is both empty and has no
  // in-flight work), so this composes correctly with multiple queued /
  // in-flight batches without LlamaModel having to cache state.
  const batching::RuntimeStatsSnapshot stats =
      state_->batchScheduler_->runtimeStats();
  // TTFT comes from the scheduler's prefill-step timer rather than
  // `llama_perf_context().t_p_eval_ms`, which would include the
  // replay decode run by `compactThinkSpan` in
  // `onGenerationFinished`. No `llama_perf_context_reset` here: this
  // runs under a shared stateMtx_ concurrently with in-flight batch
  // jobs, and the scheduler releases its own mutex around llama_decode,
  // so writing the context's non-atomic perf counters from this path
  // races a mid-decode peer. The counters are cleared instead at the
  // batch-entry epoch boundary (processPromptBatchImpl), which is
  // exclusive with respect to the scheduler.
  return {
      {"TTFT", stats.prefillTimeMs()},
      {"TPS", stats.decodeTokensPerSecond()},
      {"ppTPS", stats.prefillTokensPerSecond()},
      {"CacheTokens", stats.cacheTokens},
      {"generatedTokens", stats.generatedTokens},
      {"promptTokens", stats.promptTokens},
      {"thinkingBlockDiscards", stats.thinkingBlockDiscards},
      // visionEncodeMs/Tiles intentionally omitted in batch mode: multiple
      // prompts share the one per-context accumulator (reset per prompt), so a
      // per-batch value would be misattributed / racy. See singleRuntimeStats.
      {"avgConcurrentSeq", stats.avgConcurrentSeq()},
      {"backendDevice", runtimeBackendDevice_}};
}

qvac_lib_inference_addon_cpp::RuntimeStats
LlamaModel::singleRuntimeStatsLocked() const {
  // Compaction replays the kept tokens through `llama_decode` after
  // generation ends. Those are batch decodes, so they land in `n_p_eval` /
  // `t_p_eval_ms` and would otherwise show up as prompt tokens the caller
  // never sent. The snapshot taken at the start of `compactThinkSpan` is the
  // user-visible cutoff for those prompt-side counters.
  //
  // The generation-side counters are read live instead: the snapshot is taken
  // before the request is fully wound down, so it can miss the final decode.
  // `generatedTokens` is counted at the commit site so it is unaffected, but
  // `t_eval_ms` is not exact here. A replay of exactly one token (forced-open
  // template that ended right after `</think>`) decodes with
  // `n_queued_tokens == 1` and so lands in `t_eval_ms`, understating TPS for
  // that request. Reading the snapshot instead would drop the final decode
  // from every request, which is the wider error of the two.
  auto perfData = llama_perf_context(state_->llmContext_->getCtx());
  if (auto snapshot = state_->llmContext_->takeUserVisiblePerfSnapshot()) {
    perfData.n_p_eval = snapshot->n_p_eval;
    perfData.t_p_eval_ms = snapshot->t_p_eval_ms;
  }
  constexpr double kMillisInSecond = 1000.0;
  const bool wasPrefill =
      state_->lastRun_.load(std::memory_order_relaxed).wasPrefill;
  const double timeToFirstToken = wasPrefill ? 0.0 : perfData.t_p_eval_ms;
  // Counted where the tokens are produced, not inferred from `n_eval`.
  // See `LlmContext::lastGeneratedTokenCount`.
  const int64_t generatedTokens =
      wasPrefill ? 0
                 : static_cast<int64_t>(
                       state_->llmContext_->lastGeneratedTokenCount());
  const int64_t promptTokens =
      static_cast<int64_t>(wasPrefill ? 0 : perfData.n_p_eval);
  const double tokensPerSecond = (!wasPrefill && perfData.t_eval_ms > 0)
                                     ? kMillisInSecond / perfData.t_eval_ms *
                                           static_cast<double>(generatedTokens)
                                     : 0.0;
  const double promptProcessingTPS =
      perfData.t_p_eval_ms > 0
          ? kMillisInSecond / perfData.t_p_eval_ms * perfData.n_p_eval
          : 0.0;
  llama_perf_context_reset(state_->llmContext_->getCtx());
  return {
      {"TTFT", timeToFirstToken},
      {"TPS", tokensPerSecond},
      {"ppTPS", promptProcessingTPS},
      {"CacheTokens",
       static_cast<int64_t>(state_->llmContext_->getCacheTokens())},
      {"generatedTokens", generatedTokens},
      {"promptTokens", promptTokens},
      {"thinkingBlockDiscards",
       static_cast<int64_t>(state_->llmContext_->getThinkingBlockDiscards())},
      // Why the generation stopped, as the numeric GenerationStopReason
      // value; addon.js maps it to a string (same pattern as
      // backendDevice). Prefill-only requests report None rather than
      // echoing the previous generation's reason. Single-sequence
      // semantics — intentionally NOT emitted from
      // batchRuntimeStatsLocked, where one reason cannot describe
      // multiple aggregated requests.
      {"stopReason",
       static_cast<int64_t>(
           wasPrefill ? GenerationStopReason::None
                      : state_->llmContext_->getGenerationStopReason())},
      // Vision-encode time + slice count for the most recent inference.
      // Single-sequence semantics: the context accumulator resets per prompt,
      // so these are only meaningful on this single-prompt path — intentionally
      // NOT emitted from batchRuntimeStatsLocked (multiple prompts share one
      // context, so a per-batch value would be misattributed).
      {"visionEncodeMs", state_->llmContext_->getVisionEncodeMs()},
      {"visionEncodeTiles",
       static_cast<int64_t>(state_->llmContext_->getVisionEncodeTiles())},
      {"avgConcurrentSeq", 1.0},
      {"backendDevice", runtimeBackendDevice_}};
}

// NOLINTNEXTLINE(readability-convert-member-functions-to-static,readability-function-cognitive-complexity)
ParsedPromptPayload LlamaModel::formatPrompt(const std::string& input) {
  if (input.empty()) {
    state_->llmContext_->resetMedia();
    std::string errorMsg = string_format("%s: empty prompt\n", __func__);
    throw qvac_errors::StatusError(ADDON_ID, toString(EmptyPrompt), errorMsg);
  }
  ParsedPromptPayload parsed;
  std::vector<common_chat_msg>& chatMsgs = parsed.chatMsgs;
  std::vector<common_chat_tool>& tools = parsed.tools;

  picojson::value chatJson;
  std::string err = picojson::parse(chatJson, input);

  if (err.empty() && chatJson.is<picojson::array>()) {
    auto& obj = chatJson.get<picojson::array>();

    int addMediaPlaceholder = 0;
    bool isNextUser = false;
    for (size_t i = 0; i < obj.size(); ++i) {
      const auto& subObj = obj[i];
      if (subObj.is<picojson::object>()) {
        picojson::object jsonObj = subObj.get<picojson::object>();

        if (jsonObj.find("type") != jsonObj.end() &&
            jsonObj["type"].get<std::string>() == "function") {
          common_chat_tool tool;
          tool.name = jsonObj["name"].get<std::string>();
          if (jsonObj.find("description") != jsonObj.end()) {
            tool.description = jsonObj["description"].get<std::string>();
          }
          if (jsonObj.find("parameters") != jsonObj.end()) {
            tool.parameters = jsonObj["parameters"].serialize();
          }
          tools.push_back(tool);
          continue;
        }

        common_chat_msg newMsg;
        if (jsonObj.find("role") == jsonObj.end()) {
          const char* errorMsg = "role is required in the input\n";
          throw qvac_errors::StatusError(
              ADDON_ID, toString(NoRoleProvided), errorMsg);
        }
        newMsg.role = jsonObj["role"].get<std::string>();

        if (jsonObj.find("content") == jsonObj.end()) {
          const char* errorMsg = "content is required in the input\n";
          throw qvac_errors::StatusError(
              ADDON_ID, toString(NoContentProvided), errorMsg);
        }
        auto content = jsonObj["content"].get<std::string>();

        if (jsonObj.find("type") != jsonObj.end() &&
            jsonObj["type"].get<std::string>() == "media") {
          if (state_->isTextLlm_) {
            const char* errorMsg = "Media not supported by text-only models";
            throw qvac_errors::StatusError(
                ADDON_ID, toString(MediaNotSupported), errorMsg);
          }

          if (!content.empty()) {
            parsed.mediaPaths.push_back(content);
            parsed.mediaPlan.push_back({MediaSource::Path, content});
          } else {
            parsed.mediaPlan.push_back({MediaSource::ByteBuffer, ""});
          }
          addMediaPlaceholder++;
          isNextUser = true;
          continue;
        }
        if (newMsg.role == "user" && isNextUser) {
          isNextUser = false;
          while (addMediaPlaceholder > 0) {
            addMediaPlaceholder--;
            content.insert(0, mtmd_default_marker());
          }
        }
        if (newMsg.role != "user" && isNextUser) {
          state_->llmContext_->resetMedia();
          std::string errorMsg = string_format(
              "%s: Must append a user question after loading "
              "media\n",
              __func__);
          throw qvac_errors::StatusError(
              ADDON_ID, toString(UserMessageNotProvided), errorMsg);
        }
        newMsg.content = content;
        chatMsgs.push_back(newMsg);
      }
    }

    if (addMediaPlaceholder > 0) {
      state_->llmContext_->resetMedia();
      std::string errorMsg =
          string_format("%s: No request for media was made\n", __func__);
      throw qvac_errors::StatusError(
          ADDON_ID, toString(MediaRequestNotProvided), errorMsg);
    }
  }
  if (!err.empty()) {
    state_->llmContext_->resetMedia();
    std::string errorMsg =
        string_format("%s: Invalid input format: %s\n", __func__, err.c_str());
    throw qvac_errors::StatusError(
        ADDON_ID, toString(InvalidInputFormat), errorMsg);
  }
  return parsed;
}

void LlamaModel::resetState(bool resetStats) {
  state_->llmContext_->resetState(resetStats);
}

std::unique_ptr<LlmContext> LlamaModel::createContext(
    std::string&& projectionPath, common_params& params,
    common_init_result_ptr llamaInit) {
  if (!projectionPath.empty()) {
    params.mmproj.path = std::move(projectionPath);
    return std::make_unique<MtmdLlmContext>(params, std::move(llamaInit));
  }
  return std::make_unique<TextLlmContext>(params, std::move(llamaInit));
}

bool LlamaModel::loadMedia(const std::vector<uint8_t>& input) {
  if (state_->isTextLlm_) {
    QLOG_IF(Priority::ERROR, "Media not supported by text-only models");
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(MediaNotSupported),
        "Media not supported by text-only models");
  }
  state_->llmContext_->loadMedia(input);
  return true;
}

bool LlamaModel::isBitnetModel() const {
  return metadata_.hasOneBitQuantization();
}

void LlamaModel::validateBitnetQuantization() {
  llama_model* mdl = getModel();
  if (mdl == nullptr) {
    return;
  }

  char arch[64] = {0};
  int len =
      llama_model_meta_val_str(mdl, "general.architecture", arch, sizeof(arch));
  if (len <= 0 || len >= static_cast<int>(sizeof(arch))) {
    return;
  }

  std::string archStr(arch, static_cast<size_t>(len));
  if (archStr == "bitnet" && !isBitnetModel()) {
    auto fileType = metadata_.tryGetU32("general.file_type");
    throw std::runtime_error(
        "Bitnet models are only supported with TQ1_0 or TQ2_0 quantization "
        "(file_type=" +
        std::to_string(fileType.value_or(0)) + ")");
  }
}

// Finetuning implementation moved to LlamaFinetuner.{hpp,cpp}.
