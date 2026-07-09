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

std::string repeatWord(const std::string& word, size_t count) {
  std::string out;
  out.reserve((word.size() + 1) * count);
  for (size_t i = 0; i < count; ++i) {
    out += word;
    out += ' ';
  }
  return out;
}

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
         "avgConcurrentSeq="
      << avgConcurrentSeq;
}

/// Variant: parallel = 1, single request. The tagged call falls back to the
/// single-prompt path: no per-job entry is left (the generic snapshot already
/// IS that request's figures), and generic runtimeStats() reports the run.
TEST_F(ConcurrentProcessByIdTest, ParallelOneSingleUsesGenericStatsOnly) {
  REQUIRE_MODEL(model_);
  config_["parallel"] = "1";
  config_["n_predict"] = "32";
  auto model = loadModel();

  std::any out = model->process(
      std::any(makePrompt("What is two plus two? One word.")), JobId{1});
  EXPECT_FALSE(std::any_cast<std::string>(out).empty());

  EXPECT_TRUE(model->consumeJobStats(JobId{1}).empty())
      << "the single-prompt fallback must not leave per-job stats";

  const auto stats = model->runtimeStats();
  EXPECT_GT(test_common::getStatValue(stats, "generatedTokens"), 0.0);
  EXPECT_GT(test_common::getStatValue(stats, "TPS"), 0.0);
  EXPECT_DOUBLE_EQ(test_common::getStatValue(stats, "avgConcurrentSeq"), 1.0);
}

/// Variant: multiple concurrent single requests (parallel > 1). Each finished
/// tagged job leaves its own observed figures under the snapshot's key names,
/// consumable exactly once; generic runtimeStats() keeps the whole-model
/// aggregate including avgConcurrentSeq.
TEST_F(ConcurrentProcessByIdTest, ConsumeJobStatsReportsObservedFigures) {
  REQUIRE_MODEL(model_);
  config_["n_predict"] = "32";
  auto model = loadModel();

  auto runJob = [&model](const LlamaModel::Prompt& prompt, JobId id) {
    std::any out = model->process(std::any(prompt), id);
    return std::any_cast<std::string>(out);
  };
  auto promptA = makePrompt("What is the capital of France? One word.");
  auto promptB = makePrompt("What is two plus two? One word.");
  auto futureA = std::async(std::launch::async, runJob, promptA, JobId{1});
  auto futureB = std::async(std::launch::async, runJob, promptB, JobId{2});
  ASSERT_EQ(
      futureA.wait_for(std::chrono::seconds(120)), std::future_status::ready);
  ASSERT_EQ(
      futureB.wait_for(std::chrono::seconds(120)), std::future_status::ready);
  EXPECT_FALSE(futureA.get().empty());
  EXPECT_FALSE(futureB.get().empty());

  int64_t perJobGenerated = 0;
  for (const JobId id : {JobId{1}, JobId{2}}) {
    const auto stats = model->consumeJobStats(id);
    ASSERT_FALSE(stats.empty()) << "job " << id << " left no observed stats";
    EXPECT_GT(test_common::getStatValue(stats, "TTFT"), 0.0);
    EXPECT_GT(test_common::getStatValue(stats, "generatedTokens"), 0.0);
    EXPECT_GT(test_common::getStatValue(stats, "promptTokens"), 0.0);
    EXPECT_GE(test_common::getStatValue(stats, "TPS"), 0.0);
    perJobGenerated += static_cast<int64_t>(
        test_common::getStatValue(stats, "generatedTokens"));
    EXPECT_TRUE(model->consumeJobStats(id).empty())
        << "per-job stats must be take-once";
  }

  EXPECT_TRUE(model->consumeJobStats(JobId{999}).empty())
      << "unknown ids must consume to empty";

  // Generic (untagged) stats stay the whole-model aggregate.
  const auto generic = model->runtimeStats();
  EXPECT_GE(test_common::getStatValue(generic, "avgConcurrentSeq"), 1.0);
  EXPECT_EQ(
      static_cast<int64_t>(
          test_common::getStatValue(generic, "generatedTokens")),
      perJobGenerated)
      << "the aggregate must equal the sum of the jobs' own counts";
}

/// Variant: multiple concurrent batched runs (micro-batch < parallel). Each
/// tagged group leaves ONE aggregated per-job entry (rates averaged over its
/// own requests, counts summed), so two concurrent groups never read each
/// other's figures; generic runtimeStats() spans both.
TEST_F(ConcurrentProcessByIdTest, ConcurrentBatchGroupsAggregateOwnStats) {
  REQUIRE_MODEL(model_);
  config_["n_predict"] = "32";
  auto model = loadModel(); // parallel = 4, micro-batches of 2

  auto runGroup =
      [&model](const std::vector<LlamaModel::Prompt>& prompts, JobId id) {
        std::any out = model->process(std::any(prompts), id);
        return std::any_cast<std::vector<std::string>>(out);
      };
  const std::vector<LlamaModel::Prompt> groupA{
      makePrompt("What is the capital of France? One word."),
      makePrompt("What is two plus two? One word.")};
  const std::vector<LlamaModel::Prompt> groupB{
      makePrompt("What color is the sky on a clear day? One word."),
      makePrompt("What do bees make? One word.")};

  auto futureA = std::async(std::launch::async, runGroup, groupA, JobId{11});
  auto futureB = std::async(std::launch::async, runGroup, groupB, JobId{12});
  ASSERT_EQ(
      futureA.wait_for(std::chrono::seconds(240)), std::future_status::ready);
  ASSERT_EQ(
      futureB.wait_for(std::chrono::seconds(240)), std::future_status::ready);
  EXPECT_EQ(futureA.get().size(), 2u);
  EXPECT_EQ(futureB.get().size(), 2u);

  int64_t perGroupGenerated = 0;
  for (const JobId id : {JobId{11}, JobId{12}}) {
    const auto stats = model->consumeJobStats(id);
    ASSERT_FALSE(stats.empty()) << "group " << id << " left no observed stats";
    EXPECT_GT(test_common::getStatValue(stats, "TTFT"), 0.0);
    // Two prompts' generation summed into the group's count.
    EXPECT_GT(test_common::getStatValue(stats, "generatedTokens"), 0.0);
    EXPECT_GT(test_common::getStatValue(stats, "promptTokens"), 0.0);
    EXPECT_GE(test_common::getStatValue(stats, "TPS"), 0.0);
    perGroupGenerated += static_cast<int64_t>(
        test_common::getStatValue(stats, "generatedTokens"));
    EXPECT_TRUE(model->consumeJobStats(id).empty());
  }

  const auto generic = model->runtimeStats();
  EXPECT_GE(test_common::getStatValue(generic, "avgConcurrentSeq"), 1.0);
  EXPECT_EQ(
      static_cast<int64_t>(
          test_common::getStatValue(generic, "generatedTokens")),
      perGroupGenerated)
      << "the aggregate must span both groups' counts";
}

/// Variant: one batched run of exactly `parallel` prompts (full width). The
/// group fills every engine slot, so it degenerates to the legacy bundled
/// batch: same engine path, and the group's observed figures span the whole
/// epoch — group counts equal the generic aggregate exactly.
TEST_F(ConcurrentProcessByIdTest, FullWidthBatchGroupMatchesAggregate) {
  REQUIRE_MODEL(model_);
  config_["n_predict"] = "32";
  auto model = loadModel(); // parallel = 4, batch of 4 = full width

  const std::vector<LlamaModel::Prompt> group{
      makePrompt("What is the capital of France? One word."),
      makePrompt("What is two plus two? One word."),
      makePrompt("What color is the sky on a clear day? One word."),
      makePrompt("What do bees make? One word.")};

  std::any out = model->process(std::any(group), JobId{21});
  EXPECT_EQ(std::any_cast<std::vector<std::string>>(out).size(), 4u);

  const auto stats = model->consumeJobStats(JobId{21});
  ASSERT_FALSE(stats.empty());
  const auto generic = model->runtimeStats();
  EXPECT_EQ(
      static_cast<int64_t>(test_common::getStatValue(stats, "generatedTokens")),
      static_cast<int64_t>(
          test_common::getStatValue(generic, "generatedTokens")))
      << "a full-width group IS the epoch: group counts == aggregate";
  EXPECT_EQ(
      static_cast<int64_t>(test_common::getStatValue(stats, "promptTokens")),
      static_cast<int64_t>(test_common::getStatValue(generic, "promptTokens")));
  EXPECT_GT(test_common::getStatValue(generic, "avgConcurrentSeq"), 1.0)
      << "full-width admission must actually decode in parallel";
}

/// cancelById(id) must cancel only the targeted job: the cancelled job stops
/// early (short output) while the other job runs to completion. The main
/// thread fires cancelById as soon as the target emits its first token, so
/// the cut happens mid-generation. cancelById must NOT be called from inside
/// outputCallback: the scheduler invokes it on its worker thread with the
/// scheduler mutex held, so an inline cancel self-deadlocks.
TEST_F(ConcurrentProcessByIdTest, CancelByIdCancelsOnlyTargetedJob) {
  REQUIRE_MODEL(model_);
  // n_predict must fit under the per-sequence KV cap (ctx_size / parallel)
  // together with the prompt, or submit() rejects the job at admission.
  config_["ctx_size"] = "2048";
  config_["n_predict"] = "256";
  auto model = loadModel();

  constexpr JobId kCancelId = 7;
  constexpr JobId kKeepId = 8;

  std::atomic<bool> cancelTokenSeen = false;
  std::atomic<size_t> keepPieces = 0;

  auto cancelPrompt = makePrompt(
      "Write a long, detailed, multi-paragraph essay about the history of "
      "astronomy.");
  cancelPrompt.outputCallback = [&cancelTokenSeen](const std::string&) {
    cancelTokenSeen.store(true);
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

  const auto tokenDeadline =
      std::chrono::steady_clock::now() + std::chrono::seconds(120);
  while (!cancelTokenSeen.load() &&
         std::chrono::steady_clock::now() < tokenDeadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  ASSERT_TRUE(cancelTokenSeen.load())
      << "test setup: cancelled job never emitted a token";
  model->cancelById(kCancelId);

  ASSERT_EQ(
      cancelFuture.wait_for(std::chrono::seconds(120)),
      std::future_status::ready);
  ASSERT_EQ(
      keepFuture.wait_for(std::chrono::seconds(120)),
      std::future_status::ready);
  const std::string cancelled = cancelFuture.get();
  const std::string kept = keepFuture.get();

  EXPECT_FALSE(kept.empty()) << "untargeted job must run to completion";
  // The kept job, capped at 256 tokens on a long-form prompt, emits many
  // pieces; the cancelled job is cut within a few tokens of its first, so it
  // must be strictly shorter. cancelById hit only its own slot.
  EXPECT_LT(cancelled.size(), kept.size())
      << "cancelById cancelled the wrong job (or none): cancelled='"
      << cancelled << "', kept-size=" << kept.size();
  EXPECT_GT(keepPieces.load(), 1u)
      << "untargeted job produced no real generation";
}

/// cancelById(id) must also stop a tagged job that runs on the single-prompt
/// path: a prefill-only prompt is not concurrent-eligible (see
/// isConcurrentEligible) yet arrives with a job id like any other run. Cancel
/// semantics are "request never happened": an interrupted prefill rolls the
/// KV cache back to the pre-request cursor — here, an empty cache.
TEST_F(ConcurrentProcessByIdTest, CancelByIdStopsSinglePathPrefill) {
  REQUIRE_MODEL(model_);
  // The KV pool is split per sequence (ctx_size / parallel = 1024), and the
  // single path prefills into one sequence: the prompt must fit that share
  // while still spanning several prefill batches so a cancel can land mid-run.
  config_["ctx_size"] = "4096";
  auto model = loadModel();

  constexpr JobId kPrefillId = 31;
  auto prompt = makePrompt(
      "Store this long note in the cached conversation. " +
      repeatWord("detail", 700));
  prompt.prefill = true;
  prompt.cacheKey = "cancel-prefill-cache.bin";

  std::atomic<bool> done = false;
  auto future = std::async(std::launch::async, [&model, &prompt, &done] {
    std::any out = model->process(std::any(prompt), kPrefillId);
    done.store(true);
    return std::any_cast<std::string>(out);
  });

  // Poll-cancel until the run returns: the prompt spans many prefill
  // iterations, so at least one cancel lands while it is in flight.
  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::seconds(120);
  while (!done.load() && std::chrono::steady_clock::now() < deadline) {
    model->cancelById(kPrefillId);
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  ASSERT_TRUE(done.load()) << "prefill run never returned";
  ASSERT_EQ(
      future.wait_for(std::chrono::seconds(120)), std::future_status::ready);
  EXPECT_EQ(future.get(), "");

  EXPECT_DOUBLE_EQ(
      test_common::getStatValue(model->runtimeStats(), "CacheTokens"), 0.0)
      << "cancelled prefill must roll the cache back to the pre-request "
         "cursor";
}

/// A cancel that lands after a concurrent job is admitted but before it
/// streams its first token (i.e. during prefill) must not be lost: the
/// job -> seq binding may not rely on the first streamed token. The test
/// fires cancels only while nothing has streamed, so a binding established
/// at first-token time can never rescue the run.
TEST_F(ConcurrentProcessByIdTest, CancelByIdBeforeFirstTokenCancelsJob) {
  REQUIRE_MODEL(model_);
  // Per-seq KV share = ctx_size / parallel = 1024: prompt + n_predict fit,
  // while the prompt's prefill still spans several batches.
  config_["ctx_size"] = "4096";
  config_["n_predict"] = "64";
  auto model = loadModel();

  constexpr JobId kJobId = 41;
  std::atomic<size_t> pieces = 0;
  auto prompt = makePrompt(
      "Summarize this long note in one sentence. " + repeatWord("detail", 700));
  prompt.outputCallback = [&pieces](const std::string&) {
    pieces.fetch_add(1);
  };

  std::atomic<bool> done = false;
  auto future = std::async(std::launch::async, [&model, &prompt, &done] {
    std::any out = model->process(std::any(prompt), kJobId);
    done.store(true);
    return std::any_cast<std::string>(out);
  });

  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::seconds(120);
  while (!done.load() && pieces.load() == 0 &&
         std::chrono::steady_clock::now() < deadline) {
    model->cancelById(kJobId);
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  ASSERT_EQ(
      future.wait_for(std::chrono::seconds(120)), std::future_status::ready);
  const std::string out = future.get();

  EXPECT_EQ(pieces.load(), 0u)
      << "a cancel issued before the first token was lost; the job went on "
         "to stream its full generation";
  EXPECT_TRUE(out.empty()) << out;
}
