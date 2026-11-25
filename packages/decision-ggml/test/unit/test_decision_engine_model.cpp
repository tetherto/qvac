#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <filesystem>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>
#include <inference-addon-cpp/addon/AddonCpp.hpp>
#include <inference-addon-cpp/queue/OutputCallbackInterface.hpp>
#include <nlohmann/json.hpp>

#include "addon/DecisionEngineScheduler.hpp"
#include "model-interface/DecisionEngineModel.hpp"
#include "test_common.hpp"

namespace fs = std::filesystem;
using json = nlohmann::ordered_json;

namespace {

std::string codeOf(const std::function<void()>& call) {
  try {
    call();
  } catch (const qvac_errors::StatusError& error) {
    return error.codeString();
  }
  return "no error";
}

/// The message of a std::runtime_error (e.g. "Job cancelled"), the code of a
/// StatusError, or "no error".
std::string outcomeOf(const std::function<void()>& call) {
  try {
    call();
  } catch (const qvac_errors::StatusError& error) {
    return error.codeString();
  } catch (const std::runtime_error& error) {
    return error.what();
  }
  return "no error";
}

common_params
params(const std::unordered_map<std::string, std::string>& config) {
  return DecisionEngineModel::loadParams("/m.gguf", config);
}

/// First existing candidate, relative to the working directory or the build
/// tree (build/test/unit), or empty.
std::string findModel(const std::string& relative) {
  fs::path binaryDir;
#ifdef TEST_BINARY_DIR
  binaryDir = fs::path(TEST_BINARY_DIR);
#else
  binaryDir = fs::current_path() / "build" / "test" / "unit";
#endif
  for (const fs::path& path :
       {fs::path{relative},
        fs::path{"../../.."} / relative,
        binaryDir.parent_path().parent_path().parent_path() / relative}) {
    if (fs::exists(path)) {
      return fs::absolute(path).string();
    }
  }
  return "";
}

/// The tiny upstream fixtures (ggml-org/tinyopenjev-for-testing-gguf):
/// DECISION_TEST_MODELS names their directory. scripts/run-cpp-tests.js sets it
/// to test/model, where CI stages them for cpp:tests from the model manifest;
/// without it the tests that need them skip.
std::string fixture(const char* file) {
  const char* dir = std::getenv("DECISION_TEST_MODELS");
  if (dir == nullptr) {
    return "";
  }
  const fs::path path = fs::path(dir) / file;
  return fs::exists(path) ? path.string() : "";
}

std::unordered_map<std::string, std::string> deviceConfig() {
  return {
      {"device", test_common::getTestDevice()},
      {"gpu_layers", test_common::getTestGpuLayers()}};
}

const char* kRequest = R"({
  "state": "My payment failed twice and I was charged both times. Please refund the duplicate.",
  "questions": {
    "route":   {"type": "choice", "instructions": "Which team?",
                "criteria": {"support": "Account, order and delivery questions", "billing": "Payments, invoices and refunds"}},
    "urgency": {"type": "score", "instructions": "How urgent is this?",
                "criteria": ["not urgent", "somewhat urgent", "very urgent"]},
    "refund":  {"type": "noul", "instructions": "Does the customer ask for a refund?"}
  }
})";

} // namespace

TEST(DecisionEngineConfigTest, MapsLoadOptionsToUpstreamParams) {
  const common_params p = params(
      {{"device", "gpu"},
       {"gpu_layers", "99"},
       {"ctx_size", "4096"},
       {"batch_size", "512"},
       {"ubatch_size", "256"},
       {"threads", "4"},
       {"parallel", "2"},
       {"mmproj", "/p.gguf"}});
  EXPECT_EQ(p.model.path, "/m.gguf");
  EXPECT_EQ(p.n_gpu_layers, 99);
  EXPECT_EQ(p.n_ctx, 4096);
  EXPECT_EQ(p.n_batch, 512);
  EXPECT_EQ(p.n_ubatch, 256);
  EXPECT_EQ(p.cpuparams.n_threads, 4);
  EXPECT_EQ(p.n_parallel, 2);
  EXPECT_EQ(p.mmproj.path, "/p.gguf");
  EXPECT_EQ(p.sleep_idle_seconds, -1) << "idle sleep stays off";
}

TEST(DecisionEngineConfigTest, CpuKeepsEveryLayerAndTheProjectorOnTheCpu) {
  const common_params p =
      params({{"device", "cpu"}, {"gpu_layers", "99"}, {"mmproj", "/p.gguf"}});
  EXPECT_EQ(p.n_gpu_layers, 0);
  EXPECT_FALSE(p.mmproj_use_gpu);
}

TEST(DecisionEngineConfigTest, UnsetOptionsAreLeftToUpstream) {
  const common_params defaults{};
  const common_params p = params({{"device", "gpu"}});
  EXPECT_EQ(p.n_gpu_layers, defaults.n_gpu_layers);
  EXPECT_EQ(p.n_ctx, defaults.n_ctx);
  EXPECT_TRUE(p.mmproj.path.empty());
  EXPECT_EQ(p.mmproj_use_gpu, defaults.mmproj_use_gpu);
}

TEST(DecisionEngineConfigTest, UnsetParallelIsLlamaServersAutoDefault) {
  // llama-server's own default without -np: 4 slots sharing one KV cache.
  const common_params p = params({{"device", "gpu"}});
  EXPECT_EQ(p.n_parallel, 4);
  EXPECT_TRUE(p.kv_unified);
}

TEST(DecisionEngineConfigTest, AnEncoderModelReadsBatchSizeTokensInOnePass) {
  const std::string laya = fixture("tinylaya-for-testing-Q8_0.gguf");
  const std::string openjev = fixture("tinyopenjev-for-testing-Q8_0.gguf");
  if (laya.empty() || openjev.empty()) {
    GTEST_SKIP() << "decision fixtures not found (set DECISION_TEST_MODELS)";
  }
  const common_params defaults{};
  // tinylaya is non-causal: the micro-batch follows the batch.
  EXPECT_EQ(
      DecisionEngineModel::loadParams(laya, {{"device", "cpu"}}).n_ubatch,
      defaults.n_batch);
  const common_params larger = DecisionEngineModel::loadParams(
      laya, {{"device", "cpu"}, {"batch_size", "4096"}});
  EXPECT_EQ(larger.n_batch, 4096);
  EXPECT_EQ(larger.n_ubatch, 4096);
  EXPECT_EQ(
      DecisionEngineModel::loadParams(
          laya, {{"device", "cpu"}, {"ubatch_size", "256"}})
          .n_ubatch,
      256)
      << "an explicit micro-batch is kept";
  // tinyopenjev is causal: upstream's default micro-batch stays.
  EXPECT_EQ(
      DecisionEngineModel::loadParams(openjev, {{"device", "cpu"}}).n_ubatch,
      defaults.n_ubatch);
}

TEST(DecisionEngineConfigTest, ExplicitParallelKeepsUpstreamsMeaning) {
  // As with llama-server's -np: one KV cache per slot unless unified.
  const common_params defaults{};
  const common_params p = params({{"device", "gpu"}, {"parallel", "2"}});
  EXPECT_EQ(p.n_parallel, 2);
  EXPECT_EQ(p.kv_unified, defaults.kv_unified);
}

// openclCacheDir is applied by the addon's shared backend initializer before
// the context is created (GGML_OPENCL_CACHE_DIR, Android).
TEST(DecisionEngineConfigTest, OpenclCacheDirIsAccepted) {
  EXPECT_EQ(
      codeOf([] {
        params({{"device", "gpu"}, {"openclCacheDir", "/data/cache"}});
      }),
      "no error");
}

TEST(DecisionEngineConfigTest, ZeroThreadsLeavesUpstreamsDefault) {
  const common_params defaults{};
  EXPECT_EQ(
      params({{"device", "cpu"}, {"threads", "0"}}).cpuparams.n_threads,
      defaults.cpuparams.n_threads)
      << "0 means every CPU, as in the other addons";
}

// Upstream does not check slot and batch counts: 0 slots leave every request
// deferred forever, and a batch of 0 cannot hold a token.
TEST(DecisionEngineConfigTest, RejectsBadOptions) {
  const std::string invalid = "[ Decision :: InvalidConfiguration ]";
  EXPECT_EQ(codeOf([] { params({}); }), invalid) << "device is required";
  EXPECT_EQ(codeOf([] { params({{"device", "npu"}}); }), invalid);
  EXPECT_EQ(
      codeOf([] { params({{"device", "cpu"}, {"pooling", "mean"}}); }),
      invalid);
  for (const auto& [key, value] :
       std::vector<std::pair<std::string, std::string>>{
           {"ctx_size", "4k"},
           {"ctx_size", "-1"},
           {"parallel", "0"},
           {"parallel", "-1"},
           {"batch_size", "0"},
           {"ubatch_size", "0"},
           {"threads", "4k"}}) {
    EXPECT_EQ(
        codeOf([&key = key, &value = value] {
          params({{"device", "cpu"}, {key, value}});
        }),
        invalid)
        << key << "=" << value;
  }
}

TEST(
    DecisionEngineConfigTest, MediaLimitsDefaultToEmbedsAndTakeEitherSpelling) {
  const qvac_lib_inference_addon_decision::MediaLimits defaults =
      DecisionEngineModel::mediaLimits({{"device", "cpu"}});
  EXPECT_EQ(defaults.maxImagePixels, 50'000'000U);
  EXPECT_EQ(defaults.maxAudioSeconds, 600U);
  const qvac_lib_inference_addon_decision::MediaLimits set =
      DecisionEngineModel::mediaLimits(
          {{"device", "cpu"},
           {"mmproj", "p.gguf"},
           {"image-max-megapixels", "2"},
           {"audio_max_seconds", "30"}});
  EXPECT_EQ(set.maxImagePixels, 2'000'000U);
  EXPECT_EQ(set.maxAudioSeconds, 30U);
  // Accepted by the load options too, so they reach the model.
  EXPECT_NO_THROW(params(
      {{"device", "cpu"},
       {"mmproj", "p.gguf"},
       {"image_max_megapixels", "2"},
       {"audio-max-seconds", "30"}}));
}

TEST(DecisionEngineConfigTest, RejectsBadMediaLimits) {
  const std::string invalid = "[ Decision :: InvalidConfiguration ]";
  EXPECT_EQ(
      codeOf([] {
        DecisionEngineModel::mediaLimits(
            {{"device", "cpu"}, {"image-max-megapixels", "2"}});
      }),
      invalid)
      << "a limit without mmproj does nothing";
  for (const auto& [key, value] :
       std::vector<std::pair<std::string, std::string>>{
           {"image-max-megapixels", "0"},
           {"image-max-megapixels", "-1"},
           {"image-max-megapixels", "1.5"},
           {"image-max-megapixels", "99999999999999999999"},
           {"audio-max-seconds", "0"},
           {"audio-max-seconds", "ten"}}) {
    EXPECT_EQ(
        codeOf([&key = key, &value = value] {
          DecisionEngineModel::mediaLimits(
              {{"device", "cpu"}, {"mmproj", "p.gguf"}, {key, value}});
        }),
        invalid)
        << key << "=" << value;
  }
}

TEST(DecisionEngineConfigTest, ConstructorRejectsBadOptionsBeforeLoading) {
  EXPECT_EQ(
      codeOf([] {
        DecisionEngineModel model(
            "unused.gguf", {{"device", "cpu"}, {"pooling", "mean"}});
      }),
      "[ Decision :: InvalidConfiguration ]");
}

TEST(DecisionEngineLoadTest, RejectsAModelWithoutDecisionMetadata) {
  const std::string path = findModel("models/unit-test/test-model.gguf");
  if (path.empty()) {
    FAIL() << "Test model not found: models/unit-test/test-model.gguf";
  }
  DecisionEngineModel model(path, {{"device", "cpu"}});
  EXPECT_EQ(
      codeOf([&] { model.waitForLoadInitialization(); }),
      "[ Decision :: UnsupportedModel ]");
}

TEST(DecisionEngineLoadTest, MissingFileFailsToLoad) {
  DecisionEngineModel model("/nonexistent/decision.gguf", {{"device", "cpu"}});
  EXPECT_EQ(
      codeOf([&] { model.waitForLoadInitialization(); }),
      "[ Decision :: UnableToLoadModel ]");
}

// The scheduler announces a job (jobStarting) under its admission lock and only
// then marks it active, so a cancel can arrive before process() starts. These
// tests drive the model through that exact sequence; no model file is needed:
// a cancelled job ends before the (lazy) load, and a job that is not cancelled
// proceeds to load and fails on the missing file instead.
TEST(DecisionEngineCancelTest, CancelBeforeProcessReachesTheJob) {
  DecisionEngineModel model("/nonexistent/decision.gguf", {{"device", "cpu"}});
  model.jobStarting(7);
  model.cancelById(7);
  EXPECT_EQ(
      outcomeOf([&] { model.process(std::string("{}"), 7); }), "Job cancelled");
}

TEST(DecisionEngineCancelTest, WholeModelCancelBeforeProcessReachesTheJob) {
  DecisionEngineModel model("/nonexistent/decision.gguf", {{"device", "cpu"}});
  model.jobStarting(9);
  model.cancel();
  EXPECT_EQ(
      outcomeOf([&] { model.process(std::string("{}"), 9); }), "Job cancelled");
}

TEST(DecisionEngineCancelTest, CancelDoesNotLeakToOtherJobs) {
  DecisionEngineModel model("/nonexistent/decision.gguf", {{"device", "cpu"}});
  model.jobStarting(1);
  model.jobStarting(2);
  model.cancelById(1);
  EXPECT_EQ(
      outcomeOf([&] { model.process(std::string("{}"), 1); }), "Job cancelled");
  // Late cancels for a finished job, and a whole-model cancel with nothing
  // announced, are no-ops: job 3 is announced afterwards and is not hit.
  model.cancelById(1);
  model.jobStarting(3);
  // Jobs 2 and 3 were never cancelled: they go on to load, which fails on the
  // missing file (not a cancellation).
  EXPECT_EQ(
      outcomeOf([&] { model.process(std::string("{}"), 2); }),
      "[ Decision :: UnableToLoadModel ]");
  EXPECT_EQ(
      outcomeOf([&] { model.process(std::string("{}"), 3); }),
      "[ Decision :: UnableToLoadModel ]");
}

namespace qdecision = qvac_lib_inference_addon_decision;

TEST(DecisionContextTest, MissingModelFileFailsToLoadAndNothingRuns) {
  common_params p;
  p.model.path = "/nonexistent.gguf";
  try {
    qdecision::DecisionContext context(p);
    FAIL() << "expected a load failure";
  } catch (const qvac_errors::StatusError& error) {
    EXPECT_EQ(error.codeString(), "[ Decision :: UnableToLoadModel ]");
    EXPECT_NE(
        std::string(error.what()).find("model file not found"),
        std::string::npos)
        << error.what();
  }
}

namespace {

/// `depth` nested empty arrays.
std::string nested(int depth) {
  return std::string(static_cast<size_t>(depth), '[') +
         std::string(static_cast<size_t>(depth), ']');
}

/// A request with a value nested @p depth levels deep at one of the places a
/// request carries values. The limit counts from where the value starts, so
/// every placement accepts the same depth.
std::string nestedRequest(const std::string& placement, int depth) {
  const std::string v = nested(depth);
  const std::string noul = R"({"q":{"type":"noul","instructions":"?"}})";
  if (placement == "state") {
    return R"({"state":)" + v + R"(,"questions":)" + noul + "}";
  }
  if (placement == "states") {
    return R"({"states":["x",)" + v + R"(],"questions":)" + noul + "}";
  }
  if (placement == "instructions") {
    return R"({"state":"x","questions":{"q":{"type":"noul","instructions":)" +
           v + "}}}";
  }
  if (placement == "choice description") {
    return R"({"state":"x","questions":{"q":{"type":"choice","instructions":"?",)"
           R"("criteria":{"a":)" +
           v + R"(,"b":"B"}}}})";
  }
  if (placement == "score level") {
    return R"({"state":"x","questions":{"q":{"type":"score","instructions":"?",)"
           R"("criteria":["low",)" +
           v + "]}}}";
  }
  if (placement == "noul criteria") {
    return R"({"state":"x","questions":{"q":{"type":"noul","instructions":"?",)"
           R"("criteria":{"true":)" +
           v + R"(,"false":"no"}}}})";
  }
  // A field the request does not define is held to the same limit.
  return R"({"state":"x","extra":)" + v + R"(,"questions":)" + noul + "}";
}

const char* const kPlacements[] = {
    "state",
    "states",
    "instructions",
    "choice description",
    "score level",
    "noul criteria",
    "unknown field"};

const std::function<bool()> kNeverStop = [] { return false; };

/// The code and message of a run's StatusError, "Job cancelled" for a
/// cancellation, or "no error".
std::pair<std::string, std::string> runOutcome(
    qdecision::DecisionContext& context, const std::string& request,
    const std::function<bool()>& shouldStop) {
  try {
    context.run(request, shouldStop);
  } catch (const qvac_errors::StatusError& error) {
    return {error.codeString(), error.what()};
  } catch (const std::runtime_error& error) {
    return {error.what(), ""};
  }
  return {"no error", ""};
}

/// One loaded context on the tiny openjev fixture, shared by the tests below.
class DecisionContextModelTest : public ::testing::Test {
protected:
  static void SetUpTestSuite() {
    const std::string model = fixture("tinyopenjev-for-testing-Q8_0.gguf");
    if (model.empty()) {
      return;
    }
    context_ = std::make_unique<qdecision::DecisionContext>(
        DecisionEngineModel::loadParams(
            model, {{"device", "cpu"}, {"ctx_size", "2048"}}));
  }
  static void TearDownTestSuite() { context_.reset(); }
  void SetUp() override {
    if (!context_) {
      GTEST_SKIP() << "decision fixtures not found (set DECISION_TEST_MODELS)";
    }
  }
  static std::unique_ptr<qdecision::DecisionContext> context_;
};
std::unique_ptr<qdecision::DecisionContext> DecisionContextModelTest::context_;

} // namespace

constexpr const char* kGuardMessage =
    "a value in the request is nested more than 128 levels deep";

TEST_F(DecisionContextModelTest, DepthGuardAccepts128AndRejects129AndDeeper) {
  for (const char* placement : kPlacements) {
    // Depth 128 passes the guard. Upstream counts its own 128 levels from the
    // prompt input it builds, so it may still reject a value nested in it, as
    // an invalid request.
    const auto ok =
        runOutcome(*context_, nestedRequest(placement, 128), kNeverStop);
    EXPECT_EQ(ok.second.find(kGuardMessage), std::string::npos)
        << placement << ": " << ok.second;
    if (!ok.second.empty()) {
      EXPECT_EQ(ok.first, "[ Decision :: InvalidRequest ]")
          << placement << ": " << ok.second;
    }

    for (const int depth : {129, 5000}) {
      const auto rejected =
          runOutcome(*context_, nestedRequest(placement, depth), kNeverStop);
      EXPECT_EQ(rejected.first, "[ Decision :: InvalidRequest ]")
          << placement << " at " << depth;
      EXPECT_NE(rejected.second.find(kGuardMessage), std::string::npos)
          << placement << " at " << depth << ": " << rejected.second;
    }
  }
}

TEST_F(
    DecisionContextModelTest, AStopBeforeTheRunCancelsItAndTheNextRunAnswers) {
  EXPECT_EQ(
      runOutcome(*context_, kRequest, [] { return true; }).first,
      "Job cancelled");

  // No stale stop signal: the next run answers.
  const json next = json::parse(context_->run(kRequest, kNeverStop));
  EXPECT_TRUE(next.contains("answers"));
}

namespace {

/// levelRange() over a predicate that takes [lo, hi], with the number of
/// times it was asked.
std::pair<std::optional<qdecision::LevelRange>, size_t>
rangeOf(size_t lo, size_t hi, size_t limit) {
  size_t asked = 0;
  const auto range = qdecision::levelRange(
      [&](size_t n) {
        ++asked;
        return n >= lo && n <= hi;
      },
      limit);
  return {range, asked};
}

} // namespace

TEST(LevelRangeTest, FindsTheAcceptedRange) {
  for (const auto& [lo, hi] : std::vector<std::pair<size_t, size_t>>{
           {2, 10},
           {1, 1},
           {1, 255},
           {1, 256},
           {1, 257},
           {1, 1000},
           {2, 4097}}) {
    const auto [range, asked] = rangeOf(lo, hi, 150000);
    ASSERT_TRUE(range.has_value()) << lo << ".." << hi;
    EXPECT_EQ(range->min, lo) << lo << ".." << hi;
    EXPECT_EQ(range->max, hi) << lo << ".." << hi;
    // A few dozen questions, not one per count.
    EXPECT_LE(asked, 64U) << lo << ".." << hi;
  }
}

TEST(LevelRangeTest, StopsAtTheLimitAndReportsNoneWhenNothingIsTaken) {
  const auto capped = rangeOf(1, 5000, 1000).first;
  ASSERT_TRUE(capped.has_value());
  EXPECT_EQ(capped->max, 1000U);
  EXPECT_FALSE(rangeOf(1, 0, 1000).first.has_value());
}

TEST(NoulSemanticsTest, ListsEveryKnownTypeAndNothingElse) {
  EXPECT_EQ(
      qdecision::noulSemantics(COMMON_DECISION_TYPE_LEV), "expected_rating");
  for (const auto type :
       {COMMON_DECISION_TYPE_OPENJEV,
        COMMON_DECISION_TYPE_KEV,
        COMMON_DECISION_TYPE_NIMBLE,
        COMMON_DECISION_TYPE_LAYA,
        COMMON_DECISION_TYPE_CLEF,
        COMMON_DECISION_TYPE_PPLX_DECIDER,
        COMMON_DECISION_TYPE_VLLM_DECISION2,
        COMMON_DECISION_TYPE_VLLM_D3,
        COMMON_DECISION_TYPE_LFM2_D1,
        COMMON_DECISION_TYPE_LFM2_D1_OMNI,
        COMMON_DECISION_TYPE_GRANITE_SWITCH,
        COMMON_DECISION_TYPE_H2O_LIGHTNING,
        COMMON_DECISION_TYPE_MINICPM_OCR_JEV,
        COMMON_DECISION_TYPE_LFM3_D1,
        COMMON_DECISION_TYPE_LFM3_D1_OMNI}) {
    EXPECT_EQ(qdecision::noulSemantics(type), "probability") << type;
  }
  // Not a type this addon lists: never assumed to be a probability.
  for (const auto type :
       {COMMON_DECISION_TYPE_NONE,
        COMMON_DECISION_TYPE_UNKNOWN,
        static_cast<common_decision_type>(COMMON_DECISION_TYPE_UNKNOWN + 1)}) {
    EXPECT_EQ(qdecision::noulSemantics(type), "unknown") << type;
  }
}

TEST_F(DecisionContextModelTest, ReportsInfoAndMapsUpstreamRejections) {
  const json info = json::parse(context_->info());
  EXPECT_EQ(info["decision_type"], "openjev");
  EXPECT_EQ(info["noul"], "probability");
  // Causal, 4 default slots sharing a 2048-token cache: a quarter of it each,
  // but one token.
  EXPECT_EQ(info["n_ctx"], 2048);
  EXPECT_EQ(info["max_input_tokens"], 2048 / 4 - 1);
  EXPECT_EQ(info["max_json_depth"], qdecision::DECISION_MAX_JSON_DEPTH);
  // Asked from upstream's parser: openjev takes 2 to 10 score levels, and
  // its score answer is the expected level.
  EXPECT_EQ(info["score_levels"], json({{"min", 2}, {"max", 10}}));
  EXPECT_EQ(info["score"], "expected_level");

  const auto rejected = runOutcome(
      *context_,
      R"({"state":"x","questions":{"q":{"type":"score","instructions":"?",)"
      R"("criteria":["a","b","c","d","e","f","g","h","i","j","k"]}}})",
      kNeverStop);
  EXPECT_EQ(rejected.first, "[ Decision :: InvalidRequest ]");
  // The JS side keys err.code DECISION_INVALID_REQUEST on this prefix.
  EXPECT_EQ(rejected.second.rfind("invalid request: ", 0), 0U)
      << rejected.second;
}

TEST(DecisionContextLifetimeTest, DestroyingRightAfterTheLoadReturns) {
  const std::string openjev = fixture("tinyopenjev-for-testing-Q8_0.gguf");
  if (openjev.empty()) {
    GTEST_SKIP() << "decision fixtures not found (set DECISION_TEST_MODELS)";
  }
  // Destroyed before upstream's loop thread may have started its loop, which
  // sets the loop running on entry: the stop must still reach it. A race, so
  // several rounds; without the fix this hangs on the first one or two.
  for (int i = 0; i < 10; ++i) {
    qdecision::DecisionContext context(
        DecisionEngineModel::loadParams(
            openjev, {{"device", "cpu"}, {"ctx_size", "512"}}));
  }
}

TEST(DecisionContextCausalTest, OneSlotMayFillTheContextButOneToken) {
  const std::string openjev = fixture("tinyopenjev-for-testing-Q8_0.gguf");
  if (openjev.empty()) {
    GTEST_SKIP() << "decision fixtures not found (set DECISION_TEST_MODELS)";
  }
  qdecision::DecisionContext context(
      DecisionEngineModel::loadParams(
          openjev,
          {{"device", "cpu"}, {"ctx_size", "2048"}, {"parallel", "1"}}));
  const json info = json::parse(context.info());
  EXPECT_EQ(info["max_input_tokens"], 2047);
}

TEST(DecisionContextLayaTest, AnInputLongerThanOnePassIsARejectedRequest) {
  const std::string laya = fixture("tinylaya-for-testing-Q8_0.gguf");
  if (laya.empty()) {
    GTEST_SKIP() << "decision fixtures not found (set DECISION_TEST_MODELS)";
  }
  // A non-causal model with a 64-token pass: the limit info() reports, and
  // the error for a longer input.
  qdecision::DecisionContext context(
      DecisionEngineModel::loadParams(
          laya, {{"device", "cpu"}, {"batch_size", "64"}}));
  const json info = json::parse(context.info());
  EXPECT_EQ(info["decision_type"], "laya");
  EXPECT_EQ(info["noul"], "probability");
  EXPECT_EQ(info["max_input_tokens"], 64);

  const json shortRequest = {
      {"state", "Refund please."},
      {"questions", {{"q", {{"type", "noul"}, {"instructions", "Refund?"}}}}}};
  EXPECT_TRUE(
      json::parse(context.run(shortRequest.dump(), kNeverStop))
          .contains("answers"));

  std::string longState;
  for (int i = 0; i < 80; ++i) {
    longState += "My payment failed and I was charged twice. ";
  }
  json longRequest = shortRequest;
  longRequest["state"] = longState;
  const auto rejected = runOutcome(context, longRequest.dump(), kNeverStop);
  EXPECT_EQ(rejected.first, "[ Decision :: InvalidRequest ]");
  EXPECT_EQ(rejected.second.rfind("invalid request: the input is ", 0), 0U)
      << rejected.second;
  EXPECT_NE(
      rejected.second.find("more than this model reads in one pass (64)"),
      std::string::npos)
      << rejected.second;

  // In a batch, the state is named.
  const json batch = {
      {"states", json::array({"Refund please.", longState})},
      {"questions", shortRequest["questions"]}};
  const auto batchRejected = runOutcome(context, batch.dump(), kNeverStop);
  EXPECT_EQ(
      batchRejected.second.rfind(
          "invalid request: states[1]: the input is ", 0),
      0U)
      << batchRejected.second;
}

namespace {

const char* kQuestions = R"({
    "route":  {"type": "choice", "instructions": "Which team?",
               "criteria": {"support": "Account, order and delivery questions", "billing": "Payments, invoices and refunds"}},
    "refund": {"type": "noul", "instructions": "Does the customer ask for a refund?"}
  })";

const std::vector<std::string> kStates = {
    "My payment failed twice and I was charged both times. Please refund the "
    "duplicate.",
    "Where is my parcel? It was due on Monday.",
    "I want my money back for the broken headphones.",
    "How do I change the email address on my account?",
    "The invoice shows the wrong company name.",
    "Thanks, the replacement arrived and works fine."};

json batchRequest(const json& states) {
  return json{{"states", states}, {"questions", json::parse(kQuestions)}};
}

json singleRequest(const json& state) {
  return json{{"state", state}, {"questions", json::parse(kQuestions)}};
}

} // namespace

TEST_F(DecisionContextModelTest, ABatchAnswersEveryStateInInputOrder) {
  const json results =
      json::parse(context_->run(batchRequest(kStates).dump(), kNeverStop));
  ASSERT_TRUE(results.is_array());
  ASSERT_EQ(results.size(), kStates.size());
  for (size_t i = 0; i < kStates.size(); ++i) {
    // The state's own answers: run alone, the same state gives the same
    // choice and, batched with others, a noul equal to rounding.
    const json alone = json::parse(
        context_->run(singleRequest(kStates[i]).dump(), kNeverStop));
    EXPECT_EQ(
        results[i]["answers"]["route"]["choice"],
        alone["answers"]["route"]["choice"])
        << "states[" << i << "]";
    EXPECT_NEAR(
        results[i]["answers"]["refund"]["noul"].get<double>(),
        alone["answers"]["refund"]["noul"].get<double>(),
        1e-3)
        << "states[" << i << "]";
    EXPECT_EQ(
        results[i]["usage"]["input_tokens"], alone["usage"]["input_tokens"])
        << "states[" << i << "]";
  }
}

TEST_F(DecisionContextModelTest, ABatchOfOneIsAnArrayOfOne) {
  const json results = json::parse(context_->run(
      batchRequest(json::array({kStates[0]})).dump(), kNeverStop));
  ASSERT_TRUE(results.is_array());
  EXPECT_EQ(results.size(), 1U);
  EXPECT_TRUE(results[0].contains("answers"));
}

TEST_F(DecisionContextModelTest, RejectsMalformedBatches) {
  json both = batchRequest(json::array({"a"}));
  both["state"] = "b";
  for (const json& request :
       {batchRequest(json::array()), batchRequest(json("not a list")), both}) {
    const auto outcome = runOutcome(*context_, request.dump(), kNeverStop);
    EXPECT_EQ(outcome.first, "[ Decision :: InvalidRequest ]")
        << request.dump();
    EXPECT_EQ(outcome.second.rfind("invalid request: ", 0), 0U)
        << outcome.second;
  }
}

TEST_F(
    DecisionContextModelTest, ABatchWithoutQuestionsGetsUpstreamsDiagnostic) {
  // Only "states": each state's request is still valid JSON, so upstream names
  // the missing field instead of failing to parse the body.
  const auto outcome = runOutcome(
      *context_,
      json{{"states", json::array({kStates[0]})}}.dump(),
      kNeverStop);
  EXPECT_EQ(outcome.first, "[ Decision :: InvalidRequest ]");
  EXPECT_EQ(
      outcome.second,
      "invalid request: states[0]: \"questions\" must be a non-empty object");
}

TEST_F(DecisionContextModelTest, AFailingStateFailsTheBatchAndIsNamed) {
  // openjev needs a state; null is rejected for that state only.
  const auto outcome = runOutcome(
      *context_,
      batchRequest(json::array({kStates[0], kStates[1], nullptr, kStates[3]}))
          .dump(),
      kNeverStop);
  EXPECT_EQ(outcome.first, "[ Decision :: InvalidRequest ]");
  EXPECT_EQ(outcome.second.rfind("invalid request: states[2]: ", 0), 0U)
      << outcome.second;

  // The context recovers: the next batch answers.
  const json next = json::parse(context_->run(
      batchRequest(json::array({kStates[0], kStates[1]})).dump(), kNeverStop));
  EXPECT_EQ(next.size(), 2U);
}

TEST_F(DecisionContextModelTest, AStopBeforeABatchCancelsItAndTheNextAnswers) {
  EXPECT_EQ(
      runOutcome(*context_, batchRequest(kStates).dump(), [] { return true; })
          .first,
      "Job cancelled");
  const json next =
      json::parse(context_->run(batchRequest(kStates).dump(), kNeverStop));
  EXPECT_EQ(next.size(), kStates.size());
}

TEST_F(DecisionContextModelTest, ABatchSerializesEachStateOnceWhenClaimed) {
  // The shared inputs (here the questions) are serialized once; each state's
  // body is built when a worker claims it.
  const size_t before = context_->batchBodiesSerializedForTesting();
  const json results =
      json::parse(context_->run(batchRequest(kStates).dump(), kNeverStop));
  EXPECT_EQ(results.size(), kStates.size());
  EXPECT_EQ(
      context_->batchBodiesSerializedForTesting() - before, kStates.size());
}

TEST_F(DecisionContextModelTest, AStopAsABatchStartsSerializesNoState) {
  // Many states sharing a large payload. The stop is raised after run()'s own
  // check (the first poll), so the batch sees it before claiming a state:
  // nothing is serialized, where every body used to be built up front.
  json states = json::array();
  for (int i = 0; i < 64; ++i) {
    states.push_back(kStates[0]);
  }
  json request = batchRequest(states);
  request["questions"]["route"]["instructions"] = std::string(256 * 1024, 'x');
  const size_t before = context_->batchBodiesSerializedForTesting();
  std::atomic<int> polls{0};
  const auto outcome = runOutcome(
      *context_, request.dump(), [&polls] { return polls.fetch_add(1) >= 1; });
  EXPECT_EQ(outcome.first, "Job cancelled");
  EXPECT_EQ(context_->batchBodiesSerializedForTesting() - before, 0U);
}

TEST_F(DecisionContextModelTest, AStopDuringABatchCancelsIt) {
  // Stops once the batch has started: the remaining states never run, and the
  // batch ends cancelled rather than with partial results.
  std::atomic<int> polls{0};
  const auto outcome =
      runOutcome(*context_, batchRequest(kStates).dump(), [&polls] {
        return polls.fetch_add(1) > 2;
      });
  EXPECT_EQ(outcome.first, "Job cancelled");
  const json next = json::parse(context_->run(kRequest, kNeverStop));
  EXPECT_TRUE(next.contains("answers"));
}

TEST_F(DecisionContextModelTest, AnImageOverTheLimitIsRejectedBeforeDecoding) {
  const std::string mmproj =
      fixture("mmproj-tinyopenjev-for-testing-Q8_0.gguf");
  if (mmproj.empty()) {
    GTEST_SKIP() << "projector fixture not found";
  }
  common_params params = DecisionEngineModel::loadParams(
      fixture("tinyopenjev-for-testing-Q8_0.gguf"),
      {{"device", "cpu"}, {"ctx_size", "2048"}, {"mmproj", mmproj}});
  qdecision::MediaLimits limits;
  limits.maxImagePixels = 1'000'000;
  qdecision::DecisionContext context(params, limits);
  // A PNG whose header declares 2000x2000 pixels (4 MP) and holds no pixel
  // data: only the header is read, so the check happens before decoding.
  const json request = {
      {"state", "What does the picture show?"},
      {"files",
       json::array(
           {"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAB9AAAAfQCAIAAAAVWlMu"
            "AAAAAElFTkSuQmCC"})},
      {"questions",
       {{"colorful", {{"type", "noul"}, {"instructions", "Colorful?"}}}}}};
  const auto outcome = runOutcome(context, request.dump(), kNeverStop);
  EXPECT_EQ(outcome.first, "[ Decision :: InvalidRequest ]") << outcome.second;
  EXPECT_NE(
      outcome.second.find("image is larger than the media size limit"),
      std::string::npos)
      << outcome.second;
}

TEST_F(DecisionContextModelTest, ALoopThatDiesDuringABatchFailsItWithItsError) {
  // Its own context: the loop stays marked dead. The loop dies on the second
  // poll, inside the batch; the stop signal it raises must not turn the
  // batch into a cancellation.
  qdecision::DecisionContext context(
      DecisionEngineModel::loadParams(
          fixture("tinyopenjev-for-testing-Q8_0.gguf"),
          {{"device", "cpu"}, {"ctx_size", "2048"}}));
  std::atomic<int> polls{0};
  const auto outcome =
      runOutcome(context, batchRequest(kStates).dump(), [&polls, &context] {
        if (polls.fetch_add(1) == 1) {
          context.markLoopDeadForTesting("injected loop failure");
        }
        return false;
      });
  EXPECT_EQ(outcome.first, "[ Decision :: DecodeFailed ]") << outcome.second;
  EXPECT_NE(
      outcome.second.find("the decision loop stopped: injected loop failure"),
      std::string::npos)
      << outcome.second;
}

namespace {

namespace qaddon = qvac_lib_inference_addon_cpp;

/// Implements the interfaces the decision scheduler drives, and holds its
/// first job inside process() until released.
class GateModel : public qaddon::model::IModel,
                  public qaddon::model::IModelCancel,
                  public qaddon::model::IModelMultiprocessor,
                  public qaddon::model::IModelCancelById,
                  public qaddon::model::IModelJobLifecycle {
public:
  [[nodiscard]] std::string getName() const override { return "GateModel"; }
  std::any process(const std::any& input) override { return process(input, 0); }
  std::any process(const std::any& input, qaddon::JobId /*id*/) override {
    std::unique_lock<std::mutex> lock(mutex_);
    ++started_;
    cv_.notify_all();
    cv_.wait(lock, [this] { return released_; });
    return input;
  }
  [[nodiscard]] qaddon::RuntimeStats runtimeStats() const override {
    return {};
  }
  void cancel() const override {}
  void cancelById(qaddon::JobId /*id*/) const override {}
  void jobStarting(qaddon::JobId /*id*/) override {}

  void waitStarted(int n) {
    std::unique_lock<std::mutex> lock(mutex_);
    cv_.wait(lock, [&] { return started_ >= n; });
  }
  void release() {
    std::lock_guard<std::mutex> lock(mutex_);
    released_ = true;
    cv_.notify_all();
  }

private:
  std::mutex mutex_;
  std::condition_variable cv_;
  int started_ = 0;
  bool released_ = false;
};

struct NullCallback : qaddon::OutputCallBackInterface {
  void initializeProcessingThread(
      std::shared_ptr<qaddon::OutputQueue> /*queue*/) override {}
  void notify() override {}
  void stop() override {}
};

} // namespace

// runJob()'s contract is "false if busy": while one request runs, another is
// rejected, not queued behind it.
TEST(DecisionEngineSchedulerTest, RejectsASecondJobWhileOneIsInFlight) {
  auto model = std::make_unique<GateModel>();
  GateModel* gate = model.get();
  auto scheduler =
      qvac_lib_inference_addon_decision::makeDecisionEngineScheduler(*gate);
  qaddon::AddonCpp addon(
      std::make_unique<NullCallback>(), std::move(model), std::move(scheduler));

  const auto first = addon.runJob(std::any(std::string("first")));
  ASSERT_TRUE(first.has_value());
  EXPECT_NE(*first, qaddon::kNoJobId) << "jobs are tagged with ids";
  gate->waitStarted(1);

  EXPECT_FALSE(addon.runJob(std::any(std::string("second"))).has_value())
      << "a job submitted while one is in flight must be rejected";

  gate->release();
  for (int i = 0; i < 1000 && addon.activeJobs() != 0; ++i) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  ASSERT_EQ(addon.activeJobs(), 0U);
  EXPECT_TRUE(addon.runJob(std::any(std::string("third"))).has_value())
      << "once the slot is free, a new job is admitted";
}

/// Needs the openjev fixture, see fixture().
class DecisionEngineModelTest : public ::testing::Test {
protected:
  void SetUp() override {
    const std::string path = fixture("tinyopenjev-for-testing-Q8_0.gguf");
    if (path.empty()) {
      GTEST_SKIP() << "decision fixtures not found (set DECISION_TEST_MODELS)";
    }
    model_ = std::make_unique<DecisionEngineModel>(path, deviceConfig());
    model_->waitForLoadInitialization();
  }

  std::string run(const std::string& request) {
    return std::any_cast<DecisionEngineResult>(model_->process(request)).json;
  }

  std::unique_ptr<DecisionEngineModel> model_;
};

TEST_F(DecisionEngineModelTest, ReportsCapabilities) {
  const json info = json::parse(model_->info());
  EXPECT_EQ(info.at("decision_type"), "openjev");
  EXPECT_EQ(info.at("noul"), "probability");
  EXPECT_EQ(info.at("max_json_depth"), 128);
}

TEST_F(DecisionEngineModelTest, AnswersAllQuestionTypes) {
  const json res = json::parse(run(kRequest));
  const json& answers = res.at("answers");
  EXPECT_EQ(answers.at("route").at("type"), "choice");
  EXPECT_EQ(answers.at("route").at("probabilities").size(), 2U);
  EXPECT_EQ(answers.at("urgency").at("probabilities").size(), 3U);
  EXPECT_FALSE(answers.at("refund").contains("confidence"));
  EXPECT_GT(res.at("usage").at("input_tokens"), 0);
}

TEST_F(DecisionEngineModelTest, InvalidRequestsMapToInvalidRequest) {
  EXPECT_EQ(
      codeOf([&] { run("{not json"); }), "[ Decision :: InvalidRequest ]");
  const std::string deep =
      R"({"state":)" + std::string(129, '[') + std::string(129, ']') +
      R"(,"questions":{"q":{"type":"noul","instructions":"?"}}})";
  EXPECT_EQ(codeOf([&] { run(deep); }), "[ Decision :: InvalidRequest ]");
}

TEST_F(DecisionEngineModelTest, CancelledRunThrowsJobCancelledThenRecovers) {
  std::atomic<bool> stop{false};
  std::thread canceller([&] {
    while (!stop.load()) {
      model_->cancel();
      std::this_thread::yield();
    }
  });
  std::string outcome;
  try {
    run(kRequest);
    outcome = "finished";
  } catch (const std::runtime_error& e) {
    outcome = e.what();
  }
  stop = true;
  canceller.join();
  EXPECT_TRUE(outcome == "Job cancelled" || outcome == "finished") << outcome;

  // No stale stop signal: the next request answers.
  const json res = json::parse(run(kRequest));
  EXPECT_TRUE(res.contains("answers"));
}
