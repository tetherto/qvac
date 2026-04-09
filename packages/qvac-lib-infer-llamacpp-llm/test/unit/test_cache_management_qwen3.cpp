#include <any>
#include <filesystem>
#include <iostream>
#include <memory>
#include <string>
#include <unordered_map>

#include <gtest/gtest.h>

#include "model-interface/LlamaModel.hpp"
#include "test_common.hpp"

namespace fs = std::filesystem;

using test_common::getStatValue;

namespace {
std::string processPromptString(
    const std::unique_ptr<LlamaModel>& model, const std::string& input) {
  LlamaModel::Prompt prompt;
  prompt.input = input;
  return model->processPrompt(prompt);
}

bool isQwen3ModelPath(const std::string& path) {
  std::string lowerPath = path;
  std::transform(
      lowerPath.begin(),
      lowerPath.end(),
      lowerPath.begin(),
      [](unsigned char c) { return std::tolower(c); });
  return lowerPath.find("qwen3") != std::string::npos;
}
} // namespace

class CacheManagementQwen3Test : public ::testing::Test {
protected:
  void SetUp() override {
    config_files["device"] = test_common::getTestDevice();
    config_files["ctx_size"] = "2048";
    config_files["gpu_layers"] = test_common::getTestGpuLayers();
    config_files["n_predict"] = "10";
    config_files["tools"] = "true";

    test_model_path = test_common::BaseTestModelPath::get(
        "Qwen3-1.7B-Q4_0.gguf", "Llama-3.2-1B-Instruct-Q4_0.gguf");
    test_projection_path = "";

    config_files["backendsDir"] = test_common::getTestBackendsDir().string();

    session1_path = "test_session1_qwen3.bin";
    session2_path = "test_session2_qwen3.bin";
    temp_session_path = "temp_session_qwen3.bin";
  }

  void TearDown() override {
    for (const auto& session_file :
         {session1_path,
          session2_path,
          temp_session_path,
          std::string("test_large_cache_qwen3.bin")}) {
      if (fs::exists(session_file)) {
        fs::remove(session_file);
      }
    }
  }

  bool hasValidModel() { return fs::exists(test_model_path); }

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

  std::unordered_map<std::string, std::string> config_files;
  std::string test_model_path;
  std::string test_projection_path;
  std::string session1_path;
  std::string session2_path;
  std::string temp_session_path;
};

TEST_F(CacheManagementQwen3Test, CacheWithToolsAtEndTrueTrimsToolTokens) {
  if (!isQwen3ModelPath(test_model_path)) {
    GTEST_SKIP() << "Test requires Qwen3 model for tools_at_end feature";
  }

  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  config_files["tools_at_end"] = "true";
  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  std::string inputWithTools =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "user", "content": "What is the weather in Tokyo?"}, {"type": "function", "name": "getWeather", "description": "Get weather forecast", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}])";

  EXPECT_NO_THROW({
    std::string output = processPromptString(model, inputWithTools);
    EXPECT_GE(output.length(), 0);
  });

  auto statsBeforeSave = model->runtimeStats();
  double cacheTokensBeforeSave = getStatValue(statsBeforeSave, "CacheTokens");
  EXPECT_GT(cacheTokensBeforeSave, 0.0);

  llama_pos nPastBeforeTools = model->getNPastBeforeTools();
  EXPECT_EQ(nPastBeforeTools, -1);

  std::string saveInput =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "session", "content": "save"}])";
  EXPECT_NO_THROW({
    std::string saveOutput = processPromptString(model, saveInput);
    EXPECT_EQ(saveOutput.length(), 0);
  });

  EXPECT_TRUE(fs::exists(session1_path));
}

TEST_F(CacheManagementQwen3Test, CacheReloadWithToolsAtEndTrue) {
  if (!isQwen3ModelPath(test_model_path)) {
    GTEST_SKIP() << "Test requires Qwen3 model for tools_at_end feature";
  }

  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  config_files["tools_at_end"] = "true";
  auto model1 = createModel();
  if (!model1) {
    FAIL() << "Model failed to load";
  }

  std::string inputWithTools =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "user", "content": "What is the weather in Tokyo?"}, {"type": "function", "name": "getWeather", "description": "Get weather forecast", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}])";

  EXPECT_NO_THROW({
    std::string output = processPromptString(model1, inputWithTools);
    EXPECT_GE(output.length(), 0);
  });

  llama_pos nPastBeforeTools1 = model1->getNPastBeforeTools();
  EXPECT_EQ(nPastBeforeTools1, -1);

  std::string saveInput =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "session", "content": "save"}])";
  EXPECT_NO_THROW({
    std::string saveOutput = processPromptString(model1, saveInput);
    EXPECT_EQ(saveOutput.length(), 0);
  });

  EXPECT_TRUE(fs::exists(session1_path));

  model1.reset();

  auto model2 = createModel();
  if (!model2) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW({
    std::string output = processPromptString(
        model2,
        R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "user", "content": "What is the weather in London?"}])");
    EXPECT_GE(output.length(), 0);
  });

  auto statsAfterReload = model2->runtimeStats();
  double cacheTokensAfterReload = getStatValue(statsAfterReload, "CacheTokens");
  EXPECT_GT(cacheTokensAfterReload, 0.0);

  llama_pos nPastBeforeTools2 = model2->getNPastBeforeTools();
  EXPECT_EQ(nPastBeforeTools2, -1);
}

TEST_F(CacheManagementQwen3Test, CacheWithoutToolsWithToolsAtEndTrue) {
  if (!isQwen3ModelPath(test_model_path)) {
    GTEST_SKIP() << "Test requires Qwen3 model for tools_at_end feature";
  }

  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  config_files["tools_at_end"] = "true";
  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  std::string inputNoTools =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "user", "content": "What is bitcoin? Answer shortly."}])";

  EXPECT_NO_THROW({
    std::string output = processPromptString(model, inputNoTools);
    EXPECT_GE(output.length(), 0);
  });

  auto statsBeforeSave = model->runtimeStats();
  double cacheTokensBeforeSave = getStatValue(statsBeforeSave, "CacheTokens");
  EXPECT_GT(cacheTokensBeforeSave, 0.0);

  llama_pos nPastBeforeTools = model->getNPastBeforeTools();
  EXPECT_EQ(nPastBeforeTools, -1);

  std::string saveInput =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "session", "content": "save"}])";
  EXPECT_NO_THROW({
    std::string saveOutput = processPromptString(model, saveInput);
    EXPECT_EQ(saveOutput.length(), 0);
  });

  EXPECT_TRUE(fs::exists(session1_path));
}

TEST_F(CacheManagementQwen3Test, CacheToolsAtEndModeWithMultiplePrompts) {
  if (!isQwen3ModelPath(test_model_path)) {
    GTEST_SKIP() << "Test requires Qwen3 model for tools_at_end feature";
  }

  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  config_files["tools_at_end"] = "true";
  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  std::string input1 =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "user", "content": "Hi"}, {"type": "function", "name": "get_weather", "description": "Get detailed weather forecast data with temperature humidity wind speed precipitation UV visibility pressure sunrise sunset alerts", "parameters": {"type": "object", "properties": {"city": {"type": "string", "description": "The name of the city to get weather for"}, "country": {"type": "string", "description": "Country code or name"}, "lat": {"type": "number", "description": "Latitude coordinate"}, "lon": {"type": "number", "description": "Longitude coordinate"}, "zip": {"type": "string", "description": "ZIP postal code"}, "units": {"type": "string", "description": "Temperature units metric imperial or kelvin"}, "lang": {"type": "string", "description": "Language code for localized descriptions"}, "forecast_days": {"type": "integer", "description": "Number of days to forecast from 1 to 7"}, "hourly": {"type": "boolean", "description": "Include hourly forecast data"}, "alerts": {"type": "boolean", "description": "Include weather alerts and warnings"}, "aqi": {"type": "boolean", "description": "Include air quality index data"}, "tides": {"type": "boolean", "description": "Include tide information"}, "solar": {"type": "boolean", "description": "Include solar data like sunrise sunset"}, "tz": {"type": "string", "description": "Timezone identifier"}, "start_dt": {"type": "string", "description": "Start datetime for historical data"}, "end_dt": {"type": "string", "description": "End datetime for historical data"}, "cnt": {"type": "integer", "description": "Number of data points to return"}, "mode": {"type": "string", "description": "Response mode json xml or html"}, "appid": {"type": "string", "description": "API key for authentication"}}, "required": ["city"]}}])";

  EXPECT_NO_THROW({
    std::string output = processPromptString(model, input1);
    EXPECT_GE(output.length(), 0);
  });

  auto stats1 = model->runtimeStats();
  double cacheTokens1 = getStatValue(stats1, "CacheTokens");
  double promptTokens1 = getStatValue(stats1, "promptTokens");
  EXPECT_GT(cacheTokens1, 0.0);
  EXPECT_GT(promptTokens1, 500.0);

  const int maxExpectedCacheTokens = 50;
  EXPECT_GT(cacheTokens1, 0);
  EXPECT_LE(cacheTokens1, maxExpectedCacheTokens)
      << "Cache tokens (" << cacheTokens1 << ") should not exceed "
      << maxExpectedCacheTokens << " - function tokens should be trimmed";

  std::string input2 =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "user", "content": "What about London?"}])";

  EXPECT_NO_THROW({
    std::string output = processPromptString(model, input2);
    EXPECT_GE(output.length(), 0);
  });

  auto stats2 = model->runtimeStats();
  double cacheTokens2 = getStatValue(stats2, "CacheTokens");
  double promptTokens2 = getStatValue(stats2, "promptTokens");
  EXPECT_GT(cacheTokens2, cacheTokens1);
  EXPECT_LT(promptTokens2, 500.0);
  EXPECT_LE(cacheTokens2, maxExpectedCacheTokens)
      << "Cache tokens (" << cacheTokens1 << ") should not exceed "
      << maxExpectedCacheTokens << " - function tokens should be trimmed";

  std::string saveInput =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "session", "content": "save"}])";
  EXPECT_NO_THROW({
    std::string saveOutput = processPromptString(model, saveInput);
    EXPECT_EQ(saveOutput.length(), 0);
  });

  EXPECT_TRUE(fs::exists(session1_path));

  model.reset();

  auto model2 = createModel();
  if (!model2) {
    FAIL() << "Model2 failed to load";
  }

  std::string input3 =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "user", "content": "What about Paris?"}])";

  EXPECT_NO_THROW({
    std::string output = processPromptString(model2, input3);
    EXPECT_GE(output.length(), 0);
  });

  auto stats3 = model2->runtimeStats();
  double cacheTokens3 = getStatValue(stats3, "CacheTokens");
  double promptTokens3 = getStatValue(stats3, "promptTokens");

  EXPECT_GT(cacheTokens3, cacheTokens2);
  EXPECT_LT(promptTokens3, 100.0);

  auto model3 = createModel();
  if (!model3) {
    FAIL() << "Model3 failed to load";
  }

  std::string getTokensInput =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "session", "content": "getTokens"}])";
  EXPECT_NO_THROW({
    std::string output = processPromptString(model3, getTokensInput);
    EXPECT_EQ(output.length(), 0);
  });

  auto stats4 = model3->runtimeStats();
  double cacheTokens4 = getStatValue(stats4, "CacheTokens");
  EXPECT_EQ(cacheTokens4, cacheTokens2);
}

TEST_F(
    CacheManagementQwen3Test,
    CacheToolsAtEndModeTrimOnlyWhenNPastBeforeToolsPositive) {
  if (!isQwen3ModelPath(test_model_path)) {
    GTEST_SKIP() << "Test requires Qwen3 model for tools_at_end feature";
  }

  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  config_files["tools_at_end"] = "true";
  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  std::string inputNoTools =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "user", "content": "Hello"}])";

  EXPECT_NO_THROW({
    std::string output = processPromptString(model, inputNoTools);
    EXPECT_GE(output.length(), 0);
  });

  llama_pos nPastBeforeTools = model->getNPastBeforeTools();
  EXPECT_EQ(nPastBeforeTools, -1);

  auto statsBeforeSave = model->runtimeStats();
  double cacheTokensBeforeSave = getStatValue(statsBeforeSave, "CacheTokens");
  EXPECT_GT(cacheTokensBeforeSave, 0.0);

  std::string saveInput =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "session", "content": "save"}])";
  EXPECT_NO_THROW({
    std::string saveOutput = processPromptString(model, saveInput);
    EXPECT_EQ(saveOutput.length(), 0);
  });

  auto statsAfterSave = model->runtimeStats();
  double cacheTokensAfterSave = getStatValue(statsAfterSave, "CacheTokens");
  EXPECT_EQ(cacheTokensAfterSave, cacheTokensBeforeSave);
}

TEST_F(CacheManagementQwen3Test, CacheToolsAtEndModeRestoresNPastBeforeTools) {
  if (!isQwen3ModelPath(test_model_path)) {
    GTEST_SKIP() << "Test requires Qwen3 model for tools_at_end feature";
  }

  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  config_files["tools_at_end"] = "true";
  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  std::string input1 =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "user", "content": "Hi"}, {"type": "function", "name": "get_weather", "description": "Get weather", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}])";

  EXPECT_NO_THROW({
    std::string output = processPromptString(model, input1);
    EXPECT_GE(output.length(), 0);
  });

  llama_pos nPastBeforeTools1 = model->getNPastBeforeTools();
  EXPECT_EQ(nPastBeforeTools1, -1);

  std::string saveInput =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "session", "content": "save"}])";
  EXPECT_NO_THROW({
    std::string saveOutput = processPromptString(model, saveInput);
    EXPECT_EQ(saveOutput.length(), 0);
  });

  EXPECT_TRUE(fs::exists(session1_path));

  auto model2 = createModel();
  if (!model2) {
    FAIL() << "Model2 failed to load";
  }

  std::string input2 =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "user", "content": "What about London?"}])";

  EXPECT_NO_THROW({
    std::string output = processPromptString(model2, input2);
    EXPECT_GE(output.length(), 0);
  });

  llama_pos nPastBeforeTools2 = model2->getNPastBeforeTools();
  EXPECT_EQ(nPastBeforeTools2, -1);
}
