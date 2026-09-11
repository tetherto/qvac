#pragma once

#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <shared_mutex>
#include <utility>

#include "model-interface/ContinuousBatchScheduler.hpp"
#include "model-interface/LlamaFinetuner.hpp"
#include "model-interface/LlamaModel.hpp"
#include "model-interface/MtmdLlmContext.hpp"
#include "model-interface/TextLlmContext.hpp"

// Friend test peers grant unit tests direct access to internals that are not
// part of the production public API. The production classes befriend these
// peers (and nothing else), so the test-only access lives here in test code
// instead of as `*ForTesting()` accessors on the shipped surface.
//
// A dedicated peer is used rather than befriending the GoogleTest fixtures:
// friendship is not inherited, and a TEST_F body lives in a generated class
// derived from the fixture, so a `friend class Fixture;` would not grant the
// test body access.

class LlamaModelTestPeer {
public:
  /// The internal batch scheduler. Null when batching is inactive
  /// (n_parallel < 2 or a multimodal model) or before the model has loaded.
  static qvac_lib_inference_addon_llama::batching::ContinuousBatchScheduler*
  scheduler(LlamaModel& model) {
    std::shared_lock lock(model.stateMtx_);
    return model.state_ ? model.state_->batchScheduler_.get() : nullptr;
  }

  /// The loaded single-prompt context, for driver-level accounting tests.
  /// Null before the model has loaded.
  static LlmContext* llmContext(LlamaModel& model) {
    std::shared_lock lock(model.stateMtx_);
    return model.state_ ? model.state_->llmContext_.get() : nullptr;
  }

  static std::optional<load_fit_normalization::NormalizedFitSnapshot>
  normalizedFitSnapshot(const LlamaModel& model) {
    std::shared_lock lock(model.stateMtx_);
    if (!model.state_) {
      return std::nullopt;
    }
    return model.state_->normalizedFitSnapshot_;
  }

  static void replaceNormalizedFitSnapshot(
      LlamaModel& model,
      load_fit_normalization::NormalizedFitSnapshot snapshot) {
    std::unique_lock lock(model.stateMtx_);
    if (model.state_) {
      model.state_->normalizedFitSnapshot_ = std::move(snapshot);
    }
  }

  static int64_t runtimeBackendDevice(const LlamaModel& model) {
    std::shared_lock lock(model.stateMtx_);
    return model.runtimeBackendDevice_;
  }

  static void setRuntimeBackendDevice(LlamaModel& model, int64_t device) {
    std::unique_lock lock(model.stateMtx_);
    model.runtimeBackendDevice_ = device;
  }

  /// The multi-job routing predicate (private static on the model).
  static bool isConcurrentEligible(const LlamaModel::Prompt& prompt) {
    return LlamaModel::isConcurrentEligible(prompt);
  }

  /// How many finetune cancellation requests the model has forwarded to the
  /// finetuner (requestFinetuneCancel() calls). Counted in every build, so
  /// the forwarding contract stays observable in the standalone test build,
  /// where requestFinetuneCancel's finetuner forward is compiled out.
  static unsigned finetuneCancelRequests(const LlamaModel& model) {
    return model.finetuneCancelRequests_.load();
  }

  static void reloadDelayed(LlamaModel& model) {
    model.setInitLoader(InitLoader::LOADER_TYPE::DELAYED);
  }

  static void setActiveFinetuneJob(
      LlamaModel& model, qvac_lib_inference_addon_cpp::JobId id) {
    model.beginFinetuneJob(id);
  }

  static void endFinetuneJob(LlamaModel& model) {
    model.closeFinetuneCancellationWindow();
  }

  /// Whether any checkpoint-save mode armed by
  /// setFinetuneCancelSavesCheckpoint is still waiting for a finetune cancel
  /// to consume it.
  static bool finetuneCancelCheckpointModeArmed(const LlamaModel& model) {
    std::scoped_lock lock(model.finetuneCancelMtx_);
    return !model.finetuneCancelSaveModes_.empty();
  }

  static std::shared_mutex& stateMutex(LlamaModel& model) {
    return model.stateMtx_;
  }
};

class LlamaFinetunerTestPeer {
public:
  /// Publish the training checkpoint state exactly as finetune() does at the
  /// end of its setup stretch, so tests can drive the setup-window ->
  /// publication seam without a real model reload/dataset/optimizer setup.
  static void publishCheckpointState(
      LlamaFinetuner& finetuner,
      std::shared_ptr<llama_finetuning_helpers::TrainingCheckpointState>
          state) {
    finetuner.setCurrentCheckpointStateShared(std::move(state));
  }
};

class MtmdLlmContextTestPeer {
public:
  /// Bitmaps staged for the next `mtmd_tokenize`. `tokenizeChat` drains them,
  /// so between requests this must be 0: a non-zero count means a failed
  /// request left its media behind, and the next multimodal request would
  /// hand fabric more bitmaps than its prompt has markers.
  static size_t loadedMediaCount(const MtmdLlmContext& context) {
    return context.bitmaps_.entries.size();
  }

  /// The post-reasoning-recovery EOG-ban one-shot flag. Production code only
  /// arms it from inside a reasoning recovery, which requires the model to emit
  /// EOS inside `<think>` — not forceable in a black-box test, hence direct
  /// access here.
  static bool banArmed(const MtmdLlmContext& ctx) {
    return ctx.banEogAfterReasoningRecovery_;
  }
  static void setBanArmed(MtmdLlmContext& ctx, bool armed) {
    ctx.banEogAfterReasoningRecovery_ = armed;
  }

  /// EOG token ids precomputed at load (Qwen3 reasoning family only) — the set
  /// the ban masks.
  static const std::vector<llama_token>& eogTokens(const MtmdLlmContext& ctx) {
    return ctx.eogTokens_;
  }

  /// Invoke the ban consumer directly, as `onLogitsReady` /
  /// `specSampleAndAccept` do before sampling.
  static void applyPendingEogBan(MtmdLlmContext& ctx, int logitIdx) {
    ctx.applyPendingEogBan(logitIdx);
  }

  /// The live logits row the ban writes into. Requires a prior decode;
  /// null otherwise.
  static float* logits(MtmdLlmContext& ctx, int logitIdx) {
    return llama_get_logits_ith(ctx.modelCtx_.lctx, logitIdx);
  }

  /// Produce one live logits row. Newer fabric releases discard prefill
  /// outputs after processPrompt returns, so this test seam decodes one token
  /// before exercising the EOG mask directly.
  static bool decodeTokenForLogits(MtmdLlmContext& ctx) {
    const auto tokens = common_tokenize(ctx.modelCtx_.lctx, "x", false, true);
    if (tokens.empty()) {
      return false;
    }
    LlamaBatch batch(1, 0, 1);
    common_batch_add(
        *batch.get(), tokens.front(), ctx.current_.pos, {ctx.seqId_}, true);
    return llama_decode(ctx.modelCtx_.lctx, *batch.get()) == 0;
  }

  static bool removeThinkingFromContext(const MtmdLlmContext& context) {
    return context.removeThinkingFromContext_;
  }

  static bool compactorRemovesThinking(const MtmdLlmContext& context) {
    return context.compactor_.removeThinkingFromContext();
  }

  static bool hasReasoningBoundary(const MtmdLlmContext& context) {
    return context.rollbackState_.hasReasoningBoundary();
  }

  static llama_pos reasoningBoundaryNPast(const MtmdLlmContext& context) {
    return context.rollbackState_.reasoningBoundaryNPast();
  }

  static llama_pos specCellsUsed(const MtmdLlmContext& context) {
    return context.specCellsUsed();
  }

  /// First token of `text` under the live vocab, for picking two ids known to
  /// differ without hard-coding vocab specifics into a test.
  static llama_token firstTokenOf(const MtmdLlmContext& ctx, const char* text) {
    const auto ids = common_tokenize(ctx.modelCtx_.lctx, text, false, true);
    return ids.empty() ? LLAMA_TOKEN_NULL : ids.front();
  }

  /// Drive `specRecoverReasoning` and report the sampler's last accepted
  /// token.
  ///
  /// That recovery only runs from the MTP speculative loop on a real EOS
  /// inside `<think>`, which no black-box test can force deterministically, so
  /// the accept contract is pinned here. `sentinel` is accepted first with
  /// `is_generated = false`, so "the recovery did not accept" is observable as
  /// the sentinel surviving rather than as an unspecified initial value.
  ///
  /// `reasoningBudgetSamplerBuilt` only requires both marker lists to be
  /// non-empty, so their contents do not affect what is asserted.
  static llama_token recoverReasoningAndReportLastAccepted(
      MtmdLlmContext& ctx, llama_token closeTok, llama_token sentinel,
      bool lazyGrammar) {
    common_sampler_accept(ctx.smpl_.get(), sentinel, false);
    ctx.params_.sampling.grammar_lazy = lazyGrammar;
    ctx.params_.sampling.reasoning_budget_start = {closeTok};
    ctx.params_.sampling.reasoning_budget_end = {{closeTok}};
    ctx.params_.sampling.reasoning_budget_tokens = -1;
    ctx.params_.sampling.reasoning_control = false;
    ctx.reasoningState_.inside_reasoning = true;
    ctx.reasoningState_.cached_close_tag_token = closeTok;
    LlamaBatch batch(1, 0, 1);
    ctx.specRecoverReasoning(LLAMA_TOKEN_NULL, batch, nullptr);
    return common_sampler_last(ctx.smpl_.get());
  }
};

class TextLlmContextTestPeer {
public:
  static void armPendingThinkClose(TextLlmContext& ctx) {
    ctx.compactor_.setRemoveThinkingFromContext(true);
    ctx.compactor_.setReasoningEnabled(true);
    ctx.compactor_.setNeedsRecurrentSnapshot(false);
    ctx.compactor_.snapshotAtReasoningBoundary(
        ctx.modelCtx_.lctx, ctx.seqId_, 0, "[TextLlmTest]");
    ctx.compactor_.setOpenSpan(0);
    ctx.compactor_.requestCloseCapture();
    ctx.nPast_ = 1;
  }

  static bool pendingThinkClose(const TextLlmContext& ctx) {
    return ctx.compactor_.hasPendingCloseCapture();
  }

  static bool capturedThinkClose(const TextLlmContext& ctx) {
    return ctx.compactor_.hasCapturedCloseSpanForTesting();
  }

  static llama_token ordinaryToken(const TextLlmContext& ctx) {
    const auto tokens = common_tokenize(ctx.modelCtx_.lctx, "x", false, true);
    return tokens.empty() ? LLAMA_TOKEN_NULL : tokens.front();
  }

  static void processSpecToken(TextLlmContext& ctx, llama_token token) {
    static_cast<void>(ctx.specProcessToken(token, false, 1, {}, nullptr));
  }
};

class ContinuousBatchSchedulerTestPeer {
public:
  using Scheduler =
      qvac_lib_inference_addon_llama::batching::ContinuousBatchScheduler;

  /// Override the decode function used by stepLocked(); inject a stub that
  /// returns a non-zero rc or blocks to exercise the decode path.
  static void setDecodeFunc(Scheduler& scheduler, Scheduler::DecodeFunc fn) {
    scheduler.decodeFunc_ = std::move(fn);
  }

  /// Override the media-segment eval used by serviceNextMediaSegmentLocked();
  /// inject a stub that throws to exercise the media-eval failure path.
  static void
  setEvalMediaFunc(Scheduler& scheduler, Scheduler::EvalMediaFunc fn) {
    scheduler.evalMediaFunc_ = std::move(fn);
  }

  /// The factory the scheduler calls once per admission to build a slot's
  /// driver. Fetch it, wrap it, and hand the wrapper back with
  /// `setDriverFactory` to reach a driver at the one moment a test can:
  /// after construction and before its first decode. The slot itself is not
  /// observable that early — `slots_[seqId]` is populated by `submitLocked`
  /// after the factory returns.
  static const qvac_lib_inference_addon_llama::batching::DriverFactory&
  driverFactory(Scheduler& scheduler) {
    return scheduler.driverFactory_;
  }

  static void setDriverFactory(
      Scheduler& scheduler,
      qvac_lib_inference_addon_llama::batching::DriverFactory factory) {
    scheduler.driverFactory_ = std::move(factory);
  }

  /// The admission id currently stamped on `seqId`, or nullopt when the slot
  /// is free / out of range. Takes the scheduler mutex, so it must not be
  /// called from code the worker runs while holding it (streaming callbacks);
  /// the decode unlock window and other threads are fine.
  static std::optional<uint64_t>
  admissionIdAt(Scheduler& scheduler, uint32_t seqId) {
    std::scoped_lock lock(scheduler.mutex_);
    if (seqId >= scheduler.slots_.size() ||
        !scheduler.slots_[seqId].has_value()) {
      return std::nullopt;
    }
    return scheduler.slots_[seqId]->admissionId;
  }

  /// Records a deferred slot cancel, then applies teardown once inside a
  /// `TeardownDeferGuard` window and once outside it, reporting whether the
  /// record survived each time. Drives the suspension in isolation: the
  /// finalize unlock window holds a reference into `slots_`, so a reconcile
  /// inside it would free the slot out from under the drain loop.
  static std::pair<bool, bool>
  pendingCancelSurvivesTeardown(Scheduler& scheduler) {
    scheduler.recordPendingSlotCancel(/*seqId=*/0, /*admissionId=*/1);
    bool survivedDeferred = false;
    {
      typename Scheduler::TeardownDeferGuard defer(scheduler);
      std::scoped_lock lock(scheduler.mutex_);
      scheduler.applyDeferredTeardownLocked();
    }
    survivedDeferred = scheduler.hasPendingCancels();
    {
      std::scoped_lock lock(scheduler.mutex_);
      scheduler.applyDeferredTeardownLocked();
    }
    return {survivedDeferred, scheduler.hasPendingCancels()};
  }
};
