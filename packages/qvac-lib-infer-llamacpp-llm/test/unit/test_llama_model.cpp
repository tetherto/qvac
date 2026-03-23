#include <atomic>
#include <chrono>
#include <exception>
#include <filesystem>
#include <memory>
#include <string>
#include <thread>
#include <unordered_map>

#include <gtest/gtest.h>
#include <llama.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>
#include <qvac-lib-inference-addon-cpp/RuntimeStats.hpp>

#include "model-interface/LlamaModel.hpp"
#include "test_common.hpp"

namespace fs = std::filesystem;

namespace {
double getStatValue(
    const qvac_lib_inference_addon_cpp::RuntimeStats& stats,
    const std::string& key) {
  for (const auto& stat : stats) {
    if (stat.first == key) {
      return std::visit(
          [](const auto& value) -> double {
            if constexpr (std::is_same_v<
                              std::decay_t<decltype(value)>,
                              double>) {
              return value;
            } else {
              return static_cast<double>(value);
            }
          },
          stat.second);
    }
  }
  return 0.0;
}
} // namespace

class LlamaModelTest : public ::testing::Test {
protected:
  void SetUp() override {
    config_files["device"] = test_common::getTestDevice();
    config_files["ctx_size"] = "2048";
    config_files["gpu_layers"] = test_common::getTestGpuLayers();
    config_files["n_predict"] = "10";

    test_model_path = test_common::BaseTestModelPath::get();
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

  std::string getInvalidModelPath() { return "nonexistent_model.gguf"; }

  LlamaModel createModel() {
    std::string modelPath = test_model_path;
    std::string projectionPath = test_projection_path;
    auto configCopy = config_files;
    return LlamaModel(
        std::move(modelPath), std::move(projectionPath), std::move(configCopy));
  }

  LlamaModel createModelWithConfig(
      std::unordered_map<std::string, std::string> customConfig) {
    std::string modelPath = test_model_path;
    std::string projectionPath = test_projection_path;
    return LlamaModel(
        std::move(modelPath),
        std::move(projectionPath),
        std::move(customConfig));
  }
};

TEST_F(LlamaModelTest, ConstructorValidParams) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  EXPECT_NO_THROW({ LlamaModel model = createModel(); });
}

TEST_F(LlamaModelTest, IsLoadedMethodBeforeInit) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model = createModel();
  EXPECT_FALSE(model.isLoaded());
}

TEST_F(LlamaModelTest, ReloadLoadsImmediatelyAndInferenceStillWorks) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model = createModel();
  model.waitForLoadInitialization();
  if (!model.isLoaded()) {
    FAIL() << "Model failed to load before reload";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello before reload"}])";
  EXPECT_NO_THROW({
    std::string output = model.processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
  });

  EXPECT_NO_THROW(model.reload());
  EXPECT_TRUE(model.isLoaded());

  prompt.input = R"([{"role": "user", "content": "Hello after reload"}])";
  EXPECT_NO_THROW({
    std::string output = model.processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
  });
}

TEST_F(LlamaModelTest, ReloadWithoutArgsUsesStoredConstructionArgs) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model = createModel();
  model.waitForLoadInitialization();
  if (!model.isLoaded()) {
    FAIL() << "Model failed to load before reload";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "First pass"}])";
  EXPECT_NO_THROW({
    std::string output = model.processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
  });

  EXPECT_NO_THROW(model.reload());
  EXPECT_TRUE(model.isLoaded());

  prompt.input = R"([{"role": "user", "content": "Second pass"}])";
  EXPECT_NO_THROW({
    std::string output = model.processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
  });
}

TEST_F(LlamaModelTest, ReloadThrowsForModelBuiltWithInvalidPath) {
  std::string invalidPath = getInvalidModelPath();
  std::string projectionPath = test_projection_path;
  std::unordered_map<std::string, std::string> config = config_files;
  LlamaModel model(
      std::move(invalidPath), std::move(projectionPath), std::move(config));

  // Constructor uses delayed init and does not throw immediately.
  EXPECT_FALSE(model.isLoaded());
  EXPECT_THROW(model.reload(), qvac_errors::StatusError);
}

TEST_F(LlamaModelTest, InvalidModelPath) {
  std::string invalid_path = getInvalidModelPath();
  std::unordered_map<std::string, std::string> empty_config;
  empty_config["device"] = "cpu";

  EXPECT_NO_THROW({
    std::string projectionPath = test_projection_path;
    LlamaModel model(
        std::move(invalid_path),
        std::move(projectionPath),
        std::move(empty_config));
    EXPECT_FALSE(model.isLoaded());
  });
}

TEST_F(LlamaModelTest, InvalidConfig) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  std::unordered_map<std::string, std::string> invalid_config;
  invalid_config["device"] = "cpu";
  invalid_config["invalid.json"] = "invalid json content";

  EXPECT_NO_THROW(
      { LlamaModel model = createModelWithConfig(std::move(invalid_config)); });
}

TEST_F(LlamaModelTest, RuntimeStatsBeforeProcessing) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model = createModel();
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  auto stats = model.runtimeStats();
  EXPECT_GE(stats.size(), 0);
}

TEST_F(LlamaModelTest, ResetMethod) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model = createModel();
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    GTEST_SKIP() << "Model failed to load";
  }

  EXPECT_NO_THROW(model.reset());
}

TEST_F(LlamaModelTest, ProcessStringInput) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model = createModel();
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello, how are you?"}])";
  EXPECT_NO_THROW({
    std::string output = model.processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    auto stats = model.runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(LlamaModelTest, ProcessWithCallback) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model = createModel();
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  std::vector<std::string> received_tokens;

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello"}])";
  prompt.outputCallback = [&received_tokens](const std::string& token) {
    received_tokens.push_back(token);
  };

  EXPECT_NO_THROW({
    std::string output = model.processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    EXPECT_GT(received_tokens.size(), 0);
    auto stats = model.runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(LlamaModelTest, ProcessBinaryInput) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model = createModel();
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  std::vector<uint8_t> binary_input = {0x48, 0x65, 0x6c, 0x6c, 0x6f};
  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "What is this?"}])";
  prompt.media.push_back(std::move(binary_input));
  if (test_projection_path.empty()) {
    EXPECT_THROW({ model.processPrompt(prompt); }, qvac_errors::StatusError);
  } else {
    EXPECT_NO_THROW({
      std::string output = model.processPrompt(prompt);
      EXPECT_GE(output.length(), 0);
      auto stats = model.runtimeStats();
      EXPECT_GE(stats.size(), 0);
    });
  }
}

TEST_F(LlamaModelTest, ProcessEmptyInput) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model = createModel();
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = "";
  EXPECT_THROW({ model.processPrompt(prompt); }, qvac_errors::StatusError);
}

TEST_F(LlamaModelTest, ProcessAfterInitialization) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  {
    SCOPED_TRACE("Creating LlamaModel");

    LlamaModel model = createModel();

    {
      SCOPED_TRACE("Calling waitForLoadInitialization()");

      model.waitForLoadInitialization();
    }

    if (!model.isLoaded()) {
      FAIL() << "Model failed to load";
    }

    {
      SCOPED_TRACE("Calling processPrompt()");

      LlamaModel::Prompt prompt;
      prompt.input = R"([{"role": "user", "content": "Hello."}])";
      EXPECT_NO_THROW({
        std::string output = model.processPrompt(prompt);
        EXPECT_GE(output.length(), 0);
        auto stats = model.runtimeStats();
        EXPECT_GE(stats.size(), 0);
      });
    }

    EXPECT_TRUE(model.isLoaded());
  }
}

TEST_F(LlamaModelTest, IsLoadedAfterProcessing) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model = createModel();
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello"}])";
  EXPECT_NO_THROW({
    std::string output = model.processPrompt(prompt);
    EXPECT_TRUE(model.isLoaded());
    auto stats = model.runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(LlamaModelTest, RuntimeStatsAfterProcessing) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model = createModel();
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello, world!"}])";
  EXPECT_NO_THROW({
    std::string output = model.processPrompt(prompt);
    EXPECT_GE(output.length(), 0);

    auto stats = model.runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(LlamaModelTest, RuntimeStatsAfterReset) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model = createModel();
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello"}])";
  EXPECT_NO_THROW({
    std::string output = model.processPrompt(prompt);
    EXPECT_GE(output.length(), 0);

    auto statsBefore = model.runtimeStats();
    EXPECT_FALSE(statsBefore.empty());

    model.reset();
    auto statsAfter = model.runtimeStats();
    EXPECT_GE(statsAfter.size(), 0);
  });
}

TEST_F(LlamaModelTest, CancelMethod) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model = createModel();
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW(model.cancel());
}

TEST_F(LlamaModelTest, MultipleProcessCalls) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model = createModel();
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello"}])";

  for (int i = 0; i < 3; ++i) {
    EXPECT_NO_THROW({
      std::string output = model.processPrompt(prompt);
      EXPECT_GE(output.length(), 0);
      auto stats = model.runtimeStats();
      EXPECT_GE(stats.size(), 0);
    });
  }
}

TEST_F(LlamaModelTest, DestructorCleanup) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  {
    LlamaModel model = createModel();
    model.waitForLoadInitialization();

    if (model.isLoaded()) {
      LlamaModel::Prompt prompt;
      prompt.input = R"([{"role": "user", "content": "Hello"}])";
      EXPECT_NO_THROW({
        std::string output = model.processPrompt(prompt);
        EXPECT_GE(output.length(), 0);
        auto stats = model.runtimeStats();
        EXPECT_GE(stats.size(), 0);
      });
    }
  }
}

TEST_F(LlamaModelTest, SetWeightsForFile) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model = createModel();

  std::string filename1 = "test_model.gguf";
  std::string test_data1 = "test weight data";
  auto shard1 = std::make_unique<std::stringbuf>(test_data1);

  EXPECT_NO_THROW({ model.setWeightsForFile(filename1, std::move(shard1)); });

  std::string filename2 = "test_model2.gguf";
  std::string test_data2 = "more test weight data";
  auto shard2 = std::make_unique<std::stringbuf>(test_data2);

  EXPECT_NO_THROW({ model.setWeightsForFile(filename2, std::move(shard2)); });
}

TEST_F(LlamaModelTest, LlamaLogCallback) {
  EXPECT_NO_THROW({
    LlamaModel::llamaLogCallback(
        GGML_LOG_LEVEL_ERROR, "Test error message", nullptr);
    LlamaModel::llamaLogCallback(
        GGML_LOG_LEVEL_WARN, "Test warning message", nullptr);
    LlamaModel::llamaLogCallback(
        GGML_LOG_LEVEL_INFO, "Test info message", nullptr);
    LlamaModel::llamaLogCallback(
        GGML_LOG_LEVEL_DEBUG, "Test debug message", nullptr);
    LlamaModel::llamaLogCallback(
        GGML_LOG_LEVEL_NONE, "Test none message", nullptr);
    LlamaModel::llamaLogCallback(
        GGML_LOG_LEVEL_CONT, "Test cont message", nullptr);
  });
}

TEST_F(LlamaModelTest, InvalidJSONInput) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model = createModel();
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = "[{invalid json}";
  EXPECT_THROW({ model.processPrompt(prompt); }, std::exception);
}

TEST_F(LlamaModelTest, MalformedChatMessageFormat) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model = createModel();
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt1;
  prompt1.input = R"([{"content": "Hello"}])";
  EXPECT_THROW({ model.processPrompt(prompt1); }, qvac_errors::StatusError);

  LlamaModel::Prompt prompt2;
  prompt2.input = R"([{"role": "user"}])";
  EXPECT_THROW({ model.processPrompt(prompt2); }, qvac_errors::StatusError);
}

TEST_F(LlamaModelTest, EmptyMessagesArray) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model = createModel();
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = "[]";
  EXPECT_NO_THROW({
    std::string output = model.processPrompt(prompt);
    EXPECT_EQ(output.length(), 0);
    auto stats = model.runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(LlamaModelTest, VeryLongInput) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model = createModel();
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  std::string long_content(10000, 'a');

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": ")" + long_content + R"("}])";

  EXPECT_NO_THROW({
    std::string output = model.processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    auto stats = model.runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(LlamaModelTest, SpecialCharactersAndUnicode) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model = createModel();
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello 世界 🌍"}])";
  EXPECT_NO_THROW({
    std::string output = model.processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    auto stats = model.runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(LlamaModelTest, CommonParamsParseMissingDevice) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  std::unordered_map<std::string, std::string> config_no_device;
  config_no_device["ctx_size"] = "2048";
  config_no_device["gpu_layers"] = test_common::getTestGpuLayers();
  config_no_device["n_predict"] = "10";

  fs::path backendDir;
#ifdef TEST_BINARY_DIR
  backendDir = fs::path(TEST_BINARY_DIR);
#else
  backendDir = fs::current_path() / "build" / "test" / "unit";
#endif
  config_no_device["backendsDir"] = backendDir.string();

  EXPECT_THROW(
      {
        LlamaModel model(
            getValidModelPath(),
            std::string(test_projection_path),
            std::unordered_map<std::string, std::string>(config_no_device));
        model.waitForLoadInitialization();
      },
      qvac_errors::StatusError);
}

TEST_F(LlamaModelTest, CommonParamsParseInvalidNDiscarded) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  std::unordered_map<std::string, std::string> config;
  config["device"] = test_common::getTestDevice();
  config["ctx_size"] = "2048";
  config["gpu_layers"] = test_common::getTestGpuLayers();
  config["n_predict"] = "10";
  config["n_discarded"] = "not_a_number";

  fs::path backendDir;
#ifdef TEST_BINARY_DIR
  backendDir = fs::path(TEST_BINARY_DIR);
#else
  backendDir = fs::current_path() / "build" / "test" / "unit";
#endif
  config["backendsDir"] = backendDir.string();

  EXPECT_THROW(
      {
        LlamaModel model(
            getValidModelPath(),
            std::string(test_projection_path),
            std::unordered_map<std::string, std::string>(config));
        model.waitForLoadInitialization();
      },
      qvac_errors::StatusError);
}

TEST_F(LlamaModelTest, CommonParamsParseInvalidArgument) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  std::unordered_map<std::string, std::string> config;
  config["device"] = test_common::getTestDevice();
  config["ctx_size"] = "2048";
  config["gpu_layers"] = test_common::getTestGpuLayers();
  config["n_predict"] = "10";
  config["invalid_arg_name_xyz"] = "value";

  fs::path backendDir;
#ifdef TEST_BINARY_DIR
  backendDir = fs::path(TEST_BINARY_DIR);
#else
  backendDir = fs::current_path() / "build" / "test" / "unit";
#endif
  config["backendsDir"] = backendDir.string();

  EXPECT_THROW(
      {
        LlamaModel model(
            getValidModelPath(),
            std::string(test_projection_path),
            std::unordered_map<std::string, std::string>(config));
        model.waitForLoadInitialization();
      },
      qvac_errors::StatusError);
}

TEST_F(LlamaModelTest, FormatPromptMediaInTextOnlyModel) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model(
      getValidModelPath(),
      std::string(test_projection_path),
      std::unordered_map<std::string, std::string>(config_files));
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  std::string input =
      R"([{"role": "user", "type": "media", "content": "base64data"}])";
  EXPECT_THROW({ model.process(input); }, qvac_errors::StatusError);
}

TEST_F(LlamaModelTest, FormatPromptMediaWithoutUserMessage) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  std::string multimodalModelPath = test_common::BaseTestModelPath::get(
      "SmolVLM-500M-Instruct-Q8_0.gguf", "SmolVLM-500M-Instruct.gguf");
  std::string projectionPath = test_common::BaseTestModelPath::get(
      "mmproj-SmolVLM-500M-Instruct-Q8_0.gguf",
      "mmproj-SmolVLM-500M-Instruct.gguf");

  if (!fs::exists(multimodalModelPath) || !fs::exists(projectionPath)) {
    FAIL() << "Multimodal model and projection required for this test";
  }

  LlamaModel model(
      std::move(multimodalModelPath),
      std::move(projectionPath),
      std::unordered_map<std::string, std::string>(config_files));
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  std::string input = R"([
    {"role": "user", "type": "media", "content": "data"},
    {"role": "assistant", "content": "response"}
  ])";
  EXPECT_THROW({ model.process(input); }, qvac_errors::StatusError);
}

TEST_F(LlamaModelTest, FormatPromptMediaWithoutRequest) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  std::string multimodalModelPath = test_common::BaseTestModelPath::get(
      "SmolVLM-500M-Instruct-Q8_0.gguf", "SmolVLM-500M-Instruct.gguf");
  std::string projectionPath = test_common::BaseTestModelPath::get(
      "mmproj-SmolVLM-500M-Instruct-Q8_0.gguf",
      "mmproj-SmolVLM-500M-Instruct.gguf");

  if (!fs::exists(multimodalModelPath) || !fs::exists(projectionPath)) {
    FAIL() << "Multimodal model and projection required for this test";
  }

  LlamaModel model(
      std::move(multimodalModelPath),
      std::move(projectionPath),
      std::unordered_map<std::string, std::string>(config_files));
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  std::string input =
      R"([{"role": "user", "type": "media", "content": "data"}])";
  EXPECT_THROW({ model.process(input); }, qvac_errors::StatusError);
}

TEST_F(LlamaModelTest, ProcessContextOverflow) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  std::unordered_map<std::string, std::string> small_ctx_config;
  small_ctx_config["device"] = test_common::getTestDevice();
  small_ctx_config["ctx_size"] = "128";
  small_ctx_config["gpu_layers"] = test_common::getTestGpuLayers();
  small_ctx_config["n_predict"] = "10";

  fs::path backendDir;
#ifdef TEST_BINARY_DIR
  backendDir = fs::path(TEST_BINARY_DIR);
#else
  backendDir = fs::current_path() / "build" / "test" / "unit";
#endif
  small_ctx_config["backendsDir"] = backendDir.string();

  LlamaModel model(
      getValidModelPath(),
      std::string(test_projection_path),
      std::unordered_map<std::string, std::string>(small_ctx_config));
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  std::string long_content(50000, 'a');
  std::string input =
      R"([{"role": "user", "content": ")" + long_content + R"("}])";

  EXPECT_THROW({ model.process(input); }, qvac_errors::StatusError);
}

TEST_F(LlamaModelTest, ProcessContextOverflowAfterDiscardFails) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  std::unordered_map<std::string, std::string> small_ctx_config;
  small_ctx_config["device"] = test_common::getTestDevice();
  small_ctx_config["ctx_size"] = "256";
  small_ctx_config["gpu_layers"] = test_common::getTestGpuLayers();
  small_ctx_config["n_predict"] = "10";
  small_ctx_config["n_discarded"] = "0";

  fs::path backendDir;
#ifdef TEST_BINARY_DIR
  backendDir = fs::path(TEST_BINARY_DIR);
#else
  backendDir = fs::current_path() / "build" / "test" / "unit";
#endif
  small_ctx_config["backendsDir"] = backendDir.string();

  LlamaModel model(
      getValidModelPath(),
      std::string(test_projection_path),
      std::unordered_map<std::string, std::string>(small_ctx_config));
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt first_prompt;
  first_prompt.input = R"([{"role": "user", "content": "Hello"}])";
  EXPECT_NO_THROW({
    std::string output = model.processPrompt(first_prompt);
    EXPECT_GE(output.length(), 0);
    auto stats = model.runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });

  std::string long_content(30000, 'a');
  LlamaModel::Prompt overflow_prompt;
  overflow_prompt.input =
      R"([{"role": "user", "content": ")" + long_content + R"("}])";

  EXPECT_THROW(
      { model.processPrompt(overflow_prompt); }, qvac_errors::StatusError);
}

TEST_F(LlamaModelTest, ProcessEmptyMessagesAfterSessionCommands) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model(
      getValidModelPath(),
      std::string(test_projection_path),
      std::unordered_map<std::string, std::string>(config_files));
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt session_only_prompt;
  session_only_prompt.input =
      R"([{"role": "session", "content": "test_session.bin"}, {"role": "session", "content": "reset"}])";
  EXPECT_NO_THROW({
    std::string output = model.processPrompt(session_only_prompt);
    EXPECT_EQ(output.length(), 0);
    auto stats = model.runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(LlamaModelTest, CommonParamsParseInvalidChatTemplate) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  std::unordered_map<std::string, std::string> config;
  config["device"] = test_common::getTestDevice();
  config["ctx_size"] = "2048";
  config["gpu_layers"] = test_common::getTestGpuLayers();
  config["n_predict"] = "10";
  config["chat_template"] = "invalid_template_name_xyz123";
  config["use_jinja"] = "false";

  fs::path backendDir;
#ifdef TEST_BINARY_DIR
  backendDir = fs::path(TEST_BINARY_DIR);
#else
  backendDir = fs::current_path() / "build" / "test" / "unit";
#endif
  config["backendsDir"] = backendDir.string();

  EXPECT_THROW(
      {
        LlamaModel model(
            getValidModelPath(),
            std::string(test_projection_path),
            std::unordered_map<std::string, std::string>(config));
        model.waitForLoadInitialization();
      },
      qvac_errors::StatusError);
}

TEST_F(LlamaModelTest, ReloadThrowsForStreamedShardedModel) {
  using MP = test_common::TestModelPath;
  MP shardedModel(
      "Qwen3-0.6B-UD-IQ1_S-00001-of-00003.gguf",
      "SHARDED_MODEL_FIRST_SHARD_PATH",
      MP::OnMissing::Fail,
      "https://huggingface.co/jmb95/Qwen3-0.6B-UD-IQ1_S-sharded",
      true /* isSharded */);
  REQUIRE_MODEL(shardedModel);
  LlamaModel::resolveShardPaths(shardedModel.shards, shardedModel.path);

  std::string path = shardedModel.path;
  std::string projection;
  auto cfg = config_files;
  LlamaModel model(std::move(path), std::move(projection), std::move(cfg));

  {
    std::string tensorsBasename =
        fs::path(shardedModel.shards.tensors_file).filename().string();
    auto tensorsBuf = test_common::readFileToStreambufBinary(
        shardedModel.shards.tensors_file);
    ASSERT_NE(tensorsBuf, nullptr);
    model.setWeightsForFile(tensorsBasename, std::move(tensorsBuf));

    for (const auto& shardPath : shardedModel.shards.gguf_files) {
      auto streambuf = test_common::readFileToStreambufBinary(shardPath);
      ASSERT_NE(streambuf, nullptr);
      model.setWeightsForFile(
          fs::path(shardPath).filename().string(), std::move(streambuf));
    }
  }

  model.waitForLoadInitialization();
  ASSERT_TRUE(model.isLoaded());

  EXPECT_THROW(model.reload(), qvac_errors::StatusError);
}

TEST_F(LlamaModelTest, ReloadDuringProcessingWaitsAndDoesNotCrash) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  config_files["n_predict"] = "64";
  LlamaModel model = createModel();
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  std::atomic<bool> generationStarted{false};
  std::string inferenceOutput;
  std::exception_ptr inferenceException;

  std::thread inferenceThread([&]() {
    try {
      LlamaModel::Prompt prompt;
      prompt.input = R"([{"role": "user", "content": "Tell me a long story"}])";
      prompt.outputCallback = [&](const std::string& token) {
        generationStarted.store(true, std::memory_order_release);
        inferenceOutput += token;
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
      };
      model.processPrompt(prompt);
    } catch (...) {
      inferenceException = std::current_exception();
    }
  });

  while (!generationStarted.load(std::memory_order_acquire)) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }

  EXPECT_NO_THROW(model.reload());
  EXPECT_TRUE(model.isLoaded());

  // Inference must have completed before reload() returned, because
  // processPrompt holds a shared lock and reload needs an exclusive one.
  EXPECT_FALSE(inferenceOutput.empty());

  inferenceThread.join();

  if (inferenceException) {
    FAIL() << "Inference thread threw unexpectedly";
  }

  LlamaModel::Prompt postReload;
  postReload.input = R"([{"role": "user", "content": "Hello after reload"}])";
  EXPECT_NO_THROW({
    std::string output = model.processPrompt(postReload);
    EXPECT_GE(output.length(), 0);
  });
}

TEST_F(LlamaModelTest, CommonParamsParseToolsAtEndTrue) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  std::unordered_map<std::string, std::string> config;
  config["device"] = test_common::getTestDevice();
  config["ctx_size"] = "2048";
  config["gpu_layers"] = test_common::getTestGpuLayers();
  config["n_predict"] = "10";
  config["tools_at_end"] = "true";

  fs::path backendDir;
#ifdef TEST_BINARY_DIR
  backendDir = fs::path(TEST_BINARY_DIR);
#else
  backendDir = fs::current_path() / "build" / "test" / "unit";
#endif
  config["backendsDir"] = backendDir.string();

  EXPECT_NO_THROW({
    LlamaModel model(
        getValidModelPath(),
        std::string(test_projection_path),
        std::unordered_map<std::string, std::string>(config));
    model.waitForLoadInitialization();
  });
}

TEST_F(LlamaModelTest, CommonParamsParseToolsAtEndFalse) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  std::unordered_map<std::string, std::string> config;
  config["device"] = test_common::getTestDevice();
  config["ctx_size"] = "2048";
  config["gpu_layers"] = test_common::getTestGpuLayers();
  config["n_predict"] = "10";
  config["tools_at_end"] = "false";

  fs::path backendDir;
#ifdef TEST_BINARY_DIR
  backendDir = fs::path(TEST_BINARY_DIR);
#else
  backendDir = fs::current_path() / "build" / "test" / "unit";
#endif
  config["backendsDir"] = backendDir.string();

  EXPECT_NO_THROW({
    LlamaModel model(
        getValidModelPath(),
        std::string(test_projection_path),
        std::unordered_map<std::string, std::string>(config));
    model.waitForLoadInitialization();
  });
}

TEST_F(LlamaModelTest, CommonParamsParseToolsAtEndUppercase) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  std::unordered_map<std::string, std::string> config;
  config["device"] = test_common::getTestDevice();
  config["ctx_size"] = "2048";
  config["gpu_layers"] = test_common::getTestGpuLayers();
  config["n_predict"] = "10";
  config["tools_at_end"] = "TRUE";

  fs::path backendDir;
#ifdef TEST_BINARY_DIR
  backendDir = fs::path(TEST_BINARY_DIR);
#else
  backendDir = fs::current_path() / "build" / "test" / "unit";
#endif
  config["backendsDir"] = backendDir.string();

  EXPECT_NO_THROW({
    LlamaModel model(
        getValidModelPath(),
        std::string(test_projection_path),
        std::unordered_map<std::string, std::string>(config));
    model.waitForLoadInitialization();
  });
}
