// Per-group cancellation of tagged batch runs: cancelById(groupId) must tear
// down every scheduler slot the group holds — and nothing else. Peers (other
// groups, concurrent single jobs) keep running. This is the engine half of
// the JS "batch response cancel" contract (see batch-cancel-per-group.test.js).

#include <any>
#include <atomic>
#include <chrono>
#include <future>
#include <string>
#include <thread>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/LlamaModel.hpp"
#include "test_common.hpp"

namespace {

using qvac_lib_inference_addon_cpp::JobId;

class BatchGroupCancelTest : public ::testing::Test {
protected:
  void SetUp() override {
    using MP = test_common::TestModelPath;
    config_["device"] = test_common::getTestDevice();
    // Per-seq KV share = ctx_size / parallel = 512: essay prompts +
    // n_predict fit, and 256-token generations leave a wide window for the
    // cancel to land mid-run.
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

/// A tagged batch group and a tagged single job run together; cancelById on
/// the GROUP id must cut both of the group's generations short while the
/// single job runs to completion. Guards the exact review finding: a running
/// batch group had no cancel action armed, so a per-group cancel evaporated
/// (and the JS fallback — whole-model cancel — killed the innocent peer).
TEST_F(BatchGroupCancelTest, CancelByIdCancelsOnlyTargetedGroup) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();

  constexpr JobId kGroupId = 81;
  constexpr JobId kKeepId = 82;

  std::atomic<bool> groupTokenSeen = false;
  std::atomic<size_t> keepPieces = 0;

  std::vector<LlamaModel::Prompt> group;
  group.push_back(makePrompt(
      "Write a long, detailed, multi-paragraph essay about the history of "
      "astronomy."));
  group.push_back(makePrompt(
      "Write a long, detailed, multi-paragraph essay about the history of "
      "cartography."));
  for (auto& prompt : group) {
    prompt.outputCallback = [&groupTokenSeen](const std::string&) {
      groupTokenSeen.store(true);
    };
  }

  auto keepPrompt = makePrompt(
      "Write a long, detailed, multi-paragraph essay about ocean currents.");
  keepPrompt.outputCallback = [&keepPieces](const std::string&) {
    keepPieces.fetch_add(1);
  };

  auto groupFuture = std::async(std::launch::async, [&model, &group] {
    std::any out = model->process(std::any(group), kGroupId);
    return std::any_cast<std::vector<std::string>>(out);
  });
  auto keepFuture = std::async(std::launch::async, [&model, &keepPrompt] {
    std::any out = model->process(std::any(keepPrompt), kKeepId);
    return std::any_cast<std::string>(out);
  });

  // Cancel as soon as the group starts streaming, from this thread — never
  // from inside outputCallback (scheduler worker holds its mutex there).
  const auto tokenDeadline =
      std::chrono::steady_clock::now() + std::chrono::seconds(120);
  while (!groupTokenSeen.load() &&
         std::chrono::steady_clock::now() < tokenDeadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  ASSERT_TRUE(groupTokenSeen.load())
      << "test setup: group never emitted a token";
  model->cancelById(kGroupId);

  ASSERT_EQ(
      groupFuture.wait_for(std::chrono::seconds(120)),
      std::future_status::ready);
  ASSERT_EQ(
      keepFuture.wait_for(std::chrono::seconds(120)),
      std::future_status::ready);
  const std::vector<std::string> cancelled = groupFuture.get();
  const std::string kept = keepFuture.get();

  ASSERT_EQ(cancelled.size(), 2u);
  EXPECT_FALSE(kept.empty()) << "untargeted single job must run to completion";
  EXPECT_GT(keepPieces.load(), 1u)
      << "untargeted single job produced no real generation";
  // The kept job, capped at 256 tokens on a long-form prompt, emits many
  // pieces; the group's slots are cut within a few tokens of the group's
  // first, so each member must be strictly shorter. The cancel hit every
  // slot of its own group and no other.
  for (size_t i = 0; i < cancelled.size(); i++) {
    EXPECT_LT(cancelled[i].size(), kept.size())
        << "group member " << i
        << " ran to completion; cancelById(groupId) did not land on its "
           "slot. output='"
        << cancelled[i] << "'";
  }
}
