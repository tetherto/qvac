#include <any>
#include <memory>
#include <string>
#include <unordered_map>

#include <gtest/gtest.h>

#include "model-interface/LlamaFinetuner.hpp"
#include "model-interface/LlamaModel.hpp"
#include "test_internal_peers.hpp"

namespace {

LlamaModel makeUnloadedModel() {
  std::unordered_map<std::string, std::string> config;
  config["device"] = "cpu";
  return LlamaModel("nonexistent_model.gguf", "", std::move(config));
}

} // namespace

// A cancel that lands after the finetune cancel action is armed but before
// finetune() publishes the checkpoint state (the setup stretch: model reload,
// dataset tokenization, adapter and optimizer setup) must not evaporate. The
// cancel registry runs the armed action one-shot and considers the request
// delivered, so requestPause() must record it durably: the publication that
// ends setup has to hand it to the state's pauseRequested flag, which is the
// only signal the training loop checks. Losing it means the "cancelled" job
// silently trains to completion.
TEST(FinetunePendingPauseTest, PauseBeforeCheckpointStatePublicationIsNotLost) {
  LlamaModel model = makeUnloadedModel();
  LlamaFinetuner& finetuner = model.finetuner();

  // Setup window: no checkpoint state published yet. This is the armed cancel
  // action (requestFinetuneCancel) firing mid-setup; it reports the request
  // delivered because the registry will never replay it.
  EXPECT_TRUE(finetuner.requestPause(/*savePauseCheckpoint=*/false))
      << "a pause requested during finetune setup must be accepted, not "
         "dropped";

  // Publication ends the setup window, exactly like finetune() installing the
  // state after optimizer configuration.
  auto state =
      std::make_shared<llama_finetuning_helpers::TrainingCheckpointState>();
  LlamaFinetunerTestPeer::publishCheckpointState(finetuner, state);

  EXPECT_TRUE(state->pauseRequested.load())
      << "pause requested during setup was lost at checkpoint-state "
         "publication";
  EXPECT_FALSE(state->savePauseCheckpoint.load())
      << "the latched request must carry its savePauseCheckpoint=false";

  // The latched request is consumed by exactly one publication: a later
  // finetune's state must start clean.
  auto laterState =
      std::make_shared<llama_finetuning_helpers::TrainingCheckpointState>();
  LlamaFinetunerTestPeer::publishCheckpointState(finetuner, laterState);
  EXPECT_FALSE(laterState->pauseRequested.load())
      << "a consumed pending pause must not bleed into a later finetune";
}

// A cancel that aborts a tagged finetune before it ever enters finetune()
// (whole-model cancel parked between the scheduler dequeue and bind()) leaves
// its latched pause behind: every discard of the latch lives inside
// finetune(), which the early PAUSED return never reaches. The next finetune
// inherits it at publication and pauses although nobody cancelled it.
TEST(
    FinetunePendingPauseTest,
    PreBindParkedCancelMustNotLeakPauseIntoNextFinetune) {
  LlamaModel model = makeUnloadedModel();
  LlamaFinetuner& finetuner = model.finetuner();
  constexpr qvac_lib_inference_addon_cpp::JobId jobA = 41;

  // Scheduler dequeue announcement: registry entry exists, unarmed.
  model.jobStarting(jobA);
  // Whole-model cancel while A sits between dequeue and its engine slot:
  // parks on the unarmed entry ...
  model.cancel();
  // ... and latches the pause in the finetuner (in production the armed
  // requestFinetuneCancel forwards it inside A's open cancellation window;
  // the standalone build compiles that forward out, so latch it directly).
  EXPECT_TRUE(finetuner.requestPause(/*savePauseCheckpoint=*/false));

  LlamaModel::Prompt prompt;
  prompt.finetuningParams.emplace();
  const std::any result = model.process(std::any(prompt), jobA);
  const auto& terminal = std::any_cast<const FinetuneTerminalResult&>(result);
  EXPECT_EQ(terminal.status, "PAUSED")
      << "the parked cancel must abort the finetune before training";

  // Uncancelled finetune B publishes its checkpoint state.
  auto stateB =
      std::make_shared<llama_finetuning_helpers::TrainingCheckpointState>();
  LlamaFinetunerTestPeer::publishCheckpointState(finetuner, stateB);
  EXPECT_FALSE(stateB->pauseRequested.load())
      << "a pause latched for a finetune that never trained leaked into the "
         "next finetune";
}

// Same leak when the job does enter finetune() but setup throws before the
// try whose catch discards the latch (model validation, cache saving, the
// initial reload, the null-context check). The standalone finetune stub
// throws at exactly that depth, standing in for those failures.
TEST(
    FinetunePendingPauseTest,
    SetupFailureBeforeTrainingMustDiscardPendingPause) {
  LlamaModel model = makeUnloadedModel();
  LlamaFinetuner& finetuner = model.finetuner();
  constexpr qvac_lib_inference_addon_cpp::JobId jobA = 42;

  model.jobStarting(jobA);
  // Cancel latched during A's setup window.
  EXPECT_TRUE(finetuner.requestPause(/*savePauseCheckpoint=*/false));

  LlamaModel::Prompt prompt;
  prompt.finetuningParams.emplace();
  EXPECT_ANY_THROW(model.process(std::any(prompt), jobA));

  auto stateB =
      std::make_shared<llama_finetuning_helpers::TrainingCheckpointState>();
  LlamaFinetunerTestPeer::publishCheckpointState(finetuner, stateB);
  EXPECT_FALSE(stateB->pauseRequested.load())
      << "a pause latched for a finetune whose setup failed leaked into the "
         "next finetune";
}

// The checkpoint-save mode a JS cancel(savePauseCheckpoint) arms has the same
// ownership problem: armed with no live finetune to consume it, it must not
// linger for a later unrelated finetune cancellation to inherit.
TEST(
    FinetuneCancelCheckpointModeTest, ArmingWithoutLiveFinetuneMustNotPersist) {
  LlamaModel model = makeUnloadedModel();

  model.setFinetuneCancelSavesCheckpoint(
      true, {qvac_lib_inference_addon_cpp::kNoJobId});

  EXPECT_FALSE(LlamaModelTestPeer::finetuneCancelCheckpointModeArmed(model))
      << "a checkpoint mode armed while no finetune is live has no owner and "
         "must not outlive the cancel that armed it";
}

// The armed mode is owned by the snapshotted live finetune: never armed for
// a finetune outside the canceller's snapshot, consumed by that job's own
// cancel, discarded when the job's cancellation window closes.
TEST(
    FinetuneCancelCheckpointModeTest, ModeBelongsToTheSnapshottedLiveFinetune) {
  LlamaModel model = makeUnloadedModel();
  constexpr qvac_lib_inference_addon_cpp::JobId finetuneId = 7;
  LlamaModelTestPeer::setActiveFinetuneJob(model, finetuneId);

  model.setFinetuneCancelSavesCheckpoint(true, {finetuneId + 1});
  EXPECT_FALSE(LlamaModelTestPeer::finetuneCancelCheckpointModeArmed(model))
      << "a snapshot that does not cover the live finetune must not arm it";

  model.setFinetuneCancelSavesCheckpoint(true, {finetuneId});
  EXPECT_TRUE(LlamaModelTestPeer::finetuneCancelCheckpointModeArmed(model));
  model.cancel();
  EXPECT_FALSE(LlamaModelTestPeer::finetuneCancelCheckpointModeArmed(model))
      << "the owning job's cancel must consume the mode";

  model.setFinetuneCancelSavesCheckpoint(true, {finetuneId});
  LlamaModelTestPeer::endFinetuneJob(model);
  EXPECT_FALSE(LlamaModelTestPeer::finetuneCancelCheckpointModeArmed(model))
      << "a mode nobody consumed must die with its job's window";
}

TEST(FinetunePendingPauseTest, InternalReloadDoesNotRequestFinetunePause) {
  LlamaModel model = makeUnloadedModel();
  LlamaFinetuner& finetuner = model.finetuner();
  const unsigned before = LlamaModelTestPeer::finetuneCancelRequests(model);

  LlamaModelTestPeer::reloadDelayed(model);

  EXPECT_EQ(LlamaModelTestPeer::finetuneCancelRequests(model), before)
      << "reload housekeeping must not issue a user finetune cancellation";
  auto state =
      std::make_shared<llama_finetuning_helpers::TrainingCheckpointState>();
  LlamaFinetunerTestPeer::publishCheckpointState(finetuner, state);
  EXPECT_FALSE(state->pauseRequested.load())
      << "an ordinary finetune must start without a pause from its own reload";
}
