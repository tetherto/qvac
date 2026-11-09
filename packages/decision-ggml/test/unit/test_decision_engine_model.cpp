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

json params(const std::unordered_map<std::string, std::string>& config) {
  return json::parse(DecisionEngineModel::paramsJson("/m.gguf", config));
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

TEST(DecisionEngineConfigTest, MapsLoadOptionsToRuntimeParams) {
  const json p = params(
      {{"device", "gpu"},
       {"gpu_layers", "99"},
       {"ctx_size", "4096"},
       {"batch_size", "512"},
       {"ubatch_size", "256"},
       {"threads", "4"},
       {"parallel", "2"},
       {"mmproj", "/p.gguf"}});
  EXPECT_EQ(p.at("model"), "/m.gguf");
  EXPECT_EQ(p.at("n_gpu_layers"), 99);
  EXPECT_EQ(p.at("n_ctx"), 4096);
  EXPECT_EQ(p.at("n_batch"), 512);
  EXPECT_EQ(p.at("n_ubatch"), 256);
  EXPECT_EQ(p.at("n_threads"), 4);
  EXPECT_EQ(p.at("n_parallel"), 2);
  EXPECT_EQ(p.at("mmproj"), "/p.gguf");
}

TEST(DecisionEngineConfigTest, CpuKeepsEveryLayerAndTheProjectorOnTheCpu) {
  const json p =
      params({{"device", "cpu"}, {"gpu_layers", "99"}, {"mmproj", "/p.gguf"}});
  EXPECT_EQ(p.at("n_gpu_layers"), 0);
  EXPECT_EQ(p.at("mmproj_use_gpu"), false);
}

TEST(DecisionEngineConfigTest, UnsetOptionsAreLeftToUpstream) {
  const json p = params({{"device", "gpu"}});
  EXPECT_FALSE(p.contains("n_gpu_layers"));
  EXPECT_FALSE(p.contains("n_ctx"));
  EXPECT_FALSE(p.contains("mmproj"));
  EXPECT_FALSE(p.contains("mmproj_use_gpu"));
}

// openclCacheDir is applied by the addon's shared backend initializer before
// the engine is created (GGML_OPENCL_CACHE_DIR, Android), not by the runtime.
TEST(DecisionEngineConfigTest, OpenclCacheDirIsAcceptedAndNotARuntimeParam) {
  const json p = params({{"device", "gpu"}, {"openclCacheDir", "/data/cache"}});
  EXPECT_FALSE(p.contains("openclCacheDir"));
}

TEST(DecisionEngineConfigTest, RejectsBadOptions) {
  const std::string invalid = "[ GTE :: InvalidConfiguration ]";
  EXPECT_EQ(codeOf([] { params({}); }), invalid) << "device is required";
  EXPECT_EQ(codeOf([] { params({{"device", "npu"}}); }), invalid);
  EXPECT_EQ(
      codeOf([] { params({{"device", "cpu"}, {"pooling", "mean"}}); }),
      invalid);
  EXPECT_EQ(
      codeOf([] { params({{"device", "cpu"}, {"ctx_size", "4k"}}); }), invalid);
  EXPECT_EQ(
      codeOf([] { params({{"device", "cpu"}, {"parallel", "0"}}); }), invalid);
}

TEST(DecisionEngineConfigTest, ConstructorRejectsBadOptionsBeforeLoading) {
  EXPECT_EQ(
      codeOf([] {
        DecisionEngineModel model(
            "unused.gguf", {{"device", "cpu"}, {"pooling", "mean"}});
      }),
      "[ GTE :: InvalidConfiguration ]");
}

TEST(DecisionEngineLoadTest, RejectsAModelWithoutDecisionMetadata) {
  const std::string path = findModel("models/unit-test/test-model.gguf");
  if (path.empty()) {
    FAIL() << "Test model not found: models/unit-test/test-model.gguf";
  }
  DecisionEngineModel model(path, {{"device", "cpu"}});
  EXPECT_EQ(
      codeOf([&] { model.waitForLoadInitialization(); }),
      "[ GTE :: UnsupportedModel ]");
}

TEST(DecisionEngineLoadTest, MissingFileFailsToLoad) {
  DecisionEngineModel model("/nonexistent/decision.gguf", {{"device", "cpu"}});
  EXPECT_EQ(
      codeOf([&] { model.waitForLoadInitialization(); }),
      "[ GTE :: UnableToLoadModel ]");
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
      "[ GTE :: UnableToLoadModel ]");
  EXPECT_EQ(
      outcomeOf([&] { model.process(std::string("{}"), 3); }),
      "[ GTE :: UnableToLoadModel ]");
}

namespace qdecision = qvac_lib_infer_llamacpp_decision;

// The runtime validates slot and batch counts itself, independently of the
// addon's option checks. Validation runs before the model file is read.
TEST(DecisionRuntimeTest, RejectsUnusableSlotAndBatchCountsBeforeLoading) {
  for (const char* params :
       {R"({"model":"/nonexistent.gguf","n_parallel":0})",
        R"({"model":"/nonexistent.gguf","n_parallel":-1})",
        R"({"model":"/nonexistent.gguf","n_batch":0})",
        R"({"model":"/nonexistent.gguf","n_ubatch":0})",
        R"({"model":"/nonexistent.gguf","n_ctx":-1})"}) {
    const auto created = qdecision::DecisionRuntime::create(params);
    EXPECT_EQ(created.outcome.status, qdecision::DecisionStatus::InvalidRequest)
        << params;
    EXPECT_EQ(created.runtime, nullptr) << params;
    EXPECT_NE(created.outcome.json.find("must be"), std::string::npos)
        << created.outcome.json;
  }
}

TEST(DecisionRuntimeTest, MissingModelFileIsAnErrorAndNothingRuns) {
  const auto created =
      qdecision::DecisionRuntime::create(R"({"model":"/nonexistent.gguf"})");
  EXPECT_EQ(created.outcome.status, qdecision::DecisionStatus::Error);
  EXPECT_EQ(created.runtime, nullptr);
  EXPECT_NE(
      created.outcome.json.find("model file not found"), std::string::npos)
      << created.outcome.json;
}

TEST(DecisionRuntimeTest, RejectsBadParamsJson) {
  for (const char* params : {"not json", "{}", R"({"model":""})"}) {
    const auto created = qdecision::DecisionRuntime::create(params);
    EXPECT_EQ(created.outcome.status, qdecision::DecisionStatus::InvalidRequest)
        << params;
    EXPECT_EQ(created.runtime, nullptr) << params;
  }
}

namespace {

/// A request whose state is `depth` nested arrays.
std::string nestedRequest(int depth) {
  return R"({"state":)" + std::string(static_cast<size_t>(depth), '[') +
         std::string(static_cast<size_t>(depth), ']') +
         R"(,"questions":{"q":{"type":"noul","instructions":"?"}}})";
}

/// One loaded runtime on the tiny openjev fixture, shared by the tests below.
class DecisionRuntimeModelTest : public ::testing::Test {
protected:
  static void SetUpTestSuite() {
    const std::string model = fixture("tinyopenjev-for-testing-Q8_0.gguf");
    if (model.empty()) {
      return;
    }
    json p = json::object();
    p["model"] = model;
    p["n_gpu_layers"] = 0;
    p["n_ctx"] = 2048;
    auto created = qdecision::DecisionRuntime::create(p.dump());
    ASSERT_EQ(created.outcome.status, qdecision::DecisionStatus::Ok)
        << created.outcome.json;
    runtime_ = std::move(created.runtime);
  }
  static void TearDownTestSuite() { runtime_.reset(); }
  void SetUp() override {
    if (!runtime_) {
      GTEST_SKIP() << "decision fixtures not found (set DECISION_TEST_MODELS)";
    }
  }
  static std::unique_ptr<qdecision::DecisionRuntime> runtime_;
};
std::unique_ptr<qdecision::DecisionRuntime> DecisionRuntimeModelTest::runtime_;

} // namespace

TEST_F(DecisionRuntimeModelTest, DepthGuardAccepts128AndRejects129AndDeeper) {
  const auto ok = runtime_->run(nestedRequest(128), nullptr);
  // Depth 128 passes the guard; the model may still reject the payload.
  EXPECT_EQ(ok.json.find("nested more than"), std::string::npos) << ok.json;

  for (const int depth : {129, 5000}) {
    const auto rejected = runtime_->run(nestedRequest(depth), nullptr);
    EXPECT_EQ(rejected.status, qdecision::DecisionStatus::InvalidRequest);
    EXPECT_NE(
        rejected.json.find("nested more than 128 levels"), std::string::npos)
        << rejected.json;
  }
}

TEST_F(DecisionRuntimeModelTest, ATokenCancelledBeforeTheRunIsCancelled) {
  auto token = std::make_shared<qdecision::DecisionCancelToken>();
  token->request();
  const auto outcome = runtime_->run(kRequest, token);
  EXPECT_EQ(outcome.status, qdecision::DecisionStatus::Cancelled);

  // A fresh token runs normally afterwards.
  const auto next = runtime_->run(
      kRequest, std::make_shared<qdecision::DecisionCancelToken>());
  EXPECT_EQ(next.status, qdecision::DecisionStatus::Ok) << next.json;
  EXPECT_TRUE(json::parse(next.json).contains("answers"));
}

TEST_F(DecisionRuntimeModelTest, ReportsInfoAndMapsUpstreamRejections) {
  const json info = json::parse(runtime_->info());
  EXPECT_EQ(info["decision_type"], "openjev");
  EXPECT_EQ(info["max_json_depth"], qdecision::kDecisionMaxJsonDepth);

  const auto outcome = runtime_->run(
      R"({"state":"x","questions":{"q":{"type":"score","instructions":"?",)"
      R"("criteria":["a","b","c","d","e","f","g","h","i","j","k"]}}})",
      nullptr);
  EXPECT_EQ(outcome.status, qdecision::DecisionStatus::InvalidRequest);
  EXPECT_TRUE(json::parse(outcome.json).contains("error")) << outcome.json;
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
  EXPECT_EQ(codeOf([&] { run("{not json"); }), "[ GTE :: InvalidRequest ]");
  const std::string deep =
      R"({"state":)" + std::string(129, '[') + std::string(129, ']') +
      R"(,"questions":{"q":{"type":"noul","instructions":"?"}}})";
  EXPECT_EQ(codeOf([&] { run(deep); }), "[ GTE :: InvalidRequest ]");
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
