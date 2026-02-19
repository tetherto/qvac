#include <chrono>
#include <filesystem>
#include <memory>
#include <string>
#include <unordered_map>

#include <gtest/gtest.h>
#include <qvac-lib-inference-addon-cpp/addon/AddonCpp.hpp>

#include "addon/AddonCpp.hpp"
#include "test_common.hpp"

namespace fs = std::filesystem;

class AddonCppTest : public ::testing::Test {
protected:
  void SetUp() override {
    config_files["device"] = test_common::getTestDevice();
    config_files["ctx_size"] = "2048";
    config_files["gpu_layers"] = test_common::getTestGpuLayers();
    config_files["n_predict"] = "20";

    fs::path basePath;
    if (fs::exists(fs::path{"../../../models/unit-test"})) {
      basePath = fs::path{"../../../models/unit-test"};
    } else {
      basePath = fs::path{"models/unit-test"};
    }

    fs::path modelPath = basePath / "Llama-3.2-1B-Instruct-Q4_0.gguf";
    if (fs::exists(modelPath)) {
      test_model_path = modelPath.string();
    } else {
      modelPath = basePath / "test_model.gguf";
      if (fs::exists(modelPath)) {
        test_model_path = modelPath.string();
      } else {
        test_model_path = "Llama-3.2-1B-Instruct-Q4_0.gguf";
      }
    }
    test_projection_path = "";

    fs::path backendDir;
#ifdef TEST_BINARY_DIR
    backendDir = fs::path(TEST_BINARY_DIR);
#else
    backendDir = fs::current_path() / "build" / "test" / "unit";
#endif

    config_files["backendsDir"] = backendDir.string();
  }

  std::unordered_map<std::string, std::string> config_files;
  std::string test_model_path;
  std::string test_projection_path;

  std::string getValidModelPath() { return test_model_path; }
};

TEST_F(AddonCppTest, SimplePromptWithAddonCpp) {
  if (!fs::exists(getValidModelPath())) {
    GTEST_SKIP() << "Test model not found at: " << getValidModelPath();
  }

  std::string simple_prompt = R"([
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Say hello in one word."}
  ])";

  std::string model_path = test_model_path;
  std::string projector_path = test_projection_path;
  auto config_copy = config_files;

  qvac_lib_inference_addon_llama::AddonInstance addonInstance =
      qvac_lib_inference_addon_llama::createInstance(
          std::move(model_path),
          std::move(projector_path),
          std::move(config_copy));

  ASSERT_NE(addonInstance.addon, nullptr);
  ASSERT_NE(addonInstance.outputHandler, nullptr);

  // Activate the addon (waits for model loading)
  EXPECT_NO_THROW(addonInstance.addon->activate());

  // Run a job with a simple prompt
  EXPECT_NO_THROW(
      addonInstance.addon->runJob(LlamaModel::Prompt{.input = simple_prompt}));

  // Wait for the response with a timeout
  std::optional<std::string> answer =
      addonInstance.outputHandler->tryPop(std::chrono::seconds(30));

  EXPECT_TRUE(answer.has_value()) << "Response timed out";
  if (answer.has_value()) {
    EXPECT_FALSE(answer->empty()) << "Response should not be empty";
    std::cout << "Response: " << *answer << std::endl;
  }
}

TEST_F(AddonCppTest, StopDuringGeneration) {
  if (!fs::exists(getValidModelPath())) {
    GTEST_SKIP() << "Test model not found at: " << getValidModelPath();
  }

  // Use a prompt that would generate a long response
  std::string long_prompt = R"([
    {"role": "user", "content": "Tell me a very long story about a dragon."}
  ])";

  std::string model_path = test_model_path;
  std::string projector_path = test_projection_path;
  auto config_copy = config_files;
  config_copy["n_predict"] = "100"; // Allow more tokens

  qvac_lib_inference_addon_llama::AddonInstance addonInstance =
      qvac_lib_inference_addon_llama::createInstance(
          std::move(model_path),
          std::move(projector_path),
          std::move(config_copy));

  addonInstance.addon->activate();
  addonInstance.addon->runJob(LlamaModel::Prompt{.input = long_prompt});

  EXPECT_NO_THROW(addonInstance.addon->cancelJob());

  // After cancel: either no response (cancel won the race before generation
  // started) or one partial response (generation had started before stop was
  // observed). On darwin arm64 and other fast runners the latter is common.
  std::optional<std::string> answer =
      addonInstance.outputHandler->tryPop(std::chrono::seconds(1));

  if (answer.has_value()) {
    // If we got a response, it must be a short partial one (we requested a
    // long story and cancelled immediately).
    EXPECT_LT(answer->size(), 500u)
        << "Expected no or only partial response after cancellation, got "
        << answer->size() << " chars";
  }
}
