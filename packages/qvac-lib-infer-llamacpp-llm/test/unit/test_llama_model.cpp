#include <filesystem>
#include <memory>
#include <string>
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

  std::string getInvalidModelPath() { return "nonexistent_model.gguf"; }
};

TEST_F(LlamaModelTest, ConstructorValidParams) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  EXPECT_NO_THROW({
    LlamaModel model(getValidModelPath(), test_projection_path, config_files);
  });
}

TEST_F(LlamaModelTest, IsLoadedMethodBeforeInit) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model(getValidModelPath(), test_projection_path, config_files);
  EXPECT_FALSE(model.isLoaded());
}

TEST_F(LlamaModelTest, InitializeBackend) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model(getValidModelPath(), test_projection_path, config_files);
  EXPECT_NO_THROW(model.initializeBackend());
}

TEST_F(LlamaModelTest, InvalidModelPath) {
  std::string invalid_path = getInvalidModelPath();
  std::unordered_map<std::string, std::string> empty_config;
  empty_config["device"] = "cpu";

  EXPECT_NO_THROW({
    LlamaModel model(invalid_path, test_projection_path, empty_config);
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

  EXPECT_NO_THROW({
    LlamaModel model(getValidModelPath(), test_projection_path, invalid_config);
  });
}

TEST_F(LlamaModelTest, RuntimeStatsBeforeProcessing) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model(getValidModelPath(), test_projection_path, config_files);
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

  LlamaModel model(getValidModelPath(), test_projection_path, config_files);
  EXPECT_NO_THROW(model.reset());
}

TEST_F(LlamaModelTest, ProcessStringInput) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model(getValidModelPath(), test_projection_path, config_files);
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  std::string input = R"([{"role": "user", "content": "Hello, how are you?"}])";
  EXPECT_NO_THROW({
    std::string output = model.process(input);
    EXPECT_GE(output.length(), 0);
    auto stats = model.runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(LlamaModelTest, ProcessWithCallback) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model(getValidModelPath(), test_projection_path, config_files);
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  std::vector<std::string> received_tokens;
  auto callback = [&received_tokens](const std::string& token) {
    received_tokens.push_back(token);
  };

  std::string input = R"([{"role": "user", "content": "Hello"}])";
  EXPECT_NO_THROW({
    std::string output = model.process(input, callback);
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

  LlamaModel model(getValidModelPath(), test_projection_path, config_files);
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  std::vector<uint8_t> binary_input = {0x48, 0x65, 0x6c, 0x6c, 0x6f};
  if (test_projection_path.empty()) {
    EXPECT_THROW({ model.process(binary_input); }, qvac_errors::StatusError);
  } else {
    EXPECT_NO_THROW({
      std::string output = model.process(binary_input);
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

  LlamaModel model(getValidModelPath(), test_projection_path, config_files);
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  std::string empty_input = "";
  EXPECT_THROW({ model.process(empty_input); }, qvac_errors::StatusError);
}

TEST_F(LlamaModelTest, ProcessAfterInitialization) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  {
    SCOPED_TRACE("Creating LlamaModel");

    LlamaModel model(getValidModelPath(), test_projection_path, config_files);

    {
      SCOPED_TRACE("Calling waitForLoadInitialization()");

      model.waitForLoadInitialization();
    }

    if (!model.isLoaded()) {
      FAIL() << "Model failed to load";
    }

    {
      SCOPED_TRACE("Calling process()");

      std::string input = R"([{"role": "user", "content": "Hello."}])";
      EXPECT_NO_THROW({
        std::string output = model.process(input);
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

  LlamaModel model(getValidModelPath(), test_projection_path, config_files);
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  std::string input = R"([{"role": "user", "content": "Hello"}])";
  EXPECT_NO_THROW({
    std::string output = model.process(input);
    EXPECT_TRUE(model.isLoaded());
    auto stats = model.runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(LlamaModelTest, RuntimeStatsAfterProcessing) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model(getValidModelPath(), test_projection_path, config_files);
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  std::string input = R"([{"role": "user", "content": "Hello, world!"}])";
  EXPECT_NO_THROW({
    std::string output = model.process(input);
    EXPECT_GE(output.length(), 0);

    auto stats = model.runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(LlamaModelTest, RuntimeStatsAfterReset) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model(getValidModelPath(), test_projection_path, config_files);
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  std::string input = R"([{"role": "user", "content": "Hello"}])";
  EXPECT_NO_THROW({
    std::string output = model.process(input);
    EXPECT_GE(output.length(), 0);

    auto statsBefore = model.runtimeStats();
    EXPECT_FALSE(statsBefore.empty());

    model.reset();
    auto statsAfter = model.runtimeStats();
    EXPECT_GE(statsAfter.size(), 0);
  });
}

TEST_F(LlamaModelTest, StopMethod) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model(getValidModelPath(), test_projection_path, config_files);
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW(model.stop());
}

TEST_F(LlamaModelTest, MultipleProcessCalls) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model(getValidModelPath(), test_projection_path, config_files);
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  std::string input = R"([{"role": "user", "content": "Hello"}])";

  for (int i = 0; i < 3; ++i) {
    EXPECT_NO_THROW({
      std::string output = model.process(input);
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
    LlamaModel model(getValidModelPath(), test_projection_path, config_files);
    model.waitForLoadInitialization();

    if (model.isLoaded()) {
      std::string input = R"([{"role": "user", "content": "Hello"}])";
      EXPECT_NO_THROW({
        std::string output = model.process(input);
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

  LlamaModel model(getValidModelPath(), test_projection_path, config_files);

  std::string filename1 = "test_model.gguf";
  std::string test_data1 = "test weight data";
  auto shard1 = std::make_unique<std::stringbuf>(test_data1);

  EXPECT_NO_THROW(
      { model.set_weights_for_file(filename1, std::move(shard1)); });

  std::string filename2 = "test_model2.gguf";
  std::string test_data2 = "more test weight data";
  auto shard2 = std::make_unique<std::stringbuf>(test_data2);

  EXPECT_NO_THROW(
      { model.set_weights_for_file(filename2, std::move(shard2)); });
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

  LlamaModel model(getValidModelPath(), test_projection_path, config_files);
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  std::string invalid_json = "[{invalid json}";
  EXPECT_THROW({ model.process(invalid_json); }, std::exception);
}

TEST_F(LlamaModelTest, MalformedChatMessageFormat) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model(getValidModelPath(), test_projection_path, config_files);
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  std::string invalid_message = R"([{"content": "Hello"}])";
  EXPECT_THROW({ model.process(invalid_message); }, qvac_errors::StatusError);

  std::string invalid_message2 = R"([{"role": "user"}])";
  EXPECT_THROW({ model.process(invalid_message2); }, qvac_errors::StatusError);
}

TEST_F(LlamaModelTest, EmptyMessagesArray) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model(getValidModelPath(), test_projection_path, config_files);
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  std::string empty_messages = "[]";
  EXPECT_NO_THROW({
    std::string output = model.process(empty_messages);
    EXPECT_EQ(output.length(), 0);
    auto stats = model.runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(LlamaModelTest, VeryLongInput) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model(getValidModelPath(), test_projection_path, config_files);
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  std::string long_content(10000, 'a');
  std::string long_input =
      R"([{"role": "user", "content": ")" + long_content + R"("}])";

  EXPECT_NO_THROW({
    std::string output = model.process(long_input);
    EXPECT_GE(output.length(), 0);
    auto stats = model.runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(LlamaModelTest, SpecialCharactersAndUnicode) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model(getValidModelPath(), test_projection_path, config_files);
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  std::string unicode_input =
      R"([{"role": "user", "content": "Hello 世界 🌍"}])";
  EXPECT_NO_THROW({
    std::string output = model.process(unicode_input);
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
            getValidModelPath(), test_projection_path, config_no_device);
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
        LlamaModel model(getValidModelPath(), test_projection_path, config);
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
        LlamaModel model(getValidModelPath(), test_projection_path, config);
        model.waitForLoadInitialization();
      },
      qvac_errors::StatusError);
}

TEST_F(LlamaModelTest, FormatPromptMediaInTextOnlyModel) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model(getValidModelPath(), test_projection_path, config_files);
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

  fs::path basePath;
  if (fs::exists(fs::path{"../../../models/unit-test"})) {
    basePath = fs::path{"../../../models/unit-test"};
  } else {
    basePath = fs::path{"models/unit-test"};
  }

  fs::path multimodalModelPath = basePath / "SmolVLM-500M-Instruct-Q8_0.gguf";
  if (!fs::exists(multimodalModelPath)) {
    multimodalModelPath = basePath / "SmolVLM-500M-Instruct.gguf";
  }

  fs::path projectionPath = basePath / "mmproj-SmolVLM-500M-Instruct-Q8_0.gguf";
  if (!fs::exists(projectionPath)) {
    projectionPath = basePath / "mmproj-SmolVLM-500M-Instruct.gguf";
  }

  if (!fs::exists(multimodalModelPath) || !fs::exists(projectionPath)) {
    FAIL() << "Multimodal model and projection required for this test";
  }

  LlamaModel model(
      multimodalModelPath.string(), projectionPath.string(), config_files);
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

  fs::path basePath;
  if (fs::exists(fs::path{"../../../models/unit-test"})) {
    basePath = fs::path{"../../../models/unit-test"};
  } else {
    basePath = fs::path{"models/unit-test"};
  }

  fs::path multimodalModelPath = basePath / "SmolVLM-500M-Instruct-Q8_0.gguf";
  if (!fs::exists(multimodalModelPath)) {
    multimodalModelPath = basePath / "SmolVLM-500M-Instruct.gguf";
  }

  fs::path projectionPath = basePath / "mmproj-SmolVLM-500M-Instruct-Q8_0.gguf";
  if (!fs::exists(projectionPath)) {
    projectionPath = basePath / "mmproj-SmolVLM-500M-Instruct.gguf";
  }

  if (!fs::exists(multimodalModelPath) || !fs::exists(projectionPath)) {
    FAIL() << "Multimodal model and projection required for this test";
  }

  LlamaModel model(
      multimodalModelPath.string(), projectionPath.string(), config_files);
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

  LlamaModel model(getValidModelPath(), test_projection_path, small_ctx_config);
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

  LlamaModel model(getValidModelPath(), test_projection_path, small_ctx_config);
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  std::string first_input = R"([{"role": "user", "content": "Hello"}])";
  EXPECT_NO_THROW({
    std::string output = model.process(first_input);
    EXPECT_GE(output.length(), 0);
    auto stats = model.runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });

  std::string long_content(30000, 'a');
  std::string overflow_input =
      R"([{"role": "user", "content": ")" + long_content + R"("}])";

  EXPECT_THROW({ model.process(overflow_input); }, qvac_errors::StatusError);
}

TEST_F(LlamaModelTest, ProcessEmptyMessagesAfterSessionCommands) {
  if (!fs::exists(getValidModelPath())) {
    FAIL() << "Test model not found at: " << getValidModelPath();
  }

  LlamaModel model(getValidModelPath(), test_projection_path, config_files);
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    FAIL() << "Model failed to load";
  }

  std::string session_only_input =
      R"([{"role": "session", "content": "test_session.bin"}, {"role": "session", "content": "reset"}])";
  EXPECT_NO_THROW({
    std::string output = model.process(session_only_input);
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
        LlamaModel model(getValidModelPath(), test_projection_path, config);
        model.waitForLoadInitialization();
      },
      qvac_errors::StatusError);
}
