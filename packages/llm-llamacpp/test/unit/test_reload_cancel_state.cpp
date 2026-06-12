// Regression test for reload() not clearing context state properly when
// activeSingleJobs_ counter is 0. When reload() calls cancel(), and cancel()
// checks the counter and skips calling stop(), any stale state in the old
// context (or the underlying llama_context) isn't properly cleaned up before
// the context is destroyed.
//
// This manifests as "[TextLlm] failed to decode next token" errors after
// finetuning completes and reload() is called to switch back to inference mode.

#include <filesystem>

#include <gtest/gtest.h>

#include "model-interface/LlamaModel.hpp"
#include "test_common.hpp"

namespace {

class ReloadCancelStateTest : public ::testing::Test {
protected:
  void SetUp() override {
    config_["ctx_size"] = "512";
    config_["n_predict"] = "16";
    config_["device"] = "cpu";
    config_["gpu_layers"] = "0";
    config_["verbosity"] = "0";
  }

  std::unique_ptr<LlamaModel> createModel() {
    std::string path = test_common::BaseTestModelPath::get();
    if (!std::filesystem::exists(path)) {
      return nullptr;
    }
    std::string projection;
    auto cfg = config_;
    return std::make_unique<LlamaModel>(
        std::move(path), std::move(projection), std::move(cfg));
  }

  std::unordered_map<std::string, std::string> config_;
};

/// After finetuning completes, reload() is called to switch back to inference
/// mode. If the old context has any stale state and cancel() doesn't properly
/// clean it up (because activeSingleJobs_ is 0), the next inference can fail.
///
/// This test simulates the finetuning completion path:
/// 1. Load model normally (inference mode)
/// 2. Call reload() with finetune overrides (simulates starting finetuning)
/// 3. Call reload() without overrides (simulates finetuning completion)
/// 4. Try to run inference
/// 5. Expect success, not "failed to decode next token"
TEST_F(ReloadCancelStateTest, InferenceWorksAfterFinetuneReload) {
  auto model = createModel();
  ASSERT_NE(model, nullptr) << "Test model not found, skipping";

  model->waitForLoadInitialization();

  // Simulate finetuning start: reload with finetune overrides
  // (In real code this happens in LlamaFinetuner::finetune() line 113)
  FinetuneConfigOverrides finetuneConfig{
      .active = true,
      .batchSize = 2,
      .microBatchSize = 1,
      .contextLength = 256,
      .gpuSupportsF16OutProd = false,
      .flashAttn = false};
  try {
    model->reload(finetuneConfig);
  } catch (const std::exception& e) {
    GTEST_SKIP() << "model cannot enter finetune mode on this setup: "
                 << e.what();
  }

  // Simulate finetuning completion: reload back to inference mode
  // (In real code this happens in LlamaFinetuner::finetune() line 410)
  // At this point activeSingleJobs_ is 0, so cancel() in reload()
  // won't call stop() on the old context.
  model->reload(FinetuneConfigOverrides{});

  // Try to run inference - this should work, not fail with
  // "[TextLlm] failed to decode next token"
  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role":"user","content":"What is 2+2?"}])";
  prompt.generationParams.n_predict = 8;

  std::string output;
  EXPECT_NO_THROW(output = model->processPrompt(prompt))
      << "Inference after finetuning reload failed - likely stale cancel state";

  // We don't care about the exact output, just that decode didn't fail
  EXPECT_FALSE(output.empty())
      << "Empty output suggests decode failed silently";
}

/// A more direct test: if cancel() is called when the model is idle
/// (activeSingleJobs_ == 0), then reload() is called, the old context's
/// stopGeneration_ flag might not be cleared. The next inference could
/// abort immediately.
TEST_F(ReloadCancelStateTest, ReloadAfterIdleCancelDoesNotPoisonInference) {
  auto model = createModel();
  ASSERT_NE(model, nullptr) << "Test model not found, skipping";

  model->waitForLoadInitialization();

  // Cancel when idle - this shouldn't do anything, but with the old
  // implementation might set stopGeneration_ without clearing it
  model->cancel();

  // Reload - if cancel() didn't clear stopGeneration_ because counters were 0,
  // the old context might still have the flag set when it's destroyed
  model->reload(FinetuneConfigOverrides{});

  // Try inference - should work, not fail with "failed to decode next token"
  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role":"user","content":"Say hello."}])";
  prompt.generationParams.n_predict = 8;

  std::string output;
  EXPECT_NO_THROW(output = model->processPrompt(prompt))
      << "Inference after cancel + reload failed";

  EXPECT_FALSE(output.empty()) << "Empty output suggests decode failed";
}

} // namespace
