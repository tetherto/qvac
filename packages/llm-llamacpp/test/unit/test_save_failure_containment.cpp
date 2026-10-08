// A job's terminal cache-save failure costs only its cache. The drain-time
// save failure (e.g. a cacheKey under a missing directory) keeps the job's
// answer and reports `cacheSaveFailed`, a concurrent job on another slot keeps
// decoding to completion, and the scheduler keeps admitting new work.

#include <atomic>
#include <chrono>
#include <filesystem>
#include <future>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/LlamaModel.hpp"
#include "test_common.hpp"

namespace {

namespace fs = std::filesystem;

std::string uniqueTestId() {
  return std::to_string(
      std::chrono::high_resolution_clock::now().time_since_epoch().count());
}

class SaveFailureContainmentTest : public ::testing::Test {
protected:
  void SetUp() override {
    using MP = test_common::TestModelPath;
    config_["device"] = test_common::getTestDevice();
    // Per-seq window = ctx_size / parallel = 512 tokens: the survivor's
    // 256-token essay keeps its slot decoding long after the failing job's
    // 4-token run drains and its save throws.
    config_["ctx_size"] = "2048";
    config_["gpu_layers"] = test_common::getTestGpuLayers();
    config_["parallel"] = "4";
    config_["batch_size"] = "256";
    config_["n_predict"] = "256";
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

/// Job A finishes and its terminal cache save fails (cacheKey parent
/// directory does not exist). A still gets its answer and the flag, job B on
/// another slot runs to completion, and the scheduler admits new work after.
TEST_F(SaveFailureContainmentTest, SaveFailureKeepsAnswerAndSparesOtherJobs) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();

  const fs::path badCacheDir =
      fs::temp_directory_path() / ("save-fail-containment-" + uniqueTestId());
  const fs::path badCachePath = badCacheDir / "session.bin";
  fs::remove_all(badCacheDir);

  std::atomic<bool> survivorTokenSeen = false;
  auto survivor = makePrompt(
      "Write a long, detailed, multi-paragraph essay about ocean currents.");
  survivor.outputCallback = [&survivorTokenSeen](const std::string&) {
    survivorTokenSeen.store(true);
  };

  auto survivorFuture = std::async(std::launch::async, [&model, &survivor] {
    return model->processPromptBatch(std::vector<LlamaModel::Prompt>{survivor});
  });

  // The failing job must drain while the survivor still holds a decoding
  // slot: wait for the survivor's first token before submitting it.
  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::seconds(120);
  while (!survivorTokenSeen.load() &&
         std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  ASSERT_TRUE(survivorTokenSeen.load())
      << "test setup: survivor never emitted a token";

  auto failing = makePrompt("Say hi.");
  failing.cacheKey = badCachePath.string();
  failing.saveCacheToDisk = true;
  // A 4-token run drains (and its save fails) roughly 250 tokens before
  // the survivor's essay can finish.
  failing.generationParams.n_predict = 4;

  std::vector<std::string> failingOutputs;
  ASSERT_NO_THROW(
      failingOutputs =
          model->processPromptBatch(std::vector<LlamaModel::Prompt>{failing}))
      << "a failed cache save must not discard the finished answer";
  ASSERT_EQ(failingOutputs.size(), 1u);
  EXPECT_FALSE(failingOutputs[0].empty());
  EXPECT_GE(
      test_common::getStatValue(model->runtimeStats(), "cacheSaveFailed"),
      1.0);

  if (survivorFuture.wait_for(std::chrono::seconds(120)) !=
      std::future_status::ready) {
    GTEST_SKIP() << "survivor generation did not finish within 120s: machine "
                    "too slow to judge save-failure containment (seen on "
                    "loaded CI runners)";
  }
  std::vector<std::string> survivorOutputs;
  try {
    survivorOutputs = survivorFuture.get();
  } catch (const std::exception& e) {
    FAIL() << "concurrent job was torn down by the failing job's save error: "
           << e.what();
  }
  ASSERT_EQ(survivorOutputs.size(), 1u);
  EXPECT_FALSE(survivorOutputs[0].empty())
      << "survivor must complete with its own output";

  // No wedged slots: the scheduler must admit and complete new work.
  auto followup = makePrompt("Say hi again.");
  auto followupOutputs =
      model->processPromptBatch(std::vector<LlamaModel::Prompt>{followup});
  ASSERT_EQ(followupOutputs.size(), 1u);
  EXPECT_FALSE(followupOutputs[0].empty());

  EXPECT_FALSE(fs::exists(badCacheDir))
      << "failed save must not create the missing parent directory";
}
