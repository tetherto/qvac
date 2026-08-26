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

class MtmdLlmContextTestPeer {
public:
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

  static size_t forcedOpenTailTokens(const MtmdLlmContext& context) {
    return context.forcedOpenTailTokens();
  }
};
