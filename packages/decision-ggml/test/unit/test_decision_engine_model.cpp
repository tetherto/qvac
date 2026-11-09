#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <filesystem>
#include <functional>
#include <memory>
#include <mutex>
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
/// DECISION_TEST_MODELS names their directory. CI does not provide it yet, so
/// the tests that need it skip there; the integration test downloads them.
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
  EXPECT_EQ(p.n_parallel, defaults.n_parallel);
  EXPECT_TRUE(p.mmproj.path.empty());
  EXPECT_EQ(p.mmproj_use_gpu, defaults.mmproj_use_gpu);
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

/// A request whose state is `depth` nested arrays.
std::string nestedRequest(int depth) {
  return R"({"state":)" + std::string(static_cast<size_t>(depth), '[') +
         std::string(static_cast<size_t>(depth), ']') +
         R"(,"questions":{"q":{"type":"noul","instructions":"?"}}})";
}

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

TEST_F(DecisionContextModelTest, DepthGuardAccepts128AndRejects129AndDeeper) {
  // Depth 128 passes the guard; the model may still reject the payload.
  const auto ok = runOutcome(*context_, nestedRequest(128), kNeverStop);
  EXPECT_EQ(ok.second.find("nested more than"), std::string::npos) << ok.second;

  for (const int depth : {129, 5000}) {
    const auto rejected =
        runOutcome(*context_, nestedRequest(depth), kNeverStop);
    EXPECT_EQ(rejected.first, "[ Decision :: InvalidRequest ]");
    EXPECT_NE(
        rejected.second.find("nested more than 128 levels"), std::string::npos)
        << rejected.second;
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

TEST_F(DecisionContextModelTest, ReportsInfoAndMapsUpstreamRejections) {
  const json info = json::parse(context_->info());
  EXPECT_EQ(info["decision_type"], "openjev");
  EXPECT_EQ(info["max_json_depth"], qdecision::DECISION_MAX_JSON_DEPTH);

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
