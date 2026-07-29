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
