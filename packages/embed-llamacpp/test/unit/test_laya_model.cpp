#include <any>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <thread>
#include <unordered_map>
#include <variant>
#include <vector>

#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>
#include <nlohmann/json.hpp>

#include "addon/BertErrors.hpp"
#include "model-interface/LayaModel.hpp"
#include "model-interface/logging.hpp"
#include "test_common.hpp"

namespace fs = std::filesystem;
using json = nlohmann::ordered_json;
using namespace qvac_lib_inference_addon_cpp::logger;

namespace {

/// First existing candidate, relative to the working directory or the build
/// tree (build/test/unit), or empty.
std::string findModel(const std::string& relative) {
  fs::path backendDir;
#ifdef TEST_BINARY_DIR
  backendDir = fs::path(TEST_BINARY_DIR);
#else
  backendDir = fs::current_path() / "build" / "test" / "unit";
#endif
  for (const fs::path& path :
       {fs::path{relative},
        fs::path{"../../.."} / relative,
        backendDir.parent_path().parent_path().parent_path() / relative}) {
    if (fs::exists(path)) {
      return fs::absolute(path).string();
    }
  }
  return "";
}

std::string backendsDir() {
#ifdef TEST_BINARY_DIR
  return std::string(TEST_BINARY_DIR);
#else
  return (fs::current_path() / "build" / "test" / "unit").string();
#endif
}

std::unordered_map<std::string, std::string> deviceConfig() {
  return {
      {"device", test_common::getTestDevice()},
      {"gpu_layers", test_common::getTestGpuLayers()}};
}

std::string codeOf(const std::function<void()>& call) {
  try {
    call();
  } catch (const qvac_errors::StatusError& error) {
    return error.codeString();
  }
  return "no error";
}

/// A Laya checkpoint: LAYA_TEST_MODEL, or models/unit-test/laya-test.gguf.
/// CI provides neither yet, so the tests that need one skip there.
std::string layaModelPath() {
  if (const char* env = std::getenv("LAYA_TEST_MODEL")) {
    return fs::exists(env) ? std::string(env) : std::string();
  }
  return findModel("models/unit-test/laya-test.gguf");
}

std::unordered_map<std::string, double> statsOf(const LayaModel& model) {
  std::unordered_map<std::string, double> stats;
  for (const auto& [key, value] : model.runtimeStats()) {
    stats[key] =
        std::visit([](auto v) { return static_cast<double>(v); }, value);
  }
  return stats;
}

const char* kTicketRequest = R"({
  "state": "My payment failed twice and I was charged both times. Please refund the duplicate.",
  "questions": {
    "department": {"type": "choice", "instructions": "Which team should handle this ticket?",
                   "criteria": {"billing": "payments, refunds, invoices", "technical": "bugs, outages, errors"}},
    "urgency":    {"type": "score", "instructions": "How urgent is this?",
                   "criteria": ["not urgent", "somewhat urgent", "very urgent"]},
    "refund":     {"type": "noul", "instructions": "The customer asks for a refund."}
  }
})";

} // namespace

TEST(LayaModelConfigTest, AcceptsLayaLoadOptions) {
  const std::unordered_map<std::string, std::string> config = {
      {"device", "gpu"},
      {"gpu_layers", "99"},
      {"batch_size", "1024"},
      {"verbosity", "1"},
      {"main-gpu", "0"},
      {"split-mode", "none"},
      {"flash_attn", "auto"},
      {"openclCacheDir", "/tmp"}};
  EXPECT_NO_THROW(LayaModel::checkConfig(config));
}

TEST(LayaModelConfigTest, RejectsOptionsThatDoNotApply) {
  for (const char* key :
       {"pooling",
        "ctx_size",
        "ctx-size",
        "embd_normalize",
        "attention",
        "ubatch-size",
        "parallel"}) {
    const std::unordered_map<std::string, std::string> config = {
        {"device", "cpu"}, {key, "1"}};
    try {
      LayaModel::checkConfig(config);
      FAIL() << key << " must be rejected";
    } catch (const qvac_errors::StatusError& error) {
      EXPECT_EQ(error.codeString(), "[ GTE :: InvalidConfiguration ]") << key;
      EXPECT_NE(std::string(error.what()).find(key), std::string::npos)
          << error.what();
    }
  }
}

TEST(LayaModelConfigTest, ConstructorRejectsOptionsThatDoNotApply) {
  EXPECT_EQ(
      codeOf([] {
        LayaModel model(
            "unused.gguf", {{"device", "cpu"}, {"pooling", "mean"}}, "");
      }),
      "[ GTE :: InvalidConfiguration ]");
}

TEST(LayaModelLoadTest, RejectsNonLayaModel) {
  const std::string path = findModel("models/unit-test/test-model.gguf");
  if (path.empty()) {
    FAIL() << "Test model not found: models/unit-test/test-model.gguf";
  }
  LayaModel model(path, {{"device", "cpu"}}, "");
  model.initializeBackend(backendsDir());
  EXPECT_EQ(
      codeOf([&] { model.waitForLoadInitialization(); }),
      "[ GTE :: UnsupportedModel ]");
  EXPECT_FALSE(model.isLoaded());
}

/// Needs a Laya checkpoint, see layaModelPath().
class LayaModelTest : public ::testing::Test {
protected:
  void SetUp() override {
    modelPath_ = layaModelPath();
    if (modelPath_.empty()) {
      GTEST_SKIP() << "Laya test model not found (set LAYA_TEST_MODEL or add "
                      "models/unit-test/laya-test.gguf)";
    }
    model_ = std::make_unique<LayaModel>(modelPath_, deviceConfig(), "");
    model_->initializeBackend(backendsDir());
    model_->waitForLoadInitialization();
    ASSERT_TRUE(model_->isLoaded());
  }

  json predict(const std::string& request) {
    return json::parse(model_->predict(request).json);
  }

  std::string modelPath_;
  std::unique_ptr<LayaModel> model_;
};

TEST_F(LayaModelTest, AnswersAllQuestionTypes) {
  const json res = predict(kTicketRequest);
  const json& answers = res.at("answers");

  EXPECT_EQ(answers.at("department").at("choice"), "billing");
  EXPECT_GT(answers.at("department").at("probabilities").at("billing"), 0.5);

  const double score = answers.at("urgency").at("score");
  EXPECT_GE(score, 0.0);
  EXPECT_LE(score, 2.0);
  EXPECT_EQ(answers.at("urgency").at("probabilities").size(), 3U);

  EXPECT_GT(answers.at("refund").at("noul"), 0.5);
  EXPECT_TRUE(res.contains("usage"));
}

TEST_F(LayaModelTest, BatchRequestReturnsOneResultPerState) {
  const json res = predict(R"({
    "states": ["The app crashes on startup.", "Please send me last month's invoice.", ["Hi", "Where is my order?"]],
    "questions": {"department": {"type": "choice", "instructions": "Which team?",
                                 "criteria": ["billing", "technical", "shipping"]}}
  })");
  ASSERT_TRUE(res.is_array());
  ASSERT_EQ(res.size(), 3U);
  EXPECT_EQ(res[0].at("answers").at("department").at("choice"), "technical");
  EXPECT_EQ(res[1].at("answers").at("department").at("choice"), "billing");
}

TEST_F(LayaModelTest, SameAnswerAloneAndInBatch) {
  const json alone = predict(kTicketRequest);
  json batch = json::parse(kTicketRequest);
  batch["states"] = json::array(
      {"The app crashes on startup.", batch.at("state"), "Thanks, all good."});
  batch.erase("state");
  const json packed = predict(batch.dump());

  const json& a = alone.at("answers");
  const json& b = packed.at(1).at("answers");
  EXPECT_EQ(a.at("department").at("choice"), b.at("department").at("choice"));
  EXPECT_NEAR(
      a.at("refund").at("noul").get<double>(),
      b.at("refund").at("noul").get<double>(),
      1e-3);
  EXPECT_NEAR(
      a.at("urgency").at("score").get<double>(),
      b.at("urgency").at("score").get<double>(),
      1e-3);
}

TEST_F(LayaModelTest, InvalidJsonIsInvalidRequest) {
  EXPECT_EQ(
      codeOf([&] { model_->predict("{not json"); }),
      "[ GTE :: InvalidRequest ]");
}

TEST_F(LayaModelTest, MalformedRequestIsInvalidRequest) {
  for (
      const char* request :
      {R"({"state": "x", "questions": {"q": {"type": "pick-one", "instructions": "?"}}})",
       R"({"state": null, "questions": {}})",
       R"({"state": "x", "questions": {"q": {"type": "choice", "instructions": "?"}}})",
       R"({"state": "x", "max_len": -1, "questions": {}})",
       R"([1, 2, 3])"}) {
    EXPECT_EQ(
        codeOf([&] { model_->predict(request); }), "[ GTE :: InvalidRequest ]")
        << request;
  }
  // The model still answers after rejected requests.
  EXPECT_EQ(
      predict(kTicketRequest).at("answers").at("department").at("choice"),
      "billing");
}

TEST_F(LayaModelTest, ProcessRejectsNonStringInput) {
  EXPECT_EQ(
      codeOf([&] { model_->process(std::any(42)); }),
      "[ General :: InvalidArgument ]");
}

TEST_F(LayaModelTest, ProcessReturnsLayaDecisionResult) {
  const std::any out = model_->process(std::any(std::string(kTicketRequest)));
  ASSERT_EQ(out.type(), typeid(LayaDecisionResult));
  EXPECT_NO_THROW(
      (void)json::parse(std::any_cast<const LayaDecisionResult&>(out).json));
}

TEST_F(LayaModelTest, RuntimeStatsDescribeLastRequest) {
  (void)predict(kTicketRequest);
  const std::unordered_map<std::string, double> stats = statsOf(*model_);
  EXPECT_EQ(stats.at("sequences"), 3.0); // one per question
  EXPECT_GE(stats.at("forward_passes"), 1.0);
  EXPECT_GT(stats.at("total_tokens"), 0.0);
  EXPECT_GT(stats.at("total_time_ms"), 0.0);
  EXPECT_EQ(stats.at("batch_size"), 2048.0);
}

TEST(LayaModelBatchTest, BatchSizeSetsTheContext) {
  const std::string path = layaModelPath();
  if (path.empty()) {
    GTEST_SKIP() << "Laya test model not found, see layaModelPath()";
  }
  auto config = deviceConfig();
  config["batch_size"] = "512";
  LayaModel model(path, config, "");
  model.initializeBackend(backendsDir());
  model.waitForLoadInitialization();

  (void)model.predict(kTicketRequest);
  const auto stats = statsOf(model);
  EXPECT_EQ(stats.at("batch_size"), 512.0);
  EXPECT_EQ(stats.at("context_size"), 512.0);

  // A sequence longer than the batch (up to max_len 1024 tokens) is rejected.
  std::string longState;
  for (int i = 0; i < 900; ++i) {
    longState += "payment ";
  }
  json request = json::parse(kTicketRequest);
  request["state"] = longState;
  try {
    (void)model.predict(request.dump());
    FAIL() << "a sequence longer than batch_size must be rejected";
  } catch (const qvac_errors::StatusError& error) {
    EXPECT_EQ(error.codeString(), "[ GTE :: InvalidRequest ]");
    EXPECT_NE(
        std::string(error.what()).find("batch size 512"), std::string::npos)
        << error.what();
  }
}

TEST(LayaModelBatchTest, TooSmallBatchSizeIsInvalidConfiguration) {
  const std::string path = layaModelPath();
  if (path.empty()) {
    GTEST_SKIP() << "Laya test model not found, see layaModelPath()";
  }
  auto config = deviceConfig();
  config["batch_size"] = "16";
  LayaModel model(path, config, "");
  model.initializeBackend(backendsDir());
  EXPECT_EQ(
      codeOf([&] { model.waitForLoadInitialization(); }),
      "[ GTE :: InvalidConfiguration ]");
  EXPECT_FALSE(model.isLoaded());
}

/// Cancels a request of many forward passes once it is running.
/// @returns whether predict ended with "Job cancelled", and its duration.
std::pair<bool, std::chrono::milliseconds> cancelLongRequest(LayaModel& model) {
  json request = json::parse(kTicketRequest);
  request.erase("state");
  request["questions"].erase("urgency");
  json states = json::array();
  for (int i = 0; i < 1500; ++i) {
    states.push_back(
        "Ticket " + std::to_string(i) +
        ": my payment failed twice and I was charged both times.");
  }
  request["states"] = states;
  const std::string body = request.dump();

  bool cancelled = false;
  const auto start = std::chrono::steady_clock::now();
  std::thread worker([&] {
    try {
      (void)model.predict(body);
    } catch (const std::runtime_error& e) {
      cancelled = std::string(e.what()) == "Job cancelled";
    }
  });
  std::this_thread::sleep_for(std::chrono::milliseconds(100));
  model.cancel();
  worker.join();
  return {
      cancelled,
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - start)};
}

TEST(LayaModelCancelTest, CancelStopsARunningRequestOnCpu) {
  const std::string path = layaModelPath();
  if (path.empty()) {
    GTEST_SKIP() << "Laya test model not found, see layaModelPath()";
  }
  LayaModel model(path, {{"device", "cpu"}}, "");
  model.initializeBackend(backendsDir());
  model.waitForLoadInitialization();

  const auto [cancelled, elapsed] = cancelLongRequest(model);
  EXPECT_TRUE(cancelled) << "finished in " << elapsed.count() << " ms";

  // The next request runs normally.
  EXPECT_EQ(
      json::parse(model.predict(kTicketRequest).json)
          .at("answers")
          .at("department")
          .at("choice"),
      "billing");
}

TEST(LayaModelCancelTest, CancelStopsARunningRequestOnGpu) {
  const std::string path = layaModelPath();
  if (path.empty()) {
    GTEST_SKIP() << "Laya test model not found, see layaModelPath()";
  }
  LayaModel model(path, deviceConfig(), "");
  model.initializeBackend(backendsDir());
  model.waitForLoadInitialization();

  // common_laya_predict loops over passes internally, so llama's abort
  // callback is the only way to stop it; it must reach the GPU backend too.
  const auto [cancelled, elapsed] = cancelLongRequest(model);
  EXPECT_TRUE(cancelled) << "finished in " << elapsed.count() << " ms";
}
