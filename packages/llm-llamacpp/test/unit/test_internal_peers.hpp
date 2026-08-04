#pragma once

#include <shared_mutex>
#include <utility>

#include "model-interface/ContinuousBatchScheduler.hpp"
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
};

class MtmdLlmContextTestPeer {
public:
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

  /// Thinking-compaction state, so the context's flag and the compactor's copy
  /// can be asserted to agree.
  static bool removeThinkingFromContext(const MtmdLlmContext& context) {
    return context.removeThinkingFromContext_;
  }

  static bool compactorRemovesThinking(const MtmdLlmContext& context) {
    return context.compactor_.removeThinkingFromContext();
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
};
