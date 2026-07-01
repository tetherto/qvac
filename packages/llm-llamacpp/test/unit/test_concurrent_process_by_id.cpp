// Multi-job continuous batching: LlamaModel::process(input, id) and
// cancelById(id). These exercise the IModelMultiprocessor / IModelCancelById
// surface the multi-job scheduler routes to: concurrent id-tagged runs, plus
// per-id cancellation.
//
// REQUIRES addon-cpp with IModelMultiprocessor / IModelCancelById and the
// id-carrying process() overload. Will not compile against older headers.

#include <algorithm>
#include <atomic>
#include <cctype>
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

bool containsCaseInsensitive(
    const std::string& haystack, const std::string& needle) {
  auto toLower = [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  };
  std::string hay(haystack.size(), '\0');
  std::string ndl(needle.size(), '\0');
  std::transform(haystack.begin(), haystack.end(), hay.begin(), toLower);
  std::transform(needle.begin(), needle.end(), ndl.begin(), toLower);
  return hay.find(ndl) != std::string::npos;
}

class ConcurrentProcessByIdTest : public ::testing::Test {
protected:
  void SetUp() override {
    using MP = test_common::TestModelPath;
    config_["device"] = test_common::getTestDevice();
    config_["ctx_size"] = "1024";
    config_["gpu_layers"] = test_common::getTestGpuLayers();
    config_["parallel"] = "4";
    config_["batch_size"] = "256";
    config_["n_predict"] = "128";
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

/// Two concurrent process() calls must each produce their own
/// concrete answer with no cross-talk, AND actually overlap on the scheduler
/// (avgConcurrentSeq > 1). The per-job outputCallback proves the two streams
/// stay isolated.
TEST_F(ConcurrentProcessByIdTest, TwoConcurrentJobsRunIsolatedAndOverlap) {
  REQUIRE_MODEL(model_);
  config_["n_predict"] = "64";
  auto model = loadModel();

  std::string streamedA;
  std::string streamedB;
  auto promptA = makePrompt(
      "What is the capital of France? Answer in one word, then stop.");
  promptA.outputCallback = [&streamedA](const std::string& piece) {
    streamedA += piece;
  };
  auto promptB = makePrompt(
      "What is the natural satellite that orbits Earth? Answer in one word, "
      "then stop.");
  promptB.outputCallback = [&streamedB](const std::string& piece) {
    streamedB += piece;
  };

  auto runJob = [&model](const LlamaModel::Prompt& prompt, JobId id) {
    std::any out = model->process(std::any(prompt), id);
    return std::any_cast<std::string>(out);
  };

  auto futureA = std::async(std::launch::async, runJob, promptA, JobId{1});
  auto futureB = std::async(std::launch::async, runJob, promptB, JobId{2});

  ASSERT_EQ(
      futureA.wait_for(std::chrono::seconds(120)), std::future_status::ready);
  ASSERT_EQ(
      futureB.wait_for(std::chrono::seconds(120)), std::future_status::ready);
  const std::string outA = futureA.get();
  const std::string outB = futureB.get();

  EXPECT_FALSE(outA.empty());
  EXPECT_FALSE(outB.empty());
  EXPECT_NE(outA, outB);
  EXPECT_EQ(streamedA, outA) << "job 1 stream must match its own return value";
  EXPECT_EQ(streamedB, outB) << "job 2 stream must match its own return value";
  EXPECT_TRUE(containsCaseInsensitive(outA, "Paris")) << outA;
  EXPECT_TRUE(containsCaseInsensitive(outB, "Moon")) << outB;

  const auto stats = model->runtimeStats();
  const double avgConcurrentSeq =
      test_common::getStatValue(stats, "avgConcurrentSeq");
  EXPECT_GT(avgConcurrentSeq, 1.0)
      << "two id-tagged jobs did not overlap on the scheduler; "
         "avgConcurrentSeq=" << avgConcurrentSeq;
}

/// cancelById(id) must cancel only the targeted job: the cancelled job stops
/// early (short output) while the other job runs to completion. The target
/// fires cancelById on its own first token so the cut happens mid-generation.
TEST_F(ConcurrentProcessByIdTest, CancelByIdCancelsOnlyTargetedJob) {
  REQUIRE_MODEL(model_);
  config_["n_predict"] = "256";
  auto model = loadModel();

  constexpr JobId kCancelId = 7;
  constexpr JobId kKeepId = 8;

  std::atomic<bool> cancelFired = false;
  std::atomic<size_t> keepPieces = 0;

  auto cancelPrompt = makePrompt(
      "Write a long, detailed, multi-paragraph essay about the history of "
      "astronomy.");
  cancelPrompt.outputCallback =
      [&model, &cancelFired](const std::string&) {
        bool expected = false;
        if (cancelFired.compare_exchange_strong(expected, true)) {
          model->cancelById(kCancelId);
        }
      };

  auto keepPrompt = makePrompt(
      "Write a long, detailed, multi-paragraph essay about ocean currents.");
  keepPrompt.outputCallback = [&keepPieces](const std::string&) {
    keepPieces.fetch_add(1);
  };

  auto runJob = [&model](const LlamaModel::Prompt& prompt, JobId id) {
    std::any out = model->process(std::any(prompt), id);
    return std::any_cast<std::string>(out);
  };

  auto cancelFuture =
      std::async(std::launch::async, runJob, cancelPrompt, kCancelId);
  auto keepFuture = std::async(std::launch::async, runJob, keepPrompt, kKeepId);

  ASSERT_EQ(
      cancelFuture.wait_for(std::chrono::seconds(120)),
      std::future_status::ready);
  ASSERT_EQ(
      keepFuture.wait_for(std::chrono::seconds(120)),
      std::future_status::ready);
  const std::string cancelled = cancelFuture.get();
  const std::string kept = keepFuture.get();

  ASSERT_TRUE(cancelFired.load())
      << "test setup: cancelled job never emitted a token";
  EXPECT_FALSE(kept.empty()) << "untargeted job must run to completion";
  // The kept job, capped at 256 tokens on a long-form prompt, emits many
  // pieces; the cancelled job is cut at its first token, so it must be
  // strictly shorter. cancelById hit only its own slot.
  EXPECT_LT(cancelled.size(), kept.size())
      << "cancelById cancelled the wrong job (or none): cancelled='"
      << cancelled << "', kept-size=" << kept.size();
  EXPECT_GT(keepPieces.load(), 1u)
      << "untargeted job produced no real generation";
}
