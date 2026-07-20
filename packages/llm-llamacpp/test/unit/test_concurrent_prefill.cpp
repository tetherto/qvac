// Async prefill jobs on the multi-job path (process(input, id)). A prefill
// whose product can outlive its slot (saveCacheToDisk + cacheKey) must run on
// a scheduler lane like any generation job — truly parallel with its peers.
// A prefill whose only product is live single-context state cannot run
// concurrently (lanes wipe their state, and the single context is shared), so
// on a parallel model it must be rejected instead of racing peers on the
// shared context. Two in-flight jobs saving the same cacheKey would race on
// the file, so the second must be refused.

#include <any>
#include <chrono>
#include <filesystem>
#include <future>
#include <string>
#include <thread>
#include <vector>

#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>

#include "model-interface/LlamaModel.hpp"
#include "test_common.hpp"
#include "test_internal_peers.hpp"

namespace {

namespace fs = std::filesystem;

using qvac_lib_inference_addon_cpp::JobId;

std::string uniqueTestId() {
  return std::to_string(
      std::chrono::high_resolution_clock::now().time_since_epoch().count());
}

class ConcurrentPrefillTest : public ::testing::Test {
protected:
  void SetUp() override {
    using MP = test_common::TestModelPath;
    config_["device"] = test_common::getTestDevice();
    config_["ctx_size"] = "2048";
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

  /// A prompt long enough that its prefill spans several scheduler steps —
  /// ~330 tokens fits the 512-token per-seq window (ctx 2048 / parallel 4)
  /// while the 256-token batch capacity forces at least two steps per
  /// prefill, so two jobs launched together reliably overlap.
  static LlamaModel::Prompt
  makeLongPrefillPrompt(const std::string& cacheKey, const std::string& topic) {
    std::string text = "Remember every detail of this " + topic + " brief. ";
    for (int i = 0; i < 30; ++i) {
      text += "Fact " + std::to_string(i) + " about the " + topic +
              " stays relevant later. ";
    }
    LlamaModel::Prompt prompt = makePrompt(text);
    prompt.prefill = true;
    prompt.cacheKey = cacheKey;
    prompt.saveCacheToDisk = true;
    return prompt;
  }

  static std::string
  runJob(LlamaModel& model, const LlamaModel::Prompt& prompt, JobId id) {
    std::any out = model.process(std::any(prompt), id);
    return std::any_cast<std::string>(out);
  }

  std::unordered_map<std::string, std::string> config_;
  test_common::TestModelPath model_;
};

fs::path tempCachePath(const std::string& tag) {
  return fs::temp_directory_path() /
         ("concurrent-prefill-" + tag + "-" + uniqueTestId() + ".bin");
}

} // namespace

/// The routing predicate: a prefill earns a lane exactly when its product
/// survives the slot teardown (saveCacheToDisk with a cacheKey). Generation
/// stays eligible, finetune and non-persistable prefill stay single-path.
TEST(ConcurrentPrefillEligibility, PrefillWithPersistedCacheEarnsALane) {
  LlamaModel::Prompt generation;
  generation.input = R"([{"role":"user","content":"hi"}])";
  EXPECT_TRUE(LlamaModelTestPeer::isConcurrentEligible(generation));

  LlamaModel::Prompt persistedPrefill = generation;
  persistedPrefill.prefill = true;
  persistedPrefill.cacheKey = "/tmp/some-cache.bin";
  persistedPrefill.saveCacheToDisk = true;
  EXPECT_TRUE(LlamaModelTestPeer::isConcurrentEligible(persistedPrefill))
      << "a prefill that persists its cache has a lane-compatible product";

  LlamaModel::Prompt liveOnlyPrefill = generation;
  liveOnlyPrefill.prefill = true;
  EXPECT_FALSE(LlamaModelTestPeer::isConcurrentEligible(liveOnlyPrefill))
      << "a prefill without a persisted cache only warms the single context";

  LlamaModel::Prompt keylessSave = generation;
  keylessSave.prefill = true;
  keylessSave.saveCacheToDisk = true;
  EXPECT_FALSE(LlamaModelTestPeer::isConcurrentEligible(keylessSave))
      << "saveCacheToDisk without a cacheKey cannot persist anything";
}

/// A tagged prefill job that cannot persist its cache must be rejected on a
/// parallel model: its only product (warm state in the shared single context)
/// is unreachable by lane-based followups, and running it would race peers on
/// that shared context.
TEST_F(ConcurrentPrefillTest, RejectsLiveOnlyPrefillJobOnParallelModel) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();

  auto liveOnly = makePrompt("Warm the context with this text.");
  liveOnly.prefill = true;
  EXPECT_THROW(runJob(*model, liveOnly, JobId{11}), qvac_errors::StatusError);

  auto keylessSave = makePrompt("Warm the context with this text too.");
  keylessSave.prefill = true;
  keylessSave.saveCacheToDisk = true;
  EXPECT_THROW(
      runJob(*model, keylessSave, JobId{12}), qvac_errors::StatusError);
}

/// Two in-flight prefill jobs saving the same cacheKey would race on the same
/// file; the later admission must be refused while the first still runs.
TEST_F(ConcurrentPrefillTest, RejectsDuplicateInFlightCacheKey) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();
  const fs::path cachePath = tempCachePath("dup");

  const auto promptA = makeLongPrefillPrompt(cachePath.string(), "storm");
  const auto promptB = makeLongPrefillPrompt(cachePath.string(), "harbor");

  auto futureA = std::async(
      std::launch::async, [&] { return runJob(*model, promptA, JobId{21}); });
  auto futureB = std::async(
      std::launch::async, [&] { return runJob(*model, promptB, JobId{22}); });

  int rejected = 0;
  for (auto* future : {&futureA, &futureB}) {
    try {
      EXPECT_TRUE(future->get().empty()) << "prefill jobs produce no text";
    } catch (const qvac_errors::StatusError& e) {
      // Only the dedicated duplicate-key refusal counts: a job that dies for
      // any other reason (e.g. shared-context corruption) must fail the test.
      EXPECT_NE(std::string(e.what()).find("cacheKey"), std::string::npos)
          << "unexpected rejection: " << e.what();
      ++rejected;
    }
  }
  EXPECT_EQ(rejected, 1)
      << "exactly one of two same-key in-flight prefill saves must be refused";
  fs::remove(cachePath);
}

/// A lane-routed prefill job leaves its own observed stats behind for the
/// tagged jobEnded event, like any other concurrent job.
TEST_F(ConcurrentPrefillTest, PrefillJobReportsPerJobStats) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();
  const fs::path cachePath = tempCachePath("stats");

  const auto prompt = makeLongPrefillPrompt(cachePath.string(), "orchard");
  EXPECT_TRUE(runJob(*model, prompt, JobId{31}).empty())
      << "prefill-only jobs produce no text";

  const auto stats = model->consumeJobStats(JobId{31});
  ASSERT_FALSE(stats.empty())
      << "a lane-routed prefill job must record per-job stats";
  EXPECT_GT(test_common::getStatValue(stats, "promptTokens"), 0.0);
  fs::remove(cachePath);
}

/// The point of lane routing: two async prefill jobs decode their prompt
/// chunks in the same scheduler steps instead of serializing.
TEST_F(ConcurrentPrefillTest, TwoAsyncPrefillJobsOverlapOnScheduler) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();
  const fs::path cachePathA = tempCachePath("parallel-a");
  const fs::path cachePathB = tempCachePath("parallel-b");

  const auto promptA = makeLongPrefillPrompt(cachePathA.string(), "glacier");
  const auto promptB = makeLongPrefillPrompt(cachePathB.string(), "volcano");

  auto futureA = std::async(
      std::launch::async, [&] { return runJob(*model, promptA, JobId{41}); });
  auto futureB = std::async(
      std::launch::async, [&] { return runJob(*model, promptB, JobId{42}); });
  EXPECT_TRUE(futureA.get().empty());
  EXPECT_TRUE(futureB.get().empty());
  EXPECT_TRUE(fs::exists(cachePathA));
  EXPECT_TRUE(fs::exists(cachePathB));

  const double avgConcurrentSeq =
      test_common::getStatValue(model->runtimeStats(), "avgConcurrentSeq");
  EXPECT_GT(avgConcurrentSeq, 1.05)
      << "async prefill jobs must decode concurrently on scheduler lanes";

  fs::remove(cachePathA);
  fs::remove(cachePathB);
}

/// Round-trip parity: the cache file a tagged prefill job writes must be
/// loadable by a later tagged generation job under the same key.
TEST_F(ConcurrentPrefillTest, PrefillJobCacheRoundTripsToGenerationJob) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();
  const fs::path cachePath = tempCachePath("roundtrip");

  const auto prefill = makeLongPrefillPrompt(cachePath.string(), "lighthouse");
  EXPECT_TRUE(runJob(*model, prefill, JobId{51}).empty());
  ASSERT_TRUE(fs::exists(cachePath));
  EXPECT_GT(fs::file_size(cachePath), 0u);

  auto followup = makePrompt("Say cached follow up.");
  followup.cacheKey = cachePath.string();
  const std::string output = runJob(*model, followup, JobId{52});
  EXPECT_FALSE(output.empty())
      << "generation under the prefill's cacheKey must produce output";

  fs::remove(cachePath);
}
