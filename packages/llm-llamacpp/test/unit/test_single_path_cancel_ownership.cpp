// Ownership of the single-path cancel action: a targeted cancel that
// outlives its job must never stop the NEXT single-path job.
//
// The single-prompt path (parallel=1, no batch scheduler) arms a cancel
// action that stops the shared single-prompt context; stop() only sets a
// flag consumed at fixed points of the eval loop. Two escapes exist around
// job teardown:
//   - the action runs while the job's registry entry is still live but the
//     run already passed its last flag check (completion tail: compaction,
//     cache save), or
//   - JobCancelRegistry::cancel() executes its action copy outside the
//     registry lock, after the entry was removed and the next job started.
// Either way the flag lands with nobody left to consume it, and the next
// single-path run reads it at its first check — silently returning an
// empty "interrupted" result for a job nobody cancelled.
//
// The scheduler path pins ownership with an (seqId, admissionId) pair
// validated at apply time; these tests pin the equivalent contract for the
// single path.

#include <any>
#include <string>

#include <gtest/gtest.h>
#include <llama.h>

#include "model-interface/LlamaModel.hpp"
#include "test_common.hpp"
#include "test_internal_peers.hpp"

namespace {

using qvac_lib_inference_addon_cpp::JobId;

class SinglePathCancelOwnershipTest : public ::testing::Test {
protected:
  void SetUp() override {
    using MP = test_common::TestModelPath;
    config_["device"] = test_common::getTestDevice();
    config_["ctx_size"] = "1024";
    config_["gpu_layers"] = test_common::getTestGpuLayers();
    // No batch scheduler: every tagged run takes the single-prompt path.
    config_["parallel"] = "1";
    config_["n_predict"] = "32";
    config_["temp"] = "0";
    config_["backendsDir"] = test_common::getTestBackendsDir().string();

    model_ =
        MP("Llama-3.2-1B-Instruct-Q4_0.gguf",
           nullptr,
           MP::OnMissing::Skip,
           "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF");
  }

  std::unique_ptr<LlamaModel> loadModel() {
    std::string path = model_.path;
    std::string projection;
    auto cfg = config_;
    auto model = std::make_unique<LlamaModel>(
        std::move(path), std::move(projection), std::move(cfg));
    model->waitForLoadInitialization();
    return model;
  }

  static LlamaModel::Prompt makePrompt(const std::string& userText) {
    LlamaModel::Prompt prompt;
    prompt.input = R"([{"role":"user","content":")" + userText + R"("}])";
    return prompt;
  }

  std::unordered_map<std::string, std::string> config_;
  test_common::TestModelPath model_;
};

} // namespace

/// A stop flag set by an escaped cancel — job A's action executing after
/// A's last flag check — must not interrupt job B. The escape itself is a
/// sub-millisecond race (completion tail / action copy outside the registry
/// lock), so the test injects its exact observable effect deterministically:
/// a bare context stop() between the two runs, with nobody left to consume
/// it. Job B must still generate its full answer.
TEST_F(SinglePathCancelOwnershipTest, EscapedCancelStopFlagMustNotStopNextJob) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();

  std::any outA = model->process(
      std::any(makePrompt("What is two plus two? One word.")), JobId{1});
  ASSERT_FALSE(std::any_cast<std::string>(outA).empty())
      << "test setup: job A did not complete";

  // Job A's escaped cancel: pre-ownership the armed action is a counter-gated
  // llmContext_->stop(), so this is exactly what lands when the action runs
  // after A stopped checking the flag.
  LlmContext* context = LlamaModelTestPeer::llmContext(*model);
  ASSERT_NE(context, nullptr);
  context->stop();

  std::any outB = model->process(
      std::any(makePrompt("What is the capital of France? One word.")),
      JobId{2});
  EXPECT_FALSE(std::any_cast<std::string>(outB).empty())
      << "job B consumed a stale stop flag left by a cancel aimed at the "
         "previous job and returned an empty 'interrupted' result";
}

/// Public-API flavour of the same contract: a targeted cancel arriving after
/// its job fully finished (its registry entry already removed) is a no-op
/// and must leave nothing behind for the next run.
TEST_F(
    SinglePathCancelOwnershipTest, LateCancelByIdForFinishedJobIsNoOpForNext) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();

  std::any outA = model->process(
      std::any(makePrompt("What is two plus two? One word.")), JobId{1});
  ASSERT_FALSE(std::any_cast<std::string>(outA).empty())
      << "test setup: job A did not complete";

  model->cancelById(JobId{1});

  std::any outB = model->process(
      std::any(makePrompt("What is the capital of France? One word.")),
      JobId{2});
  EXPECT_FALSE(std::any_cast<std::string>(outB).empty())
      << "a cancel for an already-finished job leaked into the next run";
}
