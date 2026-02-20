// Run/cancel scenarios below must match the behavior described in README
// section "API behavior by state". Cancellation is done via the addon
// (cancelJob()), which delegates to the model's cancel(); the JS API
// prefers model.cancel() and documents response.cancel() as equivalent.

#include <chrono>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include <gtest/gtest.h>
#include <qvac-lib-inference-addon-cpp/addon/AddonCpp.hpp>

#include "addon/AddonCpp.hpp"
#include "test_common.hpp"

namespace fs = std::filesystem;

class AddonCppTest : public ::testing::Test {
protected:
  void SetUp() override {
    config_["device"] = test_common::getTestDevice();
    config_["batch_size"] = "512";
    config_["ctx_size"] = "512";

    fs::path basePath;
    if (fs::exists(fs::path{"../../../models/unit-test"})) {
      basePath = fs::path{"../../../models/unit-test"};
    } else {
      basePath = fs::path{"models/unit-test"};
    }

    fs::path modelPath = basePath / "gte-small.gguf";
    if (fs::exists(modelPath)) {
      test_model_path_ = modelPath.string();
    } else {
      modelPath = basePath / "embeddinggemma-300M-Q8_0.gguf";
      if (fs::exists(modelPath)) {
        test_model_path_ = modelPath.string();
      } else {
        test_model_path_ = "gte-small.gguf";
      }
    }

    fs::path backendDir;
#ifdef TEST_BINARY_DIR
    backendDir = fs::path(TEST_BINARY_DIR);
#else
    backendDir = fs::current_path() / "build" / "test" / "unit";
#endif
    config_["backendsDir"] = backendDir.string();
  }

  std::unordered_map<std::string, std::string> config_;
  std::string test_model_path_;

  std::string getValidModelPath() { return test_model_path_; }
};

TEST_F(AddonCppTest, SimplePromptWithAddonCpp) {
  if (!fs::exists(getValidModelPath())) {
    GTEST_SKIP() << "Test model not found at: " << getValidModelPath();
  }

  std::string input = "Hello world";

  std::string model_path = getValidModelPath();
  auto config_copy = config_;
  std::string backends_dir = config_copy["backendsDir"];
  config_copy.erase("backendsDir");

  qvac_lib_inference_addon_embed::AddonInstance addonInstance =
      qvac_lib_inference_addon_embed::createInstance(
          std::move(model_path),
          std::move(config_copy),
          std::move(backends_dir));

  ASSERT_NE(addonInstance.addon, nullptr);
  ASSERT_NE(addonInstance.outputHandler, nullptr);

  addonInstance.addon->activate();

  addonInstance.addon->runJob(std::any(std::string(input)));

  std::optional<BertEmbeddings> result =
      addonInstance.outputHandler->tryPop(std::chrono::seconds(60));

  EXPECT_TRUE(result.has_value()) << "Response timed out";
  if (result.has_value()) {
    EXPECT_EQ(result->size(), 1u) << "Should have one embedding";
    EXPECT_GT(result->embeddingSize(), 0u)
        << "Embedding dimension should be > 0";
  }
}

TEST_F(AddonCppTest, StopDuringGeneration) {
  if (!fs::exists(getValidModelPath())) {
    GTEST_SKIP() << "Test model not found at: " << getValidModelPath();
  }

  // Many sequences so cancel has time to take effect
  std::vector<std::string> sequences(32);
  for (std::size_t i = 0; i < sequences.size(); ++i) {
    sequences[i] = "Sequence " + std::to_string(i) + " for cancel test.";
  }

  std::string model_path = getValidModelPath();
  auto config_copy = config_;
  std::string backends_dir = config_copy["backendsDir"];
  config_copy.erase("backendsDir");

  qvac_lib_inference_addon_embed::AddonInstance addonInstance =
      qvac_lib_inference_addon_embed::createInstance(
          std::move(model_path),
          std::move(config_copy),
          std::move(backends_dir));

  addonInstance.addon->activate();

  addonInstance.addon->runJob(std::any(sequences));

  // cancelJob() delegates to model->cancel(); same semantics as JS
  // model.cancel()
  EXPECT_NO_THROW(addonInstance.addon->cancelJob());

  // May get partial result or none
  std::optional<BertEmbeddings> answer =
      addonInstance.outputHandler->tryPop(std::chrono::seconds(2));

  (void)answer;
}

TEST_F(AddonCppTest, CancelWhenIdle) {
  if (!fs::exists(getValidModelPath())) {
    GTEST_SKIP() << "Test model not found at: " << getValidModelPath();
  }

  std::string model_path = getValidModelPath();
  auto config_copy = config_;
  std::string backends_dir = config_copy["backendsDir"];
  config_copy.erase("backendsDir");

  qvac_lib_inference_addon_embed::AddonInstance addonInstance =
      qvac_lib_inference_addon_embed::createInstance(
          std::move(model_path),
          std::move(config_copy),
          std::move(backends_dir));

  addonInstance.addon->activate();

  // Cancel when idle (no job): must not throw;
  EXPECT_NO_THROW(addonInstance.addon->cancelJob());
}
