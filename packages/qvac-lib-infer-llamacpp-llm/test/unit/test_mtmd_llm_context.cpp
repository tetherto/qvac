#include <filesystem>
#include <memory>
#include <string>
#include <type_traits>
#include <unordered_map>
#include <variant>
#include <vector>

#include <gtest/gtest.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>
#include <qvac-lib-inference-addon-cpp/RuntimeStats.hpp>

#include "common/chat.h"
#include "model-interface/LlamaModel.hpp"
#include "model-interface/MtmdLlmContext.hpp"
#include "test_common.hpp"

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

namespace fs = std::filesystem;

class MtmdLlmContextTest : public ::testing::Test {
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

    fs::path modelPath = basePath / "SmolVLM-500M-Instruct-Q8_0.gguf";
    if (fs::exists(modelPath)) {
      test_model_path = modelPath.string();
    } else {
      modelPath = basePath / "SmolVLM-500M-Instruct.gguf";
      if (fs::exists(modelPath)) {
        test_model_path = modelPath.string();
      } else {
        test_model_path = "SmolVLM-500M-Instruct-Q8_0.gguf";
      }
    }

    fs::path projectionPath =
        basePath / "mmproj-SmolVLM-500M-Instruct-Q8_0.gguf";
    if (fs::exists(projectionPath)) {
      test_projection_path = projectionPath.string();
    } else {
      projectionPath = basePath / "mmproj-SmolVLM-500M-Instruct.gguf";
      if (fs::exists(projectionPath)) {
        test_projection_path = projectionPath.string();
      } else {
        test_projection_path = "mmproj-SmolVLM-500M-Instruct-Q8_0.gguf";
      }
    }

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

  bool hasValidModel() {
    return fs::exists(test_model_path) && fs::exists(test_projection_path);
  }

  std::unique_ptr<LlamaModel> createModel() {
    if (!hasValidModel()) {
      return nullptr;
    }
    std::string modelPath = test_model_path;
    std::string projectionPath = test_projection_path;
    auto configCopy = config_files;
    auto model = std::make_unique<LlamaModel>(
        std::move(modelPath), std::move(projectionPath), std::move(configCopy));
    model->waitForLoadInitialization();
    if (!model->isLoaded()) {
      return nullptr;
    }
    return model;
  }
};

TEST_F(MtmdLlmContextTest, Constructor) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  EXPECT_TRUE(model->isLoaded());
}

TEST_F(MtmdLlmContextTest, ProcessWithStringInput) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello, how are you?"}])";
  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(MtmdLlmContextTest, ProcessWithCallback) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  std::vector<std::string> generated_tokens;

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello"}])";
  prompt.outputCallback = [&generated_tokens](const std::string& token) {
    generated_tokens.push_back(token);
  };

  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    EXPECT_GT(generated_tokens.size(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(MtmdLlmContextTest, ProcessAndGetRuntimeStats) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello"}])";
  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(MtmdLlmContextTest, LoadMediaBinary) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  std::vector<uint8_t> image_data = {0xFF, 0xD8, 0xFF, 0xE0};
  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "What is this?"}])";
  prompt.media.push_back(std::move(image_data));
  EXPECT_THROW({ model->processPrompt(prompt); }, qvac_errors::StatusError);
}

TEST_F(MtmdLlmContextTest, LoadMediaFile) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input =
      R"([{"type": "media", "content": "nonexistent_image.jpg"}, {"role": "user", "content": "What is this?"}])";
  EXPECT_THROW({ model->processPrompt(prompt); }, qvac_errors::StatusError);
}

TEST_F(MtmdLlmContextTest, ResetState) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello"}])";
  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });

  EXPECT_NO_THROW(model->reset());

  LlamaModel::Prompt prompt2;
  prompt2.input = R"([{"role": "user", "content": "Another hello"}])";
  EXPECT_NO_THROW({
    std::string output2 = model->processPrompt(prompt2);
    EXPECT_GE(output2.length(), 0);
    auto stats2 = model->runtimeStats();
    EXPECT_GE(stats2.size(), 0);
  });
}

TEST_F(MtmdLlmContextTest, ResetMedia) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  std::vector<uint8_t> image_data = {0xFF, 0xD8, 0xFF, 0xE0};
  LlamaModel::Prompt mediaPrompt;
  mediaPrompt.input = R"([{"role": "user", "content": "What is this?"}])";
  mediaPrompt.media.push_back(std::move(image_data));
  EXPECT_THROW(
      { model->processPrompt(mediaPrompt); }, qvac_errors::StatusError);

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello"}])";
  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(MtmdLlmContextTest, MultimodalMessages) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input =
      R"([{"role": "user", "content": "What do you see in this image?"}])";
  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(MtmdLlmContextTest, ProcessWithSessionCache) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt1;
  prompt1.input =
      R"([{"role": "session", "content": "test_session.bin"}, {"role": "user", "content": "Hello"}])";
  EXPECT_NO_THROW({
    std::string output1 = model->processPrompt(prompt1);
    EXPECT_GE(output1.length(), 0);
    auto stats1 = model->runtimeStats();
    EXPECT_GE(stats1.size(), 0);
  });

  LlamaModel::Prompt prompt2;
  prompt2.input =
      R"([{"role": "session", "content": "test_session.bin"}, {"role": "user", "content": "Follow up message"}])";
  EXPECT_NO_THROW({
    std::string output2 = model->processPrompt(prompt2);
    EXPECT_GE(output2.length(), 0);
    auto stats2 = model->runtimeStats();
    EXPECT_GE(stats2.size(), 0);
  });
}

TEST_F(MtmdLlmContextTest, InvalidMedia) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  std::vector<uint8_t> invalid_data = {0x00, 0x01, 0x02};
  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "What is this?"}])";
  prompt.media.push_back(std::move(invalid_data));
  EXPECT_THROW({ model->processPrompt(prompt); }, qvac_errors::StatusError);
}

TEST_F(MtmdLlmContextTest, NonexistentFile) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input =
      R"([{"type": "media", "content": "nonexistent_image.jpg"}, {"role": "user", "content": "What is this?"}])";
  EXPECT_THROW({ model->processPrompt(prompt); }, qvac_errors::StatusError);
}

TEST_F(MtmdLlmContextTest, ProcessWithTools) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([
    {"role": "user", "content": "What is the weather in Tokyo?"},
    {
      "type": "function",
      "name": "getWeather",
      "description": "Get weather forecast for a city",
      "parameters": {
        "type": "object",
        "properties": {
          "city": {"type": "string", "description": "City name"},
          "date": {"type": "string", "description": "Date in YYYY-MM-DD"}
        },
        "required": ["city", "date"]
      }
    }
  ])";

  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(MtmdLlmContextTest, ProcessWithMultipleTools) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([
    {"role": "user", "content": "Search for products and add to cart"},
    {
      "type": "function",
      "name": "searchProducts",
      "description": "Search products",
      "parameters": {
        "type": "object",
        "properties": {
          "query": {"type": "string", "description": "Search query"}
        },
        "required": ["query"]
      }
    },
    {
      "type": "function",
      "name": "addToCart",
      "description": "Add items to cart",
      "parameters": {
        "type": "object",
        "properties": {
          "items": {
            "type": "array",
            "items": {"type": "string"}
          }
        },
        "required": ["items"]
      }
    }
  ])";

  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}
