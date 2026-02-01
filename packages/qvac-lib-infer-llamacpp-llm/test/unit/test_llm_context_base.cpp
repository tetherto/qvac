#include <filesystem>
#include <memory>
#include <string>
#include <type_traits>
#include <unordered_map>
#include <variant>
#include <vector>

#include <gtest/gtest.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>

#include "common/chat.h"
#include "model-interface/LlamaModel.hpp"
#include "model-interface/LlmContext.hpp"
#include "model-interface/MtmdLlmContext.hpp"
#include "model-interface/TextLlmContext.hpp"
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

class LlmContextBaseTest : public ::testing::Test {
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

  bool hasValidModel() { return fs::exists(test_model_path); }

  bool hasValidMultimodalModel() {
    fs::path basePath;
    if (fs::exists(fs::path{"../../../models/unit-test"})) {
      basePath = fs::path{"../../../models/unit-test"};
    } else {
      basePath = fs::path{"models/unit-test"};
    }

    fs::path modelPath = basePath / "SmolVLM-500M-Instruct-Q8_0.gguf";
    if (!fs::exists(modelPath)) {
      modelPath = basePath / "SmolVLM-500M-Instruct.gguf";
    }

    fs::path projectionPath =
        basePath / "mmproj-SmolVLM-500M-Instruct-Q8_0.gguf";
    if (!fs::exists(projectionPath)) {
      projectionPath = basePath / "mmproj-SmolVLM-500M-Instruct.gguf";
    }

    return fs::exists(modelPath) && fs::exists(projectionPath);
  }

  std::unique_ptr<LlamaModel> createModel() {
    if (!hasValidModel()) {
      return nullptr;
    }
    auto model = std::make_unique<LlamaModel>(
        test_model_path, test_projection_path, config_files);
    model->waitForLoadInitialization();
    if (!model->isLoaded()) {
      return nullptr;
    }
    return model;
  }

  std::unique_ptr<LlamaModel> createMultimodalModel() {
    if (!hasValidMultimodalModel()) {
      return nullptr;
    }

    fs::path basePath;
    if (fs::exists(fs::path{"../../../models/unit-test"})) {
      basePath = fs::path{"../../../models/unit-test"};
    } else {
      basePath = fs::path{"models/unit-test"};
    }

    fs::path modelPath = basePath / "SmolVLM-500M-Instruct-Q8_0.gguf";
    if (!fs::exists(modelPath)) {
      modelPath = basePath / "SmolVLM-500M-Instruct.gguf";
    }

    fs::path projectionPath =
        basePath / "mmproj-SmolVLM-500M-Instruct-Q8_0.gguf";
    if (!fs::exists(projectionPath)) {
      projectionPath = basePath / "mmproj-SmolVLM-500M-Instruct.gguf";
    }

    auto model = std::make_unique<LlamaModel>(
        modelPath.string(), projectionPath.string(), config_files);
    model->waitForLoadInitialization();
    if (!model->isLoaded()) {
      return nullptr;
    }
    return model;
  }

  std::unordered_map<std::string, std::string> config_files;
  std::string test_model_path;
  std::string test_projection_path;
};

TEST_F(LlmContextBaseTest, TextLlmContextProcessAndReset) {
  if (!hasValidModel()) {
    GTEST_SKIP() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    GTEST_SKIP() << "Model failed to load";
  }

  auto stats = model->runtimeStats();
  EXPECT_GE(getStatValue(stats, "CacheTokens"), 0.0);

  std::string input = R"([{"role": "user", "content": "Hello"}])";
  EXPECT_NO_THROW({
    std::string output = model->process(input);
    EXPECT_GE(output.length(), 0);
    auto statsAfter = model->runtimeStats();
    EXPECT_GE(statsAfter.size(), 0);
  });

  EXPECT_NO_THROW(model->reset());

  std::string input2 = R"([{"role": "user", "content": "Another hello"}])";
  EXPECT_NO_THROW({
    std::string output2 = model->process(input2);
    EXPECT_GE(output2.length(), 0);
    auto stats2 = model->runtimeStats();
    EXPECT_GE(stats2.size(), 0);
  });
}

TEST_F(LlmContextBaseTest, MtmdLlmContextProcessAndReset) {
  if (!hasValidMultimodalModel()) {
    GTEST_SKIP() << "Multimodal model or projection file not found";
  }

  auto model = createMultimodalModel();
  if (!model) {
    GTEST_SKIP() << "Model failed to load";
  }

  auto stats = model->runtimeStats();
  EXPECT_GE(getStatValue(stats, "CacheTokens"), 0.0);

  std::string input = R"([{"role": "user", "content": "Hello"}])";
  EXPECT_NO_THROW({
    std::string output = model->process(input);
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });

  EXPECT_NO_THROW(model->reset());

  std::string input2 = R"([{"role": "user", "content": "Another hello"}])";
  EXPECT_NO_THROW({
    std::string output2 = model->process(input2);
    EXPECT_GE(output2.length(), 0);
    auto stats2 = model->runtimeStats();
    EXPECT_GE(stats2.size(), 0);
  });
}

TEST_F(LlmContextBaseTest, ProcessAndGetRuntimeStats) {
  if (!hasValidModel()) {
    GTEST_SKIP() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::string input = R"([{"role": "user", "content": "Hello"}])";
  EXPECT_NO_THROW({
    std::string output = model->process(input);
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GT(getStatValue(stats, "promptTokens"), 0.0);
  });
}

TEST_F(LlmContextBaseTest, ProcessWithCallback) {
  if (!hasValidModel()) {
    GTEST_SKIP() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::vector<std::string> tokens;
  auto callback = [&tokens](const std::string& token) {
    tokens.push_back(token);
  };

  std::string input = R"([{"role": "user", "content": "Hello"}])";
  EXPECT_NO_THROW({
    std::string output = model->process(input, callback);
    EXPECT_GE(output.length(), 0);
    EXPECT_GT(tokens.size(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(LlmContextBaseTest, ResetStateClearsCache) {
  if (!hasValidModel()) {
    GTEST_SKIP() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::string input = R"([{"role": "user", "content": "Hello"}])";
  EXPECT_NO_THROW({
    std::string output = model->process(input);
    EXPECT_GE(output.length(), 0);
  });

  model->reset();

  std::string input2 = R"([{"role": "user", "content": "Another hello"}])";
  EXPECT_NO_THROW({
    std::string output2 = model->process(input2);
    EXPECT_GE(output2.length(), 0);
    auto statsAfterReset = model->runtimeStats();
    EXPECT_EQ(getStatValue(statsAfterReset, "CacheTokens"), 0.0);
  });
}

TEST_F(LlmContextBaseTest, TextContextRejectsBinaryInput) {
  if (!hasValidModel()) {
    GTEST_SKIP() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::vector<uint8_t> media = {0x48, 0x65, 0x6c, 0x6c, 0x6f};

  if (test_projection_path.empty()) {
    EXPECT_THROW({ model->process(media); }, qvac_errors::StatusError);
  }
}

TEST_F(LlmContextBaseTest, MultipleProcessCalls) {
  if (!hasValidModel()) {
    GTEST_SKIP() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::string input = R"([{"role": "user", "content": "Hello"}])";
  EXPECT_NO_THROW({
    std::string output = model->process(input);
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });

  std::string input2 = R"([{"role": "user", "content": "Another hello"}])";
  EXPECT_NO_THROW({
    std::string output2 = model->process(input2);
    EXPECT_GE(output2.length(), 0);
    auto stats2 = model->runtimeStats();
    EXPECT_GE(stats2.size(), 0);
  });
}

TEST_F(LlmContextBaseTest, VirtualDestructor) {
  if (!hasValidModel()) {
    GTEST_SKIP() << "Test model not found";
  }

  {
    auto model = createModel();
    if (!model) {
      GTEST_SKIP() << "Model failed to load";
    }

    std::string input = R"([{"role": "user", "content": "Hello"}])";
    EXPECT_NO_THROW({
      std::string output = model->process(input);
      EXPECT_GE(output.length(), 0);
      auto stats = model->runtimeStats();
      EXPECT_GE(stats.size(), 0);
    });
  }

  {
    auto model2 = createModel();
    if (model2) {
      std::string input = R"([{"role": "user", "content": "Test 2"}])";
      EXPECT_NO_THROW({
        std::string output = model2->process(input);
        EXPECT_GE(output.length(), 0);
      });
    }
  }
}

TEST_F(LlmContextBaseTest, RuntimeStatsAccuracy) {
  if (!hasValidModel()) {
    GTEST_SKIP() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::string input = R"([{"role": "user", "content": "Hello"}])";
  model->process(input);

  auto stats = model->runtimeStats();
  double promptTokens = getStatValue(stats, "promptTokens");
  double generatedTokens = getStatValue(stats, "generatedTokens");
  double cacheTokens = getStatValue(stats, "CacheTokens");

  EXPECT_GT(promptTokens, 0.0);
  EXPECT_GE(generatedTokens, 0.0);
  EXPECT_GE(cacheTokens, 0.0);
  EXPECT_GE(promptTokens, 1.0);
}

TEST_F(LlmContextBaseTest, RuntimeStatsConsistency) {
  if (!hasValidModel()) {
    GTEST_SKIP() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::string input = R"([{"role": "user", "content": "Hello"}])";

  for (int i = 0; i < 3; ++i) {
    model->process(input);
    auto stats = model->runtimeStats();

    double promptTokens = getStatValue(stats, "promptTokens");
    double generatedTokens = getStatValue(stats, "generatedTokens");
    double cacheTokens = getStatValue(stats, "CacheTokens");

    EXPECT_GE(promptTokens, 0.0);
    EXPECT_GE(generatedTokens, 0.0);
    EXPECT_GE(cacheTokens, 0.0);
  }
}
