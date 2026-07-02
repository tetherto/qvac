#pragma once

#include <mutex>
#include <shared_mutex>
#include <utility>

#include "model-interface/ContinuousBatchScheduler.hpp"
#include "model-interface/LlamaModel.hpp"

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
