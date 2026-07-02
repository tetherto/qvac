#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <future>
#include <iostream>
#include <iterator>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include <ggml-backend.h>
#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>
#include <llama.h>

#include "model-interface/ContinuousBatchScheduler.hpp"
#include "model-interface/LlamaModel.hpp"
#include "test_common.hpp"
#include "test_internal_peers.hpp"

namespace {

namespace fs = std::filesystem;

std::string uniqueTestId() {
  return std::to_string(
      std::chrono::high_resolution_clock::now().time_since_epoch().count());
}

/// Case-insensitive substring check. Used to assert generated text
/// contains an expected token (e.g. "Paris", "Moon") regardless of
/// capitalisation or surrounding punctuation the model may add.
bool containsCaseInsensitive(
    const std::string& haystack, const std::string& needle) {
  auto toLower = [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  };
  std::string hay_str(haystack.size(), '\0');
  std::string needle_str(needle.size(), '\0');
  std::transform(haystack.begin(), haystack.end(), hay_str.begin(), toLower);
  std::transform(needle.begin(), needle.end(), needle_str.begin(), toLower);
  return hay_str.find(needle_str) != std::string::npos;
}

bool hasUnclosedThinkBlock(const std::string& text) {
  const auto openPos = text.rfind("<think>");
  if (openPos == std::string::npos) {
    return false;
  }
  const auto closePos = text.rfind("</think>");
  return closePos == std::string::npos || closePos < openPos;
}

std::string lowerCopy(std::string text) {
  std::transform(text.begin(), text.end(), text.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  return text;
}

bool containsAny(
    const std::string& haystack, const std::vector<std::string>& needles) {
  return std::ranges::any_of(needles, [&](const std::string& needle) {
    return haystack.find(needle) != std::string::npos;
  });
}

bool hasRealGpuBackendDevice() {
  static const std::vector<std::string> kSoftwareGpuMarkers{
      "llvmpipe", "lavapipe", "softpipe", "swiftshader", "software"};
  const size_t deviceCount = ggml_backend_dev_count();
  for (size_t i = 0; i < deviceCount; ++i) {
    ggml_backend_dev_t dev = ggml_backend_dev_get(i);
    const auto devType = ggml_backend_dev_type(dev);
    if (devType != GGML_BACKEND_DEVICE_TYPE_GPU &&
        devType != GGML_BACKEND_DEVICE_TYPE_IGPU) {
      continue;
    }
    const ggml_backend_reg_t reg = ggml_backend_dev_backend_reg(dev);
    const std::string regName = ggml_backend_reg_name(reg);
    if (regName == "RPC") {
      continue;
    }
    const std::string description =
        lowerCopy(ggml_backend_dev_description(dev));
    const std::string name = lowerCopy(ggml_backend_dev_name(dev));
    if (!containsAny(description + " " + name, kSoftwareGpuMarkers)) {
      return true;
    }
  }
  return false;
}

class ContinuousBatchingIntegrationTest : public ::testing::Test {
protected:
  void SetUp() override {
    using MP = test_common::TestModelPath;

    config_["device"] = test_common::getTestDevice();
    config_["ctx_size"] = "1024";
    config_["gpu_layers"] = test_common::getTestGpuLayers();
    config_["parallel"] = "4";
    config_["batch_size"] = "256";
    config_["n_predict"] = "32";
    config_["temp"] = "0";
    config_["backendsDir"] = test_common::getTestBackendsDir().string();

    model_ =
        MP("Llama-3.2-1B-Instruct-Q4_0.gguf",
           nullptr,
           MP::OnMissing::Skip,
           "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF");
    qwen3Model_ =
        MP("Qwen3-0.6B.Q4_0.gguf",
           "QWEN3_BATCH_MODEL_PATH",
           MP::OnMissing::Skip,
           "https://huggingface.co/QuantFactory/Qwen3-0.6B-GGUF");
    harmonyModel_ =
        MP("gpt-oss-20b-Q2_K.gguf",
           "HARMONY_BATCH_MODEL_PATH",
           MP::OnMissing::Skip,
           "https://huggingface.co/mradermacher/gpt-oss-20b-GGUF");
  }

  std::unique_ptr<LlamaModel> loadModel() { return loadModel(model_); }

  std::unique_ptr<LlamaModel>
  loadModel(const test_common::TestModelPath& modelPath) {
    std::string path = model_.path;
    std::string projection;
    auto cfg = config_;
    path = modelPath.path;
    auto m = std::make_unique<LlamaModel>(
        std::move(path), std::move(projection), std::move(cfg));
    m->waitForLoadInitialization();
    return m;
  }

  static LlamaModel::Prompt makePrompt(const std::string& userText) {
    LlamaModel::Prompt p;
    p.input = R"([{"role":"user","content":")" + userText + R"("}])";
    return p;
  }

  static LlamaModel::Prompt makeToolPrompt() {
    LlamaModel::Prompt p;
    p.input = R"([
      {"role":"user","content":"Use the weather tool for Paris."},
      {
        "type":"function",
        "name":"get_weather",
        "description":"Get weather for a city",
        "parameters":{"type":"object","properties":{"city":{"type":"string"}}}
      }
    ])";
    return p;
  }

  std::unordered_map<std::string, std::string> config_;
  test_common::TestModelPath model_;
  test_common::TestModelPath qwen3Model_;
  test_common::TestModelPath harmonyModel_;
};

} // namespace

/// Single-prompt vector path must produce one non-empty output that
/// contains the expected concrete answer ("Paris").
TEST_F(ContinuousBatchingIntegrationTest, SinglePromptReturnsExpectedAnswer) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();

  std::vector<LlamaModel::Prompt> prompts{
      makePrompt("What is the capital of France? Answer in one word.")};
  auto outputs = model->processPromptBatch(prompts);

  ASSERT_EQ(outputs.size(), 1u);
  EXPECT_TRUE(containsCaseInsensitive(outputs[0], "Paris"))
      << "expected 'Paris' in: " << outputs[0];
}

/// Two prompts run together must each yield their concrete answers in
/// input order without cross-talk between sequences.
TEST_F(ContinuousBatchingIntegrationTest, TwoPromptsReturnExpectedAnswers) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();

  std::vector<LlamaModel::Prompt> prompts{
      makePrompt("What is the capital of France? Answer in one word."),
      makePrompt(
          "What is the natural satellite that orbits Earth? "
          "Answer in one word.")};
  auto outputs = model->processPromptBatch(prompts);

  ASSERT_EQ(outputs.size(), 2u);
  EXPECT_TRUE(containsCaseInsensitive(outputs[0], "Paris"))
      << "expected 'Paris' in: " << outputs[0];
  EXPECT_TRUE(containsCaseInsensitive(outputs[1], "Moon"))
      << "expected 'Moon' in: " << outputs[1];
  EXPECT_NE(outputs[0], outputs[1]);
}

TEST_F(ContinuousBatchingIntegrationTest, TwoPromptBatchReportsAvgConcurrency) {
  REQUIRE_MODEL(model_);
  config_["n_predict"] = "128";
  auto model = loadModel();

  std::vector<LlamaModel::Prompt> prompts{
      makePrompt("Write a short paragraph about redwood forests."),
      makePrompt("Write a short paragraph about coral reefs.")};
  auto outputs = model->processPromptBatch(prompts);
  const auto stats = model->runtimeStats();
  const double avgConcurrentSeq =
      test_common::getStatValue(stats, "avgConcurrentSeq");
  const double cacheTokens = test_common::getStatValue(stats, "CacheTokens");
  const double contextSlides =
      test_common::getStatValue(stats, "contextSlides");

  ASSERT_EQ(outputs.size(), 2u);
  EXPECT_FALSE(outputs[0].empty());
  EXPECT_FALSE(outputs[1].empty());
  EXPECT_GT(avgConcurrentSeq, 1.0);
  EXPECT_LE(avgConcurrentSeq, 2.0);
  EXPECT_GT(cacheTokens, 0.0);
  EXPECT_GE(contextSlides, 0.0);
}

/// A real batched run must report both phase-separated throughput rates:
/// a decode rate from generation steps and a prompt-processing rate from
/// pure-prefill steps. Prefill is compute-bound and decode is
/// bandwidth-bound, so prompt processing runs faster per token.
TEST_F(
    ContinuousBatchingIntegrationTest, BatchReportsPhaseSeparatedThroughput) {
  REQUIRE_MODEL(model_);
  config_["n_predict"] = "32";
  auto model = loadModel();

  std::vector<LlamaModel::Prompt> prompts{
      makePrompt("Write a short paragraph about redwood forests."),
      makePrompt("Write a short paragraph about coral reefs.")};
  auto outputs = model->processPromptBatch(prompts);
  const auto stats = model->runtimeStats();

  const double decodeTps = test_common::getStatValue(stats, "TPS");
  const double prefillTps = test_common::getStatValue(stats, "ppTPS");
  const double generatedTokens =
      test_common::getStatValue(stats, "generatedTokens");
  const double promptTokens = test_common::getStatValue(stats, "promptTokens");

  ASSERT_EQ(outputs.size(), 2u);
  EXPECT_FALSE(outputs[0].empty());
  EXPECT_FALSE(outputs[1].empty());
  EXPECT_GT(generatedTokens, 0.0);
  EXPECT_GT(promptTokens, 0.0);
  EXPECT_GT(decodeTps, 0.0);
  EXPECT_GT(prefillTps, 0.0);
/// On Apple Silicon the ordering may not hold: UMA high-bandwidth memory
/// erases the bandwidth bottleneck that normally slows decode, and small
/// models with short prompts give prefill insufficient parallelism to win.
#ifndef __APPLE__
  // 0.8 margin absorbs timing noise while still catching major regressions.
  EXPECT_GT(prefillTps, decodeTps * 0.8)
      << "prefill should out-pace decode per token: prefillTps=" << prefillTps
      << ", decodeTps=" << decodeTps;
#endif
}

TEST_F(
    ContinuousBatchingIntegrationTest,
    OneAndThreeOverlappingBatchCallsShareTwoSlots) {
  REQUIRE_MODEL(model_);
  config_["parallel"] = "2";
  config_["n_predict"] = "64";
  auto model = loadModel();

  std::atomic<bool> firstCallEntered = false;
  std::atomic<bool> firstBatchDone = false;
  std::atomic<bool> secondBatchEmittedBeforeFirstDone = false;
  auto firstPrompt = makePrompt("List facts about redwood forests.");

  auto firstFuture = std::async(
      std::launch::async,
      [&model, firstPrompt, &firstCallEntered, &firstBatchDone] {
        std::vector<LlamaModel::Prompt> prompts{firstPrompt};
        firstCallEntered.store(true);
        auto outputs = model->processPromptBatch(prompts);
        firstBatchDone.store(true);
        return outputs;
      });

  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::seconds(30);
  while (!firstCallEntered.load() &&
         std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  ASSERT_TRUE(firstCallEntered.load());

  auto secondFuture = std::async(
      std::launch::async,
      [&model, &firstBatchDone, &secondBatchEmittedBeforeFirstDone] {
        auto secondPrompt = makePrompt("List facts about coral reefs.");
        secondPrompt.outputCallback =
            [&firstBatchDone,
             &secondBatchEmittedBeforeFirstDone](const std::string&) {
              if (!firstBatchDone.load()) {
                secondBatchEmittedBeforeFirstDone.store(true);
              }
            };
        std::vector<LlamaModel::Prompt> prompts{
            std::move(secondPrompt),
            makePrompt("List facts about alpine glaciers."),
            makePrompt("List facts about desert wildflowers.")};
        return model->processPromptBatch(prompts);
      });

  ASSERT_EQ(
      firstFuture.wait_for(std::chrono::seconds(60)),
      std::future_status::ready);
  ASSERT_EQ(
      secondFuture.wait_for(std::chrono::seconds(60)),
      std::future_status::ready);
  auto firstOutputs = firstFuture.get();
  auto secondOutputs = secondFuture.get();

  ASSERT_EQ(firstOutputs.size(), 1u);
  ASSERT_EQ(secondOutputs.size(), 3u);
  EXPECT_FALSE(firstOutputs[0].empty());
  EXPECT_FALSE(secondOutputs[0].empty());
  EXPECT_FALSE(secondOutputs[1].empty());
  EXPECT_FALSE(secondOutputs[2].empty());
  EXPECT_TRUE(secondBatchEmittedBeforeFirstDone.load());

  const auto stats = model->runtimeStats();
  const double avgConcurrentSeq =
      test_common::getStatValue(stats, "avgConcurrentSeq");
  std::cout
      << "OneAndThreeOverlappingBatchCallsShareTwoSlots: avgConcurrentSeq="
      << avgConcurrentSeq << ", secondGroupEmittedBeforeFirstDone="
      << secondBatchEmittedBeforeFirstDone.load() << '\n';
  // If the scheduler ran separate waves (1 -> 2 -> 1), equal-length requests
  // would average about 1.33 occupied slots. This higher threshold, plus the
  // coexistence flag above, confirms the second group joined the first.
  EXPECT_GT(avgConcurrentSeq, 1.6);
}

/// Regression for the unconditional all-sequence KV wipe at
/// processPromptBatchImpl entry: when one batch job is already in flight, a
/// second overlapping processPromptBatch call must NOT clear the active job's
/// KV. The first batch is parked inside its first-token callback so its slot
/// KV is populated (and no llama decode is running) while the main thread
/// fires an empty overlapping batch. With the bug the empty call's entry wipe
/// clears the active sequence; with the fix it is skipped because another
/// batch job is active.
TEST_F(ContinuousBatchingIntegrationTest, OverlappingBatchDoesNotWipeActiveKv) {
  REQUIRE_MODEL(model_);
  config_["parallel"] = "2";
  config_["n_predict"] = "64";
  auto model = loadModel();

  std::mutex mtx;
  std::condition_variable cv;
  bool firstTokenSeen = false;
  bool releaseFirst = false;

  auto firstPrompt = makePrompt("List several facts about redwood forests.");
  firstPrompt.outputCallback =
      [&mtx, &cv, &firstTokenSeen, &releaseFirst](const std::string&) {
        std::unique_lock<std::mutex> lk(mtx);
        if (!firstTokenSeen) {
          firstTokenSeen = true;
          cv.notify_all();
        }
        cv.wait(lk, [&releaseFirst] { return releaseFirst; });
      };

  auto firstFuture = std::async(std::launch::async, [&model, firstPrompt] {
    std::vector<LlamaModel::Prompt> prompts{firstPrompt};
    return model->processPromptBatch(prompts);
  });

  {
    std::unique_lock<std::mutex> lk(mtx);
    ASSERT_TRUE(cv.wait_for(lk, std::chrono::seconds(60), [&firstTokenSeen] {
      return firstTokenSeen;
    })) << "first batch never produced a token";
  }

  llama_context* lctx = model->getContext();
  ASSERT_NE(lctx, nullptr);
  llama_memory_t mem = llama_get_memory(lctx);
  ASSERT_NE(mem, nullptr);
  const int nSeqMax = llama_n_seq_max(lctx);

  llama_seq_id activeSeq = -1;
  for (int seqId = 0; seqId < nSeqMax; seqId++) {
    if (llama_memory_seq_pos_max(mem, static_cast<llama_seq_id>(seqId)) >= 0) {
      activeSeq = static_cast<llama_seq_id>(seqId);
      break;
    }
  }
  ASSERT_NE(activeSeq, -1) << "first batch slot has no KV while parked";

  const std::vector<LlamaModel::Prompt> emptyBatch;
  const auto emptyOutputs = model->processPromptBatch(emptyBatch);
  EXPECT_TRUE(emptyOutputs.empty());

  const llama_pos posAfter = llama_memory_seq_pos_max(mem, activeSeq);

  model->cancel();
  {
    std::lock_guard<std::mutex> lk(mtx);
    releaseFirst = true;
  }
  cv.notify_all();
  ASSERT_EQ(
      firstFuture.wait_for(std::chrono::seconds(60)),
      std::future_status::ready);
  (void)firstFuture.get();

  EXPECT_GE(posAfter, 0)
      << "overlapping processPromptBatch wiped the active job's KV: seq "
      << activeSeq << " pos_max=" << posAfter
      << ". The entry-time all-sequence KV wipe must be skipped when another "
         "batch job is already in flight.";
}

TEST_F(
    ContinuousBatchingIntegrationTest,
    ConcurrentBatchEntriesDoNotRaceOnKvWipe) {
  // Reproduces comment-4742982980: two batch calls that enter
  // processPromptBatchImpl concurrently can collide in the entry section
  // before either has incremented activeBatchJobs_. Without a batch-entry
  // mutex the first caller's KV wipe races with the second caller's scheduler
  // admission, potentially clearing the second caller's sequences.
  //
  // The test uses an atomic counter as a rendezvous to maximise the chance
  // that both callers execute the entry section simultaneously.
  REQUIRE_MODEL(model_);
  config_["parallel"] = "2";
  config_["n_predict"] = "16";
  auto model = loadModel();

  std::atomic<int> ready{0};

  auto runBatch = [&](const std::string& question) {
    // Spin until both threads are lined up, then enter together.
    ready.fetch_add(1);
    while (ready.load() < 2) {
      std::this_thread::yield();
    }
    std::vector<LlamaModel::Prompt> prompts{makePrompt(question)};
    return model->processPromptBatch(prompts);
  };

  auto f1 = std::async(std::launch::async, runBatch, "What is 2+2?");
  auto f2 = std::async(std::launch::async, runBatch, "What is 3+3?");

  ASSERT_EQ(f1.wait_for(std::chrono::seconds(120)), std::future_status::ready)
      << "first concurrent batch call timed out";
  ASSERT_EQ(f2.wait_for(std::chrono::seconds(120)), std::future_status::ready)
      << "second concurrent batch call timed out";

  auto out1 = f1.get();
  auto out2 = f2.get();
  ASSERT_EQ(out1.size(), 1u);
  ASSERT_EQ(out2.size(), 1u);
  EXPECT_FALSE(out1[0].empty()) << "first concurrent batch returned empty";
  EXPECT_FALSE(out2[0].empty()) << "second concurrent batch returned empty";
}

TEST_F(ContinuousBatchingIntegrationTest, FourPromptBatchReportsHigherTps) {
  REQUIRE_MODEL(model_);
  config_["n_predict"] = "128";
  auto model = loadModel();
  const auto initialStats = model->runtimeStats();
  if (test_common::getStatValue(initialStats, "backendDevice") != 1.0) {
    GTEST_SKIP() << "requires GPU backend for throughput comparison";
  }
  if (!hasRealGpuBackendDevice()) {
    GTEST_SKIP() << "requires hardware GPU backend for throughput comparison";
  }

  struct TimedOutputs {
    std::vector<std::string> outputs;
    double elapsedMsPerPrompt;
  };

  const auto measurePrompts = [](size_t promptCount, auto&& runPrompts) {
    const auto startedAt = std::chrono::steady_clock::now();
    std::vector<std::string> outputs = runPrompts();
    const auto finishedAt = std::chrono::steady_clock::now();
    const auto elapsedMs =
        std::chrono::duration<double, std::milli>(finishedAt - startedAt)
            .count();
    return TimedOutputs{
        .outputs = std::move(outputs),
        .elapsedMsPerPrompt = elapsedMs / static_cast<double>(promptCount)};
  };

  auto singleModel = loadModel();
  const auto singlePrompt =
      makePrompt("Write a long paragraph about redwood forests.");
  auto singleRun = measurePrompts(1u, [&singleModel, &singlePrompt] {
    return std::vector<std::string>{singleModel->processPrompt(singlePrompt)};
  });
  const auto singleStats = singleModel->runtimeStats();
  const double singleTps = test_common::getStatValue(singleStats, "TPS");
  const double singleAvgConcurrentSeq =
      test_common::getStatValue(singleStats, "avgConcurrentSeq");
  const double singleGeneratedTokens =
      test_common::getStatValue(singleStats, "generatedTokens");

  auto twoModel = loadModel();
  std::vector<LlamaModel::Prompt> twoPrompts{
      makePrompt("Write a long paragraph about redwood forests."),
      makePrompt("Write a long paragraph about coral reefs.")};
  auto twoRun = measurePrompts(twoPrompts.size(), [&twoModel, &twoPrompts] {
    return twoModel->processPromptBatch(twoPrompts);
  });
  const auto twoStats = twoModel->runtimeStats();
  const double twoTps = test_common::getStatValue(twoStats, "TPS");
  const double twoAvgConcurrentSeq =
      test_common::getStatValue(twoStats, "avgConcurrentSeq");
  const double twoGeneratedTokens =
      test_common::getStatValue(twoStats, "generatedTokens");

  auto fourModel = loadModel();
  std::vector<LlamaModel::Prompt> fourPrompts{
      makePrompt("Write a long paragraph about redwood forests."),
      makePrompt("Write a long paragraph about coral reefs."),
      makePrompt("Write a long paragraph about alpine glaciers."),
      makePrompt("Write a long paragraph about desert wildflowers.")};
  auto fourRun = measurePrompts(fourPrompts.size(), [&fourModel, &fourPrompts] {
    return fourModel->processPromptBatch(fourPrompts);
  });
  const auto fourStats = fourModel->runtimeStats();
  const double fourTps = test_common::getStatValue(fourStats, "TPS");
  const double fourAvgConcurrentSeq =
      test_common::getStatValue(fourStats, "avgConcurrentSeq");
  const double fourGeneratedTokens =
      test_common::getStatValue(fourStats, "generatedTokens");

  ASSERT_EQ(singleRun.outputs.size(), 1u);
  ASSERT_EQ(twoRun.outputs.size(), 2u);
  ASSERT_EQ(fourRun.outputs.size(), 4u);
  EXPECT_FALSE(singleRun.outputs[0].empty());
  EXPECT_FALSE(twoRun.outputs[0].empty());
  EXPECT_FALSE(twoRun.outputs[1].empty());
  EXPECT_FALSE(fourRun.outputs[0].empty());
  EXPECT_FALSE(fourRun.outputs[1].empty());
  EXPECT_FALSE(fourRun.outputs[2].empty());
  EXPECT_FALSE(fourRun.outputs[3].empty());
  EXPECT_GT(singleTps, 0.0);
  EXPECT_GT(twoTps, 0.0);
  EXPECT_GT(fourTps, 0.0);
  std::cout << "FourPromptBatchReportsHigherTps: single TPS=" << singleTps
            << ", two-prompt TPS=" << twoTps << ", four-prompt TPS=" << fourTps
            << ", single avgConcurrentSeq=" << singleAvgConcurrentSeq
            << ", two avgConcurrentSeq=" << twoAvgConcurrentSeq
            << ", four avgConcurrentSeq=" << fourAvgConcurrentSeq
            << ", single generatedTokens=" << singleGeneratedTokens
            << ", two generatedTokens=" << twoGeneratedTokens
            << ", four generatedTokens=" << fourGeneratedTokens
            << ", single elapsedMsPerPrompt=" << singleRun.elapsedMsPerPrompt
            << ", two elapsedMsPerPrompt=" << twoRun.elapsedMsPerPrompt
            << ", four elapsedMsPerPrompt=" << fourRun.elapsedMsPerPrompt
            << '\n';
  EXPECT_NEAR(singleAvgConcurrentSeq, 1.0, 0.001);
  EXPECT_GT(twoAvgConcurrentSeq, singleAvgConcurrentSeq);
  EXPECT_GT(fourAvgConcurrentSeq, twoAvgConcurrentSeq);
  EXPECT_GT(singleRun.elapsedMsPerPrompt, fourRun.elapsedMsPerPrompt)
      << "single elapsedMsPerPrompt=" << singleRun.elapsedMsPerPrompt
      << ", two elapsedMsPerPrompt=" << twoRun.elapsedMsPerPrompt
      << ", four elapsedMsPerPrompt=" << fourRun.elapsedMsPerPrompt;
  EXPECT_GT(fourTps, singleTps)
      << "single TPS=" << singleTps << ", two-prompt TPS=" << twoTps
      << ", four-prompt TPS=" << fourTps
      << ", four avgConcurrentSeq=" << fourAvgConcurrentSeq;
}

/// `process(std::any)` dispatches on `vector<Prompt>` and round-trips
/// the resulting `vector<string>` payload.
TEST_F(ContinuousBatchingIntegrationTest, ProcessDispatchesVectorOfPrompts) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();

  std::vector<LlamaModel::Prompt> prompts{
      makePrompt("Say hi."), makePrompt("Say bye.")};
  std::any out = model->process(std::any(prompts));

  ASSERT_EQ(out.type(), typeid(std::vector<std::string>));
  const auto& outputs = std::any_cast<const std::vector<std::string>&>(out);
  ASSERT_EQ(outputs.size(), 2u);
  EXPECT_FALSE(outputs[0].empty());
  EXPECT_FALSE(outputs[1].empty());
}

/// Empty vector returns empty output without invoking the scheduler.
TEST_F(ContinuousBatchingIntegrationTest, EmptyVectorReturnsEmpty) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();
  auto outputs = model->processPromptBatch({});
  EXPECT_TRUE(outputs.empty());
}

/// Per-prompt `generationParams.n_predict` overrides cap each sequence
/// independently when both run in the same batch. The two prompts use a
/// long-form instruction so neither sequence is expected to hit EOG
/// before its cap; the smaller-cap prompt must therefore emit strictly
/// fewer token-pieces (and thus shorter text) than the larger-cap one,
/// and each piece-count must respect its own cap.
TEST_F(
    ContinuousBatchingIntegrationTest, PerPromptNPredictOverrideIsRespected) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();

  constexpr int kSmallNPredict = 8;
  constexpr int kLargeNPredict = 48;

  size_t piecesSmall = 0;
  size_t piecesLarge = 0;

  auto promptSmall = makePrompt(
      "Write a long, detailed paragraph about the history of astronomy.");
  promptSmall.generationParams.n_predict = kSmallNPredict;
  promptSmall.outputCallback = [&piecesSmall](const std::string&) {
    piecesSmall++;
  };

  auto promptLarge = makePrompt(
      "Write a long, detailed paragraph about the history of astronomy.");
  promptLarge.generationParams.n_predict = kLargeNPredict;
  promptLarge.outputCallback = [&piecesLarge](const std::string&) {
    piecesLarge++;
  };

  std::vector<LlamaModel::Prompt> prompts{
      std::move(promptSmall), std::move(promptLarge)};
  auto outputs = model->processPromptBatch(prompts);

  ASSERT_EQ(outputs.size(), 2u);

  // Each emit corresponds to at most one decoded token (UTF-8 buffering
  // can collapse partial pieces, so the count is an upper bound). The
  // per-sequence cap counts prompt + generated tokens; piece-counts only
  // observe the generated tail, so they must stay strictly below their
  // respective caps.
  EXPECT_LE(piecesSmall, static_cast<size_t>(kSmallNPredict))
      << "small-cap sequence emitted " << piecesSmall
      << " pieces, expected <= " << kSmallNPredict;
  EXPECT_LE(piecesLarge, static_cast<size_t>(kLargeNPredict))
      << "large-cap sequence emitted " << piecesLarge
      << " pieces, expected <= " << kLargeNPredict;

  // Cross-check the two caps actually take effect independently. Without
  // per-request plumbing both sequences would generate up to the same
  // batcher-wide ceiling and produce the same length.
  EXPECT_LT(piecesSmall, piecesLarge)
      << "expected smaller cap to truncate first: small=" << piecesSmall
      << ", large=" << piecesLarge;
  EXPECT_LT(outputs[0].size(), outputs[1].size())
      << "expected smaller cap to yield shorter text: small='" << outputs[0]
      << "', large='" << outputs[1] << "'";
}

/// Per-prompt outputCallback fires for every emitted piece, in addition
/// to the aggregated string returned by processPromptBatch.
TEST_F(ContinuousBatchingIntegrationTest, OutputCallbackStreamsPieces) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();

  std::string streamed;
  auto prompt = makePrompt("Say hi.");
  prompt.outputCallback = [&streamed](const std::string& piece) {
    streamed += piece;
  };
  std::vector<LlamaModel::Prompt> prompts{prompt};
  auto outputs = model->processPromptBatch(prompts);

  ASSERT_EQ(outputs.size(), 1u);
  EXPECT_EQ(streamed, outputs[0]);
}

/// Two prompts in the same batch must stream to their own callbacks without
/// mixing pieces between sequences.
TEST_F(
    ContinuousBatchingIntegrationTest, TwoPromptCallbacksStreamIndependently) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();

  std::string streamedA;
  std::string streamedB;
  auto promptA = makePrompt("Say alpha.");
  promptA.outputCallback = [&streamedA](const std::string& piece) {
    streamedA += piece;
  };
  auto promptB = makePrompt("Say beta.");
  promptB.outputCallback = [&streamedB](const std::string& piece) {
    streamedB += piece;
  };

  std::vector<LlamaModel::Prompt> prompts{
      std::move(promptA), std::move(promptB)};
  auto outputs = model->processPromptBatch(prompts);

  ASSERT_EQ(outputs.size(), 2u);
  EXPECT_EQ(streamedA, outputs[0]);
  EXPECT_EQ(streamedB, outputs[1]);
}

/// Tool definitions are per-request prompt inputs. A two-text batch must
/// preserve them in the formatted prompt instead of silently dropping them or
/// rejecting the whole batch.
TEST_F(
    ContinuousBatchingIntegrationTest, TwoPromptBatchAcceptsToolDefinitions) {
  REQUIRE_MODEL(model_);
  config_["tools"] = "true";
  auto model = loadModel();

  std::vector<LlamaModel::Prompt> prompts{
      makePrompt("Say plain text."), makeToolPrompt()};
  auto outputs = model->processPromptBatch(prompts);

  ASSERT_EQ(outputs.size(), 2u);
  EXPECT_FALSE(outputs[0].empty());
  EXPECT_FALSE(outputs[1].empty());
}

TEST_F(
    ContinuousBatchingIntegrationTest, TwoPromptBatchQwen3ClosesThinkBlocks) {
  REQUIRE_MODEL(qwen3Model_);
  config_["ctx_size"] = "4096";
  config_["n_predict"] = "512";
  auto model = loadModel(qwen3Model_);

  std::vector<LlamaModel::Prompt> prompts{
      makePrompt(
          "Think briefly, then answer exactly with the final word: BLUE."),
      makePrompt(
          "Think briefly, then answer exactly with the final word: GREEN.")};
  auto outputs = model->processPromptBatch(prompts);

  ASSERT_EQ(outputs.size(), 2u);
  EXPECT_FALSE(hasUnclosedThinkBlock(outputs[0])) << outputs[0];
  EXPECT_FALSE(hasUnclosedThinkBlock(outputs[1])) << outputs[1];
  EXPECT_TRUE(containsCaseInsensitive(outputs[0], "BLUE")) << outputs[0];
  EXPECT_TRUE(containsCaseInsensitive(outputs[1], "GREEN")) << outputs[1];
}

TEST_F(ContinuousBatchingIntegrationTest, TwoPromptBatchHarmonyToolCalls) {
  REQUIRE_MODEL(harmonyModel_);
  config_["ctx_size"] = "4096";
  config_["n_predict"] = "128";
  config_["tools"] = "true";
  auto model = loadModel(harmonyModel_);

  std::vector<LlamaModel::Prompt> prompts{makeToolPrompt(), makeToolPrompt()};
  auto outputs = model->processPromptBatch(prompts);

  ASSERT_EQ(outputs.size(), 2u);
  EXPECT_FALSE(outputs[0].empty());
  EXPECT_FALSE(outputs[1].empty());
  EXPECT_TRUE(
      containsCaseInsensitive(outputs[0], "get_weather") ||
      outputs[0].find("<|call|>") != std::string::npos)
      << outputs[0];
  EXPECT_TRUE(
      containsCaseInsensitive(outputs[1], "get_weather") ||
      outputs[1].find("<|call|>") != std::string::npos)
      << outputs[1];
}

TEST_F(ContinuousBatchingIntegrationTest, TwoPromptBatchSavesAndLoadsCache) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();
  const fs::path cachePath =
      fs::temp_directory_path() / ("batch-cache-" + uniqueTestId() + ".bin");

  auto cachedPrompt = makePrompt("Remember this setup.");
  cachedPrompt.prefill = true;
  cachedPrompt.cacheKey = cachePath.string();
  cachedPrompt.saveCacheToDisk = true;
  std::vector<LlamaModel::Prompt> prompts{
      makePrompt("Say plain text."), std::move(cachedPrompt)};

  auto outputs = model->processPromptBatch(prompts);

  ASSERT_EQ(outputs.size(), 2u);
  EXPECT_FALSE(outputs[0].empty());
  EXPECT_TRUE(outputs[1].empty());
  ASSERT_TRUE(fs::exists(cachePath));
  EXPECT_GT(fs::file_size(cachePath), 0u);

  auto cachedFollowup = makePrompt("Say cached follow up.");
  cachedFollowup.cacheKey = cachePath.string();
  std::vector<LlamaModel::Prompt> followupPrompts{
      makePrompt("Say plain text again."), std::move(cachedFollowup)};
  auto followupOutputs = model->processPromptBatch(followupPrompts);

  ASSERT_EQ(followupOutputs.size(), 2u);
  EXPECT_FALSE(followupOutputs[0].empty());
  EXPECT_FALSE(followupOutputs[1].empty());

  fs::remove(cachePath);
}

/// Two prompts in ONE batch that save to the SAME non-empty `cacheKey`
/// would clobber each other on disk (last-writer-wins, no per-prompt
/// isolation). The scheduler cannot resolve which writer should win, so
/// the batch must be rejected up front with `InvalidArgument` rather than
/// silently corrupting one prompt's cache.
TEST_F(
    ContinuousBatchingIntegrationTest, DuplicateSaveCacheKeyInBatchIsRejected) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();

  const fs::path shared =
      fs::temp_directory_path() / ("dupe-shared-" + uniqueTestId() + ".bin");

  auto a = makePrompt("Remember this short setup.");
  a.cacheKey = shared.string();
  a.saveCacheToDisk = true;
  auto b = makePrompt("Say several words about the sky.");
  b.cacheKey = shared.string();
  b.saveCacheToDisk = true;
  std::vector<LlamaModel::Prompt> batch{std::move(a), std::move(b)};

  try {
    model->processPromptBatch(batch);
    FAIL() << "expected processPromptBatch to reject duplicate save cacheKey";
  } catch (const qvac_errors::StatusError& e) {
    EXPECT_NE(
        e.codeString().find(
            toString(qvac_errors::general_error::InvalidArgument)),
        std::string::npos);
  }

  // The guard runs before scheduling, so nothing is written to disk.
  EXPECT_FALSE(fs::exists(shared));
  fs::remove(shared);
}

/// Sharing the same non-empty `cacheKey` for READ-only prompts (no
/// `saveCacheToDisk`) is a legitimate cache-warming pattern and must NOT
/// be rejected: no writer means no clobber.
TEST_F(
    ContinuousBatchingIntegrationTest,
    DuplicateReadOnlyCacheKeyInBatchIsAllowed) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();

  const fs::path shared =
      fs::temp_directory_path() / ("shared-read-" + uniqueTestId() + ".bin");

  // Seed a cache file once, then have two prompts read it concurrently.
  auto seed = makePrompt("Remember this short setup.");
  seed.prefill = true;
  seed.cacheKey = shared.string();
  seed.saveCacheToDisk = true;
  std::vector<LlamaModel::Prompt> seedBatch{std::move(seed)};
  model->processPromptBatch(seedBatch);
  ASSERT_TRUE(fs::exists(shared));

  auto a = makePrompt("Say plain text.");
  a.cacheKey = shared.string();
  auto b = makePrompt("Say more plain text.");
  b.cacheKey = shared.string();
  std::vector<LlamaModel::Prompt> batch{std::move(a), std::move(b)};

  auto outputs = model->processPromptBatch(batch);
  ASSERT_EQ(outputs.size(), 2u);
  EXPECT_FALSE(outputs[0].empty());
  EXPECT_FALSE(outputs[1].empty());

  fs::remove(shared);
}

TEST_F(ContinuousBatchingIntegrationTest, BatchCancelUsesPolicyAndSavesCache) {
  REQUIRE_MODEL(model_);
  config_["n_predict"] = "128";
  auto model = loadModel();
  const fs::path cachePath = fs::temp_directory_path() /
                             ("batch-cancel-cache-" + uniqueTestId() + ".bin");

  std::atomic<bool> cancelOnce = false;
  auto cachedPrompt = makePrompt(
      "Write several sentences about astronomy so cancellation happens during "
      "generation.");
  cachedPrompt.cacheKey = cachePath.string();
  cachedPrompt.saveCacheToDisk = true;
  cachedPrompt.outputCallback = [&model, &cancelOnce](const std::string&) {
    bool expected = false;
    if (cancelOnce.compare_exchange_strong(expected, true)) {
      model->cancel();
    }
  };

  std::vector<LlamaModel::Prompt> prompts{
      std::move(cachedPrompt),
      makePrompt("Write several sentences about ocean currents.")};
  auto outputs = model->processPromptBatch(prompts);

  ASSERT_EQ(outputs.size(), 2u);
  EXPECT_TRUE(cancelOnce.load());
  ASSERT_TRUE(fs::exists(cachePath));
  EXPECT_GT(fs::file_size(cachePath), 0u);

  auto followup = makePrompt("Continue after the cancelled turn.");
  followup.cacheKey = cachePath.string();
  std::vector<LlamaModel::Prompt> followupPrompts{std::move(followup)};
  auto followupOutputs = model->processPromptBatch(followupPrompts);

  ASSERT_EQ(followupOutputs.size(), 1u);
  EXPECT_FALSE(followupOutputs[0].empty());

  fs::remove(cachePath);
}

/// Cancel-all (`model.cancel()`) must cancel BOTH the actively-decoding
/// slots and the prompts still queued in `pending_` (the overflow beyond
/// `parallel`). Regression for the leak where, after the active slots are
/// freed, `workerLoop()` admitted the queued prompts and ran them to
/// completion *after* the cancel — so cancelled work kept generating.
///
/// Setup: `parallel = 2` with 6 prompts, so 4 sit in `pending_`. The first
/// emitted token (necessarily from an active slot) triggers `cancel()`. If
/// any *pending* prompt then emits a token, it was admitted and run after
/// the cancel — the bug. With the fix the queued prompts are drained as
/// cancelled and never generate.
TEST_F(ContinuousBatchingIntegrationTest, CancelAllAlsoCancelsPendingPrompts) {
  REQUIRE_MODEL(model_);
  config_["parallel"] = "2";
  config_["n_predict"] = "64";
  auto model = loadModel();

  constexpr size_t kParallel = 2;
  constexpr size_t kPromptCount = 6; // 4 prompts overflow into pending_

  std::atomic<bool> cancelFired = false;
  std::atomic<bool> pendingRanAfterCancel = false;

  std::vector<LlamaModel::Prompt> prompts;
  for (size_t i = 0; i < kPromptCount; ++i) {
    auto p = makePrompt(
        "Write a long, detailed paragraph about the history of astronomy.");
    const bool isPending = i >= kParallel;
    p.outputCallback = [&model,
                        &cancelFired,
                        &pendingRanAfterCancel,
                        isPending](const std::string&) {
      // First token (from an active slot) requests a cancel-all.
      bool expected = false;
      if (cancelFired.compare_exchange_strong(expected, true)) {
        model->cancel();
        return;
      }
      // A queued (overflow) prompt that emits *after* the cancel was
      // requested proves it was admitted and run post-cancel.
      if (isPending && cancelFired.load()) {
        pendingRanAfterCancel.store(true);
      }
    };
    prompts.push_back(std::move(p));
  }

  // Cancel-all reports the un-run queued prompts by throwing `Cancelled`
  // (see CancelAllThrowsForUnrunPendingPrompts); this test only cares that
  // none of those queued prompts actually executed, which holds whether the
  // call throws or returns.
  try {
    model->processPromptBatch(prompts);
  } catch (const qvac_errors::StatusError&) {
    // expected once the pending prompts are surfaced as cancelled
  }

  ASSERT_TRUE(cancelFired.load())
      << "test setup: no token was emitted, so cancel never fired";
  EXPECT_FALSE(pendingRanAfterCancel.load())
      << "CANCEL-ALL LEAK: a queued (pending_) prompt generated tokens after "
         "model.cancel(); cancel-all freed the active slots and then admitted "
         "the overflow prompts instead of cancelling them.";
}

/// Cancel-all must surface the queued prompts that never got a chance to
/// run as an error, not as silently-successful empty outputs. In-flight
/// slots are cancelled gracefully (partial output, no throw), but a prompt
/// still sitting in `pending_` produced nothing because it was cancelled
/// before admission — that is a cancellation, and the batch call must throw
/// `Cancelled` rather than return empty strings that look like success.
///
/// Setup mirrors CancelAllAlsoCancelsPendingPrompts: `parallel = 2` with 6
/// prompts so 4 are queued; the first emitted token triggers `cancel()`.
TEST_F(
    ContinuousBatchingIntegrationTest, CancelAllThrowsForUnrunPendingPrompts) {
  REQUIRE_MODEL(model_);
  config_["parallel"] = "2";
  config_["n_predict"] = "64";
  auto model = loadModel();

  constexpr size_t kPromptCount = 6; // 4 prompts overflow into pending_
  std::atomic<bool> cancelFired = false;

  std::vector<LlamaModel::Prompt> prompts;
  for (size_t i = 0; i < kPromptCount; ++i) {
    auto p = makePrompt(
        "Write a long, detailed paragraph about the history of astronomy.");
    p.outputCallback = [&model, &cancelFired](const std::string&) {
      bool expected = false;
      if (cancelFired.compare_exchange_strong(expected, true)) {
        model->cancel();
      }
    };
    prompts.push_back(std::move(p));
  }

  try {
    model->processPromptBatch(prompts);
    FAIL() << "expected cancel-all to throw for queued prompts that never ran "
              "instead of returning empty success outputs";
  } catch (const qvac_errors::StatusError& e) {
    EXPECT_NE(e.codeString().find("Cancelled"), std::string::npos)
        << "expected a Cancelled error code, got: " << e.codeString();
  }
  EXPECT_TRUE(cancelFired.load())
      << "test setup: no token was emitted, so cancel never fired";
}

TEST_F(ContinuousBatchingIntegrationTest, TwoPromptBatchAcceptsPrefillOnly) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();

  auto prefillPrompt = makePrompt("Remember this setup.");
  prefillPrompt.prefill = true;
  std::vector<LlamaModel::Prompt> prompts{
      makePrompt("Say plain text."), std::move(prefillPrompt)};

  auto outputs = model->processPromptBatch(prompts);

  ASSERT_EQ(outputs.size(), 2u);
  EXPECT_FALSE(outputs[0].empty());
  EXPECT_TRUE(outputs[1].empty());
}

/// Two-stage batch test for prefill-only + cache lifecycle.
/// Stage 1: a 2-prompt batch where both slots are `prefill=true` with
/// distinct `saveCacheToDisk` cache keys. Asserts both outputs are
/// empty and both cache files are written, exercising the
/// `onSequenceEnd` -> `saveCache` path on prefill-only slots
/// concurrently. Stage 2: a follow-up 2-prompt batch with generation
/// slots keyed by those same cache files. Asserts both follow-ups
/// produce the expected concrete answers ("Paris", "Moon"), proving
/// the persisted KV-cache is loadable and usable per-slot.
TEST_F(ContinuousBatchingIntegrationTest, PrefillOnlyBatchSavesAndLoadsCache) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();
  const std::string testId = uniqueTestId();
  const fs::path cachePathA =
      fs::temp_directory_path() / ("batch-prefill-A-" + testId + ".bin");
  const fs::path cachePathB =
      fs::temp_directory_path() / ("batch-prefill-B-" + testId + ".bin");

  auto prefillA = makePrompt(
      "The capital of France is Paris. Remember this fact for later use.");
  prefillA.prefill = true;
  prefillA.cacheKey = cachePathA.string();
  prefillA.saveCacheToDisk = true;

  auto prefillB = makePrompt(
      "Earth's natural satellite is the Moon. Remember this fact for later "
      "use.");
  prefillB.prefill = true;
  prefillB.cacheKey = cachePathB.string();
  prefillB.saveCacheToDisk = true;

  std::vector<LlamaModel::Prompt> prefillBatch;
  prefillBatch.push_back(std::move(prefillA));
  prefillBatch.push_back(std::move(prefillB));
  auto prefillOutputs = model->processPromptBatch(prefillBatch);

  ASSERT_EQ(prefillOutputs.size(), 2u);
  EXPECT_TRUE(prefillOutputs[0].empty()) << prefillOutputs[0];
  EXPECT_TRUE(prefillOutputs[1].empty()) << prefillOutputs[1];
  ASSERT_TRUE(fs::exists(cachePathA));
  ASSERT_TRUE(fs::exists(cachePathB));
  EXPECT_GT(fs::file_size(cachePathA), 0u);
  EXPECT_GT(fs::file_size(cachePathB), 0u);

  auto followupA = makePrompt(
      "Given what you remember, what is the capital of France? Answer in one "
      "word.");
  followupA.cacheKey = cachePathA.string();
  auto followupB = makePrompt(
      "Given what you remember, what is Earth's natural satellite? Answer in "
      "one word.");
  followupB.cacheKey = cachePathB.string();

  std::vector<LlamaModel::Prompt> followupBatch;
  followupBatch.push_back(std::move(followupA));
  followupBatch.push_back(std::move(followupB));
  auto followupOutputs = model->processPromptBatch(followupBatch);

  ASSERT_EQ(followupOutputs.size(), 2u);
  EXPECT_TRUE(containsCaseInsensitive(followupOutputs[0], "Paris"))
      << "expected 'Paris' from cache A in: " << followupOutputs[0];
  EXPECT_TRUE(containsCaseInsensitive(followupOutputs[1], "Moon"))
      << "expected 'Moon' from cache B in: " << followupOutputs[1];

  fs::remove(cachePathA);
  fs::remove(cachePathB);
}

/// Cancel-all issued while the scheduler is idle must be a no-op for
/// future work. `requestCancelAll()` only sets `cancelRequested_`; with no
/// worker running to consume it, the flag goes stale and the first batch
/// submitted afterwards is drained as Cancelled before it ever runs.
TEST_F(ContinuousBatchingIntegrationTest, IdleCancelDoesNotCancelNextBatch) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();

  model->cancel();

  std::vector<LlamaModel::Prompt> prompts{
      makePrompt("What is the capital of France? Answer in one word.")};
  auto outputs = model->processPromptBatch(prompts);

  ASSERT_EQ(outputs.size(), 1u);
  EXPECT_TRUE(containsCaseInsensitive(outputs[0], "Paris"))
      << "STALE CANCEL FLAG: a cancel issued while the scheduler was idle "
         "cancelled the next batch; output: "
      << outputs[0];
}

/// Cancelling batch work must not leak into single-prompt mode. Cancel-all
/// also stopped the single-prompt `llmContext_`, whose `stopGeneration_`
/// flag is consumed only by the next single prompt — which then aborts
/// during prompt eval and returns empty output.
TEST_F(
    ContinuousBatchingIntegrationTest,
    BatchCancelDoesNotPoisonNextSinglePrompt) {
  REQUIRE_MODEL(model_);
  config_["n_predict"] = "128";
  auto model = loadModel();

  std::atomic<bool> cancelOnce = false;
  auto prompt = makePrompt(
      "Write several sentences about astronomy so cancellation happens "
      "during generation.");
  prompt.outputCallback = [&model, &cancelOnce](const std::string&) {
    bool expected = false;
    if (cancelOnce.compare_exchange_strong(expected, true)) {
      model->cancel();
    }
  };
  std::vector<LlamaModel::Prompt> prompts{std::move(prompt)};
  auto outputs = model->processPromptBatch(prompts);
  ASSERT_EQ(outputs.size(), 1u);
  ASSERT_TRUE(cancelOnce.load());

  const std::string single = model->processPrompt(
      makePrompt("What is the capital of France? Answer in one word."));
  EXPECT_TRUE(containsCaseInsensitive(single, "Paris"))
      << "STALE STOP FLAG: cancelling batch work poisoned the idle "
         "single-prompt context; single prompt returned: '"
      << single << "'";
}

/// When llama_decode returns non-zero, processBatch must throw a
/// StatusError(FailedToDecode) for every group. Before the fix the decode-error
/// branch called finalizeFinishedSequences() which routed through the success
/// path (completeGroupRequestLocked), leaving group->error == null.
/// processBatch then unblocked and returned silently with empty/partial outputs
/// instead of propagating the error.
///
/// The test injects a stub decode function that always returns 1, triggers one
/// batch step, and asserts the resulting exception carries the FailedToDecode
/// error code rather than an empty-output success.
TEST_F(
    ContinuousBatchingIntegrationTest, BatchDecodeErrorThrowsFailedToDecode) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();

  auto* scheduler = LlamaModelTestPeer::scheduler(*model);
  ASSERT_NE(scheduler, nullptr)
      << "LlamaModelTestPeer::scheduler returned null -- is parallel >= 2?";

  ContinuousBatchSchedulerTestPeer::setDecodeFunc(
      *scheduler, [](llama_context*, llama_batch&) -> int { return 1; });

  std::vector<LlamaModel::Prompt> prompts{
      makePrompt("What is the capital of France? Answer in one word."),
      makePrompt(
          "What is the natural satellite of Earth? Answer in one word.")};

  try {
    model->processPromptBatch(prompts);
    FAIL() << "DECODE ERROR BUG: processPromptBatch returned successfully even "
              "though llama_decode was injected to fail. Expected a "
              "FailedToDecode StatusError.";
  } catch (const qvac_errors::StatusError& e) {
    EXPECT_NE(e.codeString().find("FailedToDecode"), std::string::npos)
        << "expected FailedToDecode in error code, got: " << e.codeString();
  }
}

/// Reproduce bug: A per-slot cancel that lands while `stepLocked()` has
/// released the scheduler mutex (around media eval / llama_decode) is recorded
/// in `pendingSlotCancels_` and only applied at the *next* worker-loop top.
/// Before the fix, the same step then advances/samples the still-present slot,
/// so the cancelled sequence streams one more token after cancellation. The
/// reviewer flagged the media-eval window; the decode window shares the exact
/// defect and is the one reachable deterministically here, since the cancel is
/// issued from inside the injected decode stub -- which runs in that very
/// unlock window. The RAII relock-guard fix reconciles deferred teardown on
/// every lock reacquisition, closing both windows.
TEST_F(
    ContinuousBatchingIntegrationTest,
    PerSlotCancelInUnlockWindowDoesNotStreamAfterTeardown) {
  REQUIRE_MODEL(model_);
  config_["parallel"] = "2";
  config_["n_predict"] = "64";
  auto model = loadModel();

  auto* scheduler = LlamaModelTestPeer::scheduler(*model);
  ASSERT_NE(scheduler, nullptr)
      << "LlamaModelTestPeer::scheduler returned null -- is parallel >= 2?";

  // Second admitted prompt; admission is in submission order so it owns
  // seqId 1.
  constexpr uint32_t kCancelSeqId = 1;

  std::atomic<int> seqBTokens = 0;
  std::atomic<bool> readyToCancel = false;
  std::atomic<bool> cancelIssued = false;
  std::atomic<bool> streamedAfterCancel = false;

  // The stub runs while stepLocked() holds no lock -- the same window a
  // concurrent caller's cancel() would hit. Issuing the cancel here records it
  // as deferred teardown, then delegates to the real decode so generation
  // continues.
  ContinuousBatchSchedulerTestPeer::setDecodeFunc(
      *scheduler,
      [scheduler, &readyToCancel, &cancelIssued](
          llama_context* ctx, llama_batch& batch) {
        if (readyToCancel.load() && !cancelIssued.exchange(true)) {
          scheduler->cancel(kCancelSeqId);
        }
        return llama_decode(ctx, batch);
      });

  auto promptA =
      makePrompt("Write a long, detailed paragraph about redwood forests.");
  auto promptB =
      makePrompt("Write a long, detailed paragraph about coral reefs.");
  // Arm the cancel only once seqId 1 is actively generating (>= 2 streamed
  // tokens), so the step that observes the deferred cancel would otherwise
  // sample and stream another token for it.
  promptB.outputCallback = [&seqBTokens,
                            &readyToCancel,
                            &cancelIssued,
                            &streamedAfterCancel](const std::string&) {
    if (cancelIssued.load()) {
      streamedAfterCancel.store(true);
    }
    if (seqBTokens.fetch_add(1) + 1 >= 2) {
      readyToCancel.store(true);
    }
  };

  std::vector<LlamaModel::Prompt> prompts{
      std::move(promptA), std::move(promptB)};
  auto outputs = model->processPromptBatch(prompts);

  ASSERT_EQ(outputs.size(), 2u);
  ASSERT_TRUE(cancelIssued.load())
      << "test setup: seqId 1 never reached the cancel arming point";
  EXPECT_FALSE(streamedAfterCancel.load())
      << "DEFERRED-TEARDOWN LEAK: seqId " << kCancelSeqId
      << " streamed a token after a cancel recorded during the decode unlock "
         "window. stepLocked() advanced/sampled the slot before "
         "applyDeferredTeardownLocked() ran; teardown must be reconciled on "
         "lock reacquisition.";
}

/// A per-slot cancel runs the slot's driver teardown -- onCancel + saveCache --
/// from the noexcept StepUnlockGuard destructor (a cancel issued in the decode
/// unlock window is applied on lock reacquisition). When saveCache throws --
/// here forced by an unwritable cacheKey -- the throw must be swallowed in
/// place: before the fix it escaped the noexcept destructor and
/// std::terminate'd the whole process. The batch must instead survive: the
/// cancelled slot is freed, its group completes, and the sibling sequence still
/// finishes normally.
TEST_F(
    ContinuousBatchingIntegrationTest,
    PerSlotCancelSwallowsThrowingDriverTeardown) {
  REQUIRE_MODEL(model_);
  config_["parallel"] = "2";
  config_["n_predict"] = "64";
  auto model = loadModel();

  auto* scheduler = LlamaModelTestPeer::scheduler(*model);
  ASSERT_NE(scheduler, nullptr)
      << "LlamaModelTestPeer::scheduler returned null -- is parallel >= 2?";

  // Admission is in submission order, so the second prompt owns seqId 1.
  constexpr uint32_t kCancelSeqId = 1;

  std::atomic<int> seqBTokens = 0;
  std::atomic<bool> readyToCancel = false;
  std::atomic<bool> cancelIssued = false;
  std::atomic<bool> cancelHitOccupied = false;

  // Issue the cancel from inside the decode unlock window so its teardown runs
  // in the StepUnlockGuard destructor, then delegate to the real decode so the
  // surviving sequence keeps generating. Capture cancel()'s return: it is true
  // only when seqId 1 was still occupied, i.e. the throwing teardown actually
  // ran. Without it the test could pass vacuously when the slot finished first
  // and the cancel was a no-op.
  ContinuousBatchSchedulerTestPeer::setDecodeFunc(
      *scheduler,
      [scheduler, &readyToCancel, &cancelIssued, &cancelHitOccupied](
          llama_context* ctx, llama_batch& batch) {
        if (readyToCancel.load() && !cancelIssued.exchange(true)) {
          cancelHitOccupied.store(scheduler->cancel(kCancelSeqId));
        }
        return llama_decode(ctx, batch);
      });

  // cacheKey under a directory that does not exist: llama_state_seq_save_file
  // cannot open it, so TextLlmContext::saveCache throws on the cancel path.
  const fs::path unwritable = fs::temp_directory_path() /
                              ("no-such-dir-" + uniqueTestId()) / "cache.bin";
  ASSERT_FALSE(fs::exists(unwritable.parent_path()))
      << "precondition: the cacheKey's parent dir must be absent so saveCache "
         "throws on the cancel path";

  auto promptA =
      makePrompt("Write a long, detailed paragraph about redwood forests.");
  auto promptB =
      makePrompt("Write a long, detailed paragraph about coral reefs.");
  promptB.cacheKey = unwritable.string();
  promptB.saveCacheToDisk = true;
  // Arm the cancel as soon as seqId 1 streams its first token: the cancel then
  // lands on the very next decode, leaving essentially no window for the slot
  // to finish naturally first (which would instead hit the deliberately
  // throwing normal-completion save path and fail the whole batch).
  promptB.outputCallback = [&seqBTokens, &readyToCancel](const std::string&) {
    seqBTokens.fetch_add(1);
    readyToCancel.store(true);
  };

  std::vector<LlamaModel::Prompt> prompts{
      std::move(promptA), std::move(promptB)};
  // Returning from this call at all proves the throwing teardown did not
  // std::terminate the process.
  auto outputs = model->processPromptBatch(prompts);

  ASSERT_EQ(outputs.size(), 2u);
  ASSERT_TRUE(cancelIssued.load())
      << "test setup: seqId 1 never reached the cancel arming point";
  ASSERT_TRUE(cancelHitOccupied.load())
      << "cancel must hit the still-occupied seqId 1 so the throwing saveCache "
         "teardown actually runs; false means the slot finished first and the "
         "teardown path was never exercised";
  EXPECT_FALSE(outputs[0].empty())
      << "sibling sequence (seqId 0) must finish normally despite the throwing "
         "teardown on seqId 1";
}

/// A batched sequence that outgrows its per-slot window (ctx / n_parallel)
/// must slide (`contextSlides > 0`) and keep generating, like the
/// single-prompt path does, instead of being hard-truncated at the window.
/// `CacheTokens` must reflect the generated tokens, not just the prompt.
///
/// The slide machinery reads the driver's `nPast_`, but during batched
/// generation only the batcher's `Request::currentPos` advances; `nPast_`
/// stays frozen at the prompt length, so the slide condition never fires
/// and `Request::exceededLimit()` truncates the sequence first.
///
/// Setup: ctx 256 with parallel 2 targets a small per-slot window;
/// n_predict -1 (unbounded) so admission does not cap the request, and
/// n_discarded 32 enables sliding. llama.cpp's memory-fit step may
/// adjust the requested ctx, so the effective window is read back via
/// the decode stub (`llama_n_ctx / parallel`). The prompt elicits an
/// output long enough to cross the window; once enough pieces stream
/// out to prove generation survived past it, the test cancels to bound
/// the run.
TEST_F(
    ContinuousBatchingIntegrationTest, BatchGenerationSlidesPastPerSlotWindow) {
  REQUIRE_MODEL(model_);
  constexpr size_t kParallel = 2;
  config_["ctx_size"] = "256";
  config_["parallel"] = std::to_string(kParallel);
  config_["n_predict"] = "-1";
  config_["n_discarded"] = "32";
  auto model = loadModel();

  auto* scheduler = LlamaModelTestPeer::scheduler(*model);
  ASSERT_NE(scheduler, nullptr);
  std::atomic<size_t> perSlotWindow = 0;
  ContinuousBatchSchedulerTestPeer::setDecodeFunc(
      *scheduler, [&perSlotWindow](llama_context* ctx, llama_batch& batch) {
        perSlotWindow.store(static_cast<size_t>(llama_n_ctx(ctx)) / kParallel);
        return llama_decode(ctx, batch);
      });

  std::atomic<size_t> pieces = 0;
  std::atomic<bool> cancelOnce = false;
  auto prompt = makePrompt(
      "Count upward from 1, one number per line, and do not stop counting.");
  prompt.outputCallback = [&model, &pieces, &perSlotWindow, &cancelOnce](
                              const std::string&) {
    // Pieces under-count tokens (UTF-8 buffering), so once the piece
    // count alone exceeds the whole per-slot window, prompt + generated
    // tokens crossed it for sure.
    constexpr size_t kPastWindowMargin = 32;
    const size_t window = perSlotWindow.load();
    if (window > 0 && pieces.fetch_add(1) + 1 >= window + kPastWindowMargin) {
      bool expected = false;
      if (cancelOnce.compare_exchange_strong(expected, true)) {
        model->cancel();
      }
    }
  };

  std::vector<LlamaModel::Prompt> prompts{std::move(prompt)};
  auto outputs = model->processPromptBatch(prompts);
  const auto stats = model->runtimeStats();
  const double contextSlides =
      test_common::getStatValue(stats, "contextSlides");
  const double cacheTokens = test_common::getStatValue(stats, "CacheTokens");
  const double promptTokens = test_common::getStatValue(stats, "promptTokens");

  ASSERT_EQ(outputs.size(), 1u);
  EXPECT_FALSE(outputs[0].empty());
  EXPECT_GT(contextSlides, 0.0)
      << "SLIDE NEVER FIRED: the sequence was truncated at the per-slot "
         "window instead of sliding; pieces emitted: "
      << pieces.load() << ", per-slot window: " << perSlotWindow.load();
  EXPECT_GT(cacheTokens, promptTokens)
      << "CacheTokens only counted the prompt (driver position frozen at "
         "prefill); generated tokens are missing from the stat";
}

namespace {

/// Drives one batch on a background thread and blocks the first
/// llama_decode (after it actually ran) so the test can observe how
/// scheduler APIs behave while a decode is in flight. The scheduler's
/// worker releases its mutex across the decode, so calls like
/// cancel(seqId)/clear() CAN acquire it mid-decode; they must defer any
/// mutation of the shared llama_context until the step finishes.
class BlockedDecodeHarness {
public:
  explicit BlockedDecodeHarness(
      LlamaModel& model,
      qvac_lib_inference_addon_llama::batching::ContinuousBatchScheduler&
          scheduler)
      : model_(model) {
    ContinuousBatchSchedulerTestPeer::setDecodeFunc(
        scheduler, [this](llama_context* ctx, llama_batch& batch) {
          const int rc = llama_decode(ctx, batch);
          if (decodeCalls_.fetch_add(1) == 0) {
            decodeInFlight_.store(true);
            while (!releaseDecode_.load()) {
              std::this_thread::sleep_for(std::chrono::milliseconds(1));
            }
            decodeInFlight_.store(false);
          }
          return rc;
        });
  }

  ~BlockedDecodeHarness() {
    releaseDecode_.store(true);
    if (future_.valid()) {
      future_.wait();
    }
  }

  void startBatch(const std::string& userText) {
    future_ = std::async(std::launch::async, [this, userText] {
      LlamaModel::Prompt prompt;
      prompt.input = R"([{"role":"user","content":")" + userText + R"("}])";
      std::vector<LlamaModel::Prompt> prompts{std::move(prompt)};
      return model_.processPromptBatch(prompts);
    });
  }

  [[nodiscard]] bool waitForBlockedDecode() {
    const auto deadline =
        std::chrono::steady_clock::now() + std::chrono::seconds(30);
    while (!decodeInFlight_.load() &&
           std::chrono::steady_clock::now() < deadline) {
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return decodeInFlight_.load();
  }

  std::vector<std::string> releaseAndFinish() {
    releaseDecode_.store(true);
    return future_.get();
  }

private:
  LlamaModel& model_;
  std::future<std::vector<std::string>> future_;
  std::atomic<int> decodeCalls_ = 0;
  std::atomic<bool> decodeInFlight_ = false;
  std::atomic<bool> releaseDecode_ = false;
};

} // namespace

/// cancel(seqId) acquires the scheduler mutex that the worker releases
/// across llama_decode, then mutates the shared llama_context
/// (onCancel -> removeLastNTokens, llama_memory_seq_rm). Applied
/// mid-decode that is a data race on the context. The safe contract:
/// the call may only REQUEST cancellation; the slot must stay occupied
/// until the worker applies it after the in-flight step.
TEST_F(
    ContinuousBatchingIntegrationTest,
    CancelSeqIsNotAppliedWhileDecodeInFlight) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();
  auto* scheduler = LlamaModelTestPeer::scheduler(*model);
  ASSERT_NE(scheduler, nullptr);

  BlockedDecodeHarness harness(*model, *scheduler);
  harness.startBatch("Write a short paragraph about redwood forests.");
  ASSERT_TRUE(harness.waitForBlockedDecode())
      << "test setup: decode never started";

  const bool wasActive = scheduler->cancel(0);
  EXPECT_TRUE(wasActive);
  EXPECT_EQ(scheduler->numActive(), 1u)
      << "RACE: cancel(seqId) mutated scheduler/llama_context state while "
         "llama_decode was still in flight (mutex_ is released across the "
         "decode); it must be deferred to the worker";

  auto outputs = harness.releaseAndFinish();
  ASSERT_EQ(outputs.size(), 1u);
  EXPECT_EQ(scheduler->numActive(), 0u)
      << "deferred cancel was never applied after the decode finished";
}

/// Same contract as above for clear(): it must not tear down slots (and
/// touch the llama_context) while the worker is mid-decode.
TEST_F(
    ContinuousBatchingIntegrationTest, ClearIsNotAppliedWhileDecodeInFlight) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();
  auto* scheduler = LlamaModelTestPeer::scheduler(*model);
  ASSERT_NE(scheduler, nullptr);

  BlockedDecodeHarness harness(*model, *scheduler);
  harness.startBatch("Write a short paragraph about coral reefs.");
  ASSERT_TRUE(harness.waitForBlockedDecode())
      << "test setup: decode never started";

  scheduler->clear();
  EXPECT_EQ(scheduler->numActive(), 1u)
      << "RACE: clear() tore down slots and touched the llama_context while "
         "llama_decode was still in flight (mutex_ is released across the "
         "decode); it must be deferred to the worker";

  auto outputs = harness.releaseAndFinish();
  ASSERT_EQ(outputs.size(), 1u);
  EXPECT_EQ(scheduler->numActive(), 0u)
      << "deferred clear was never applied after the decode finished";
}

namespace {

/// Reads the elephant.jpg VLM fixture from the package `media/` dir. The
/// C++ tests run either from the package root or from build/test/unit, so
/// both relative roots are probed (mirroring BaseTestModelPath). The batch
/// media path takes the image as raw bytes in Prompt::media; the chat input
/// carries a matching media marker message so tokenization lines up.
std::vector<uint8_t> readElephantImage() {
  for (const char* candidate :
       {"../../../media/elephant.jpg", "media/elephant.jpg"}) {
    std::ifstream file(candidate, std::ios::binary);
    if (file) {
      return {
          std::istreambuf_iterator<char>(file),
          std::istreambuf_iterator<char>()};
    }
  }
  return {};
}

} // namespace

/// A media-segment eval that throws mid-batch must fail only its own
/// request and leave the scheduler servicing everything else.
/// serviceNextMediaSegmentLocked wraps evalMediaSegment in try/catch and
/// routes a throw to failSlotLocked (which fails just that slot's group);
/// the worker loop never sees the exception, so sibling requests in other
/// groups keep running and the scheduler stays alive.
///
/// Without the eval-media seam (ContinuousBatchSchedulerTestPeer::
/// setEvalMediaFunc) this path was unverifiable: the
/// scheduler builds its own real MtmdLlmContext drivers, so there was no
/// seam to force one slot's evalMediaSegment to throw short of corrupting a
/// real image. The injected throw stands in for a real mtmd encode failure.
TEST_F(
    ContinuousBatchingIntegrationTest, MediaEvalFailureFailsOnlyThatRequest) {
  const std::string vlmPath = test_common::BaseTestModelPath::get(
      "SmolVLM-500M-Instruct-Q8_0.gguf", "SmolVLM-500M-Instruct.gguf");
  const std::string mmprojPath = test_common::BaseTestModelPath::get(
      "mmproj-SmolVLM-500M-Instruct-Q8_0.gguf",
      "mmproj-SmolVLM-500M-Instruct.gguf");
  if (!fs::exists(vlmPath) || !fs::exists(mmprojPath)) {
    GTEST_SKIP() << "SmolVLM multimodal model/projection not found";
  }
  const std::vector<uint8_t> image = readElephantImage();
  ASSERT_FALSE(image.empty()) << "elephant.jpg media fixture not found";

  std::string path = vlmPath;
  std::string projection = mmprojPath;
  auto cfg = config_;
  // Long generation so the text slot is still decoding when the media barrier
  // throws; widened ctx_size avoids an unrelated context-overflow stop.
  cfg["ctx_size"] = "2048";
  cfg["n_predict"] = "200";
  auto model = std::make_unique<LlamaModel>(
      std::move(path), std::move(projection), std::move(cfg));
  model->waitForLoadInitialization();
  ASSERT_TRUE(model->isLoaded());

  auto* scheduler = LlamaModelTestPeer::scheduler(*model);
  ASSERT_NE(scheduler, nullptr)
      << "LlamaModelTestPeer::scheduler returned null -- is parallel >= 2?";

  // Force every media eval to throw (stands in for an mtmd encode failure);
  // capture whether the text sibling is still in flight -- the only state in
  // which per-slot vs whole-scheduler failure is observable.
  std::atomic<bool> textFinished = false;
  std::atomic<bool> mediaEvalInvoked = false;
  std::atomic<bool> textRunningAtThrow = false;
  ContinuousBatchSchedulerTestPeer::setEvalMediaFunc(
      *scheduler, [&](SequenceDriver&, size_t, llama_pos) -> llama_pos {
        mediaEvalInvoked.store(true);
        textRunningAtThrow.store(!textFinished.load());
        throw std::runtime_error("injected media-eval failure");
      });

  // The marker message (empty content) makes formatPrompt insert a media
  // marker into the chat without loading bytes onto the shared context; the
  // per-slot driver loads the actual image from Prompt::media.
  LlamaModel::Prompt mediaPrompt;
  mediaPrompt.input = R"([{"role":"user","type":"media","content":""},)"
                      R"({"role":"user","content":"What is in this image?"}])";
  mediaPrompt.media.push_back(image);

  // Text request (own group) started first with a head start, so it is
  // provably in flight when the media slot's eval throws.
  std::atomic<size_t> textPieces = 0;
  auto textPrompt = makePrompt(
      "Write a long, detailed essay about the history of mathematics.");
  textPrompt.outputCallback = [&textPieces](const std::string&) {
    textPieces.fetch_add(1);
  };
  auto textFuture = std::async(std::launch::async, [&] {
    std::vector<LlamaModel::Prompt> prompts{textPrompt};
    auto outputs = model->processPromptBatch(prompts);
    textFinished.store(true);
    return outputs;
  });
  // Wait until the text slot is actively generating before admitting the
  // media request, so the media barrier throws mid-generation. Bounded so a
  // text request that dies early fails the test instead of hanging it.
  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::seconds(30);
  while (textPieces.load() < 2) {
    ASSERT_LT(std::chrono::steady_clock::now(), deadline)
        << "text slot never started generating; cannot exercise the "
           "media-eval failure overlap";
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }

  auto mediaFuture = std::async(std::launch::async, [&] {
    std::vector<LlamaModel::Prompt> prompts{mediaPrompt};
    return model->processPromptBatch(prompts);
  });

  EXPECT_THROW(mediaFuture.get(), std::exception)
      << "media-eval throw must fail the offending request";
  ASSERT_TRUE(mediaEvalInvoked.load())
      << "media request failed before reaching the injected eval; the "
         "media-eval failure path was never exercised";

  bool textThrew = false;
  std::vector<std::string> textOutputs;
  try {
    textOutputs = textFuture.get();
  } catch (...) {
    textThrew = true;
  }

  // Skip loudly (not a vacuous pass) if timing ever changes so the text slot
  // finished before the throw.
  if (!textRunningAtThrow.load()) {
    GTEST_SKIP() << "text slot had already stopped generating when the media "
                    "barrier threw; overlap not established, so per-slot vs "
                    "whole-scheduler failure is indistinguishable on this run";
  }

  // Text request (own group) must survive: failSlotLocked fails only the
  // media group.
  ASSERT_FALSE(textThrew)
      << "the in-flight text request was killed by the media failure; "
         "failSlotLocked must fail only the offending group and leave the "
         "scheduler running";
  ASSERT_EQ(textOutputs.size(), 1u);
  EXPECT_FALSE(textOutputs[0].empty());
}

// GGSQ unification (sub-tasks 2 + 3): the batch multimodal path must support
// prompt caching on GGSQ. Today MtmdLlmContext::saveCache throws, so a batched
// media prompt with saveCacheToDisk writes no cache and this fails. The fixture
// is Qwen3.5 (M-RoPE, n_pos_per_embd()==4) so a successful save+reload round
// trip actually exercises per-cell llama_kv_cell_ext (x/y) restore — SmolVLM
// (n_pos_per_embd()==1) could not. Its image prefill commits far more KV cells
// (~2899) than positions (~90), so the round trip really exercises the M-RoPE
// per-cell x/y metadata. The reload pass does not just assert the cache loads:
// it asks a follow-up that depends on the cached image and checks the answer
// still names the image subject, so a cache that reloads but restores
// corrupt/incomplete image KV fails. The fixture is fetched on every platform
// by scripts/download-unit-test-models.js; GTEST_SKIP when it is absent.
TEST_F(ContinuousBatchingIntegrationTest, BatchMtmdMRopeCacheRoundTrip) {
  const std::string vlmPath =
      test_common::BaseTestModelPath::get("Qwen3.5-0.8B-Q8_0.gguf");
  const std::string mmprojPath =
      test_common::BaseTestModelPath::get("mmproj-Qwen3.5-0.8B-F16.gguf");
  if (!fs::exists(vlmPath) || !fs::exists(mmprojPath)) {
    GTEST_SKIP() << "Qwen3.5 M-RoPE fixture not found";
  }
  const std::vector<uint8_t> image = readElephantImage();
  ASSERT_FALSE(image.empty()) << "elephant.jpg media fixture not found";

  const fs::path cachePath = fs::temp_directory_path() /
                             ("qwen35-mrope-cache-" + uniqueTestId() + ".bin");

  auto makeModel = [&] {
    std::string path = vlmPath;
    std::string projection = mmprojPath;
    auto cfg = config_;
    // Qwen3.5 image prefill commits ~2899 KV cells (M-RoPE: cells >>
    // positions), so the round trip needs the 4096 the Qwen3.5 mtmd unit tests
    // use.
    cfg["ctx_size"] = "4096";
    // Qwen3.5 is a reasoning model; without this it spends the whole n_predict
    // budget on chain-of-thought and never reaches the one-word answer. 0
    // disables thinking so the subject keyword fits, as the VLM perf tests do.
    cfg["reasoning-budget"] = "0";
    cfg["n_predict"] = "32";
    auto m = std::make_unique<LlamaModel>(
        std::move(path), std::move(projection), std::move(cfg));
    m->waitForLoadInitialization();
    return m;
  };

  auto makeMediaPrompt = [&]() {
    LlamaModel::Prompt p;
    p.input = R"([{"role":"user","type":"media","content":""},)"
              R"({"role":"user","content":"What is in this image?"}])";
    p.media.push_back(image);
    return p;
  };

  // Save pass: prefill the image into a slot and persist the per-slot cache.
  auto saveModel = makeModel();
  ASSERT_TRUE(saveModel->isLoaded());
  auto savePrompt = makeMediaPrompt();
  savePrompt.prefill = true;
  savePrompt.cacheKey = cachePath.string();
  savePrompt.saveCacheToDisk = true;
  std::vector<LlamaModel::Prompt> savePrompts;
  savePrompts.push_back(std::move(savePrompt));

  bool saveThrew = false;
  std::string saveErr;
  try {
    saveModel->processPromptBatch(savePrompts);
  } catch (const std::exception& e) {
    saveThrew = true;
    saveErr = e.what();
  } catch (...) {
    saveThrew = true;
    saveErr = "<non-std exception>";
  }
  EXPECT_FALSE(saveThrew) << "batch MTMD cache save threw: " << saveErr;
  ASSERT_TRUE(fs::exists(cachePath))
      << "batch MTMD path persisted no cache file";
  EXPECT_GT(fs::file_size(cachePath), 0u);

  // The persisted cache must be the per-sequence GGSQ format shared with the
  // text path so it round-trips through the same loader.
  {
    std::ifstream file(cachePath, std::ios::binary);
    ASSERT_TRUE(file.is_open());
    std::uint32_t magic = 0;
    file.read(reinterpret_cast<char*>(&magic), sizeof(magic));
    EXPECT_EQ(magic, static_cast<std::uint32_t>(LLAMA_STATE_SEQ_MAGIC));
  }

  // Reload pass: a fresh model loads the cached image context, then we ask a
  // follow-up that can ONLY be answered from the cached image -- no image is
  // re-supplied on this turn. A non-empty reply is not enough: a corrupt
  // M-RoPE KV (wrong per-cell kv_cell_ext x/y positions) still reloads and
  // still generates, just garbage. So we assert the answer actually names the
  // elephant in the fixture, proving the restored image context is
  // semantically intact -- not merely present. If only the text context were
  // restored (image KV missing), the model has nothing to describe and cannot
  // produce "elephant".
  auto reloadModel = makeModel();
  ASSERT_TRUE(reloadModel->isLoaded());
  auto followup =
      makePrompt("What animal was in the image? Answer with one word.");
  followup.cacheKey = cachePath.string();
  std::vector<LlamaModel::Prompt> followupPrompts;
  followupPrompts.push_back(std::move(followup));

  std::vector<std::string> followupOutputs;
  bool reloadThrew = false;
  try {
    followupOutputs = reloadModel->processPromptBatch(followupPrompts);
  } catch (...) {
    reloadThrew = true;
  }
  EXPECT_FALSE(reloadThrew) << "batch MTMD cache reload threw";
  ASSERT_EQ(followupOutputs.size(), 1u);
  ASSERT_FALSE(followupOutputs[0].empty())
      << "reload from MTMD cache produced no output; M-RoPE KV not restored";
  EXPECT_TRUE(containsCaseInsensitive(followupOutputs[0], "elephant"))
      << "follow-up could not name the cached image's subject from the "
         "reloaded cache; the M-RoPE image KV is missing or corrupt (e.g. only "
         "text context was restored, or kv_cell_ext x/y positions are wrong). "
         "Got: "
      << followupOutputs[0];

  std::error_code ec;
  fs::remove(cachePath, ec);
}

// GGSQ unification (sub-task 3): four metadata fields everywhere. The
// single-prompt CacheManager persists all four fields; the text batch path must
// read them too, otherwise a single-prompt-saved cache cannot be resumed in
// batch -- llama_state_seq_load_file rejects the file ("token count exceeded
// capacity") when its four stored tokens exceed a two-field reader. This proves
// the shared format actually round-trips across both paths.
TEST_F(
    ContinuousBatchingIntegrationTest,
    BatchTextLoadsFourFieldSinglePromptCache) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();
  const fs::path cachePath =
      fs::temp_directory_path() / ("xpath-cache-" + uniqueTestId() + ".bin");

  // Single-prompt save -> CacheManager writes GGSQ with all four fields.
  auto savePrompt = makePrompt("The capital of France is Paris.");
  savePrompt.prefill = true;
  savePrompt.cacheKey = cachePath.string();
  savePrompt.saveCacheToDisk = true;
  ASSERT_NO_THROW(model->processPrompt(savePrompt));
  ASSERT_TRUE(fs::exists(cachePath));

  // Batch text load of that same four-field file via the per-slot path.
  auto loadPrompt = makePrompt("Name that capital again in one word.");
  loadPrompt.cacheKey = cachePath.string();
  std::vector<LlamaModel::Prompt> prompts;
  prompts.push_back(std::move(loadPrompt));

  std::vector<std::string> outputs;
  std::string err;
  try {
    outputs = model->processPromptBatch(prompts);
  } catch (const std::exception& e) {
    err = e.what();
  }
  EXPECT_TRUE(err.empty())
      << "batch text path could not load the four-field single-prompt cache: "
      << err;
  ASSERT_EQ(outputs.size(), 1u);
  EXPECT_FALSE(outputs[0].empty());

  std::error_code ec;
  fs::remove(cachePath, ec);
}
