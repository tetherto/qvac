#include <any>
#include <string>
#include <unordered_map>

#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>

#include "model-interface/LlamaModel.hpp"

namespace {

LlamaModel makeUnloadedModel() {
  std::unordered_map<std::string, std::string> config;
  config["device"] = "cpu";
  return LlamaModel("nonexistent_model.gguf", "", std::move(config));
}

LlamaModel::Prompt makeFinetunePrompt() {
  LlamaModel::Prompt prompt;
  qvac_lib_inference_addon_llama::LlamaFinetuningParams params;
  params.trainDatasetDir = "/tmp/train.jsonl";
  params.outputParametersDir = "/tmp/out";
  prompt.finetuningParams = params;
  return prompt;
}

} // namespace

// A cancel parked between the scheduler's dequeue announcement (jobStarting)
// and the finetune arming must abort the job before training starts:
// process() returns the same PAUSED terminal a mid-training cancel resolves
// with, instead of entering the finetuner.
TEST(FinetuneCancelActionTest, ParkedCancelAbortsBeforeTrainingStarts) {
  LlamaModel model = makeUnloadedModel();
  model.jobStarting(7);
  model.cancel(); // whole-model cancel parks on the still-unarmed entry

  const std::any output = model.process(std::any(makeFinetunePrompt()), 7);

  const auto& terminal = std::any_cast<const FinetuneTerminalResult&>(output);
  EXPECT_EQ(terminal.op, "finetune");
  EXPECT_EQ(terminal.status, "PAUSED");
}

// Without a parked cancel the tagged finetune path arms its cancel action and
// proceeds into the finetuner (stubbed with a throw in the standalone build):
// arming must not fabricate a cancellation.
TEST(FinetuneCancelActionTest, UnparkedFinetuneProceedsIntoTheFinetuner) {
  LlamaModel model = makeUnloadedModel();
  model.jobStarting(8);
  EXPECT_THROW(
      model.process(std::any(makeFinetunePrompt()), 8),
      qvac_errors::StatusError);
}
