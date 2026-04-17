#include <any>
#include <filesystem>
#include <memory>
#include <string>
#include <unordered_map>

#include <gtest/gtest.h>

#include "model-interface/LlamaModel.hpp"
#include "test_common.hpp"
#include "test_prompt_helpers.hpp"

namespace fs = std::filesystem;

using test_common::getStatValue;
using test_common::processPromptWithCacheOptions;

namespace {
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

TEST_F(CacheManagementQwen3Test, CacheWithToolsCompactTrueTrimsToolTokens) {
  if (!isQwen3ModelPath(test_model_path)) {
    GTEST_SKIP() << "Test requires Qwen3 model for tools_compact feature";
  }

  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  config_files["tools_compact"] = "true";
  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW({
    std::string output = processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "What is the weather in Tokyo?"}, {"type": "function", "name": "getWeather", "description": "Get weather forecast", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}])",
        session1_path,
        true);
    EXPECT_FALSE(output.empty());
  });

  auto statsBeforeSave = model->runtimeStats();
  double cacheTokensBeforeSave = getStatValue(statsBeforeSave, "CacheTokens");
  EXPECT_GT(cacheTokensBeforeSave, 0.0);

  llama_pos nPastBeforeTools = model->getNPastBeforeTools();
  EXPECT_EQ(nPastBeforeTools, -1);

  EXPECT_TRUE(fs::exists(session1_path));
}

TEST_F(CacheManagementQwen3Test, CacheReloadWithToolsCompactTrue) {
  if (!isQwen3ModelPath(test_model_path)) {
    GTEST_SKIP() << "Test requires Qwen3 model for tools_compact feature";
  }

  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  config_files["tools_compact"] = "true";
  auto model1 = createModel();
  if (!model1) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW({
    std::string output = processPromptWithCacheOptions(
        model1,
        R"([{"role": "user", "content": "What is the weather in Tokyo?"}, {"type": "function", "name": "getWeather", "description": "Get weather forecast", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}])",
        session1_path,
        true);
    EXPECT_FALSE(output.empty());
  });

  llama_pos nPastBeforeTools1 = model1->getNPastBeforeTools();
  EXPECT_EQ(nPastBeforeTools1, -1);

  EXPECT_TRUE(fs::exists(session1_path));

  model1.reset();

  auto model2 = createModel();
  if (!model2) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW({
    std::string output = processPromptWithCacheOptions(
        model2,
        R"([{"role": "user", "content": "What is the weather in London?"}])",
        session1_path);
    EXPECT_FALSE(output.empty());
  });

  auto statsAfterReload = model2->runtimeStats();
  double cacheTokensAfterReload = getStatValue(statsAfterReload, "CacheTokens");
  EXPECT_GT(cacheTokensAfterReload, 0.0);

  llama_pos nPastBeforeTools2 = model2->getNPastBeforeTools();
  EXPECT_EQ(nPastBeforeTools2, -1);
}

TEST_F(CacheManagementQwen3Test, CacheWithoutToolsWithToolsCompactTrue) {
  if (!isQwen3ModelPath(test_model_path)) {
    GTEST_SKIP() << "Test requires Qwen3 model for tools_compact feature";
  }

  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  config_files["tools_compact"] = "true";
  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW({
    std::string output = processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "What is bitcoin? Answer shortly."}])",
        session1_path,
        true);
    EXPECT_FALSE(output.empty());
  });

  auto statsBeforeSave = model->runtimeStats();
  double cacheTokensBeforeSave = getStatValue(statsBeforeSave, "CacheTokens");
  EXPECT_GT(cacheTokensBeforeSave, 0.0);

  llama_pos nPastBeforeTools = model->getNPastBeforeTools();
  EXPECT_EQ(nPastBeforeTools, -1);

  EXPECT_TRUE(fs::exists(session1_path));
}

TEST_F(CacheManagementQwen3Test, CacheToolsCompactModeWithMultiplePrompts) {
  if (!isQwen3ModelPath(test_model_path)) {
    GTEST_SKIP() << "Test requires Qwen3 model for tools_compact feature";
  }

  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  config_files["tools_compact"] = "true";
  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW({
    std::string output = processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "Hi"}, {"type": "function", "name": "get_weather", "description": "Get detailed weather forecast data with temperature humidity wind speed precipitation UV visibility pressure sunrise sunset alerts", "parameters": {"type": "object", "properties": {"city": {"type": "string", "description": "The name of the city to get weather for"}, "country": {"type": "string", "description": "Country code or name"}, "lat": {"type": "number", "description": "Latitude coordinate"}, "lon": {"type": "number", "description": "Longitude coordinate"}, "zip": {"type": "string", "description": "ZIP postal code"}, "units": {"type": "string", "description": "Temperature units metric imperial or kelvin"}, "lang": {"type": "string", "description": "Language code for localized descriptions"}, "forecast_days": {"type": "integer", "description": "Number of days to forecast from 1 to 7"}, "hourly": {"type": "boolean", "description": "Include hourly forecast data"}, "alerts": {"type": "boolean", "description": "Include weather alerts and warnings"}, "aqi": {"type": "boolean", "description": "Include air quality index data"}, "tides": {"type": "boolean", "description": "Include tide information"}, "solar": {"type": "boolean", "description": "Include solar data like sunrise sunset"}, "tz": {"type": "string", "description": "Timezone identifier"}, "start_dt": {"type": "string", "description": "Start datetime for historical data"}, "end_dt": {"type": "string", "description": "End datetime for historical data"}, "cnt": {"type": "integer", "description": "Number of data points to return"}, "mode": {"type": "string", "description": "Response mode json xml or html"}, "appid": {"type": "string", "description": "API key for authentication"}}, "required": ["city"]}}])",
        session1_path);
    EXPECT_FALSE(output.empty());
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

  EXPECT_NO_THROW({
    std::string output = processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "What about London?"}])",
        session1_path);
    EXPECT_FALSE(output.empty());
  });

  auto stats2 = model->runtimeStats();
  double cacheTokens2 = getStatValue(stats2, "CacheTokens");
  double promptTokens2 = getStatValue(stats2, "promptTokens");
  EXPECT_GT(cacheTokens2, cacheTokens1);
  EXPECT_LT(promptTokens2, 500.0);
  EXPECT_LE(cacheTokens2, maxExpectedCacheTokens)
      << "Cache tokens (" << cacheTokens1 << ") should not exceed "
      << maxExpectedCacheTokens << " - function tokens should be trimmed";

  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "Save checkpoint."}])",
        session1_path,
        true);
  });

  EXPECT_TRUE(fs::exists(session1_path));

  model.reset();

  auto model2 = createModel();
  if (!model2) {
    FAIL() << "Model2 failed to load";
  }

  EXPECT_NO_THROW({
    std::string output = processPromptWithCacheOptions(
        model2,
        R"([{"role": "user", "content": "What about Paris?"}])",
        session1_path);
    EXPECT_FALSE(output.empty());
  });

  auto stats3 = model2->runtimeStats();
  double cacheTokens3 = getStatValue(stats3, "CacheTokens");
  double promptTokens3 = getStatValue(stats3, "promptTokens");

  EXPECT_GT(cacheTokens3, cacheTokens2);
  EXPECT_LT(promptTokens3, 100.0);
}

TEST_F(
    CacheManagementQwen3Test,
    CacheToolsCompactModeTrimOnlyWhenNPastBeforeToolsPositive) {
  if (!isQwen3ModelPath(test_model_path)) {
    GTEST_SKIP() << "Test requires Qwen3 model for tools_compact feature";
  }

  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  config_files["tools_compact"] = "true";
  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW({
    std::string output = processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "Hello"}])",
        session1_path,
        true);
    EXPECT_FALSE(output.empty());
  });

  llama_pos nPastBeforeTools = model->getNPastBeforeTools();
  EXPECT_EQ(nPastBeforeTools, -1);

  auto statsAfterSave = model->runtimeStats();
  double cacheTokensAfterSave = getStatValue(statsAfterSave, "CacheTokens");
  EXPECT_GT(cacheTokensAfterSave, 0.0);

  EXPECT_TRUE(fs::exists(session1_path));
}

TEST_F(
    CacheManagementQwen3Test, CacheToolsCompactModeRestoresNPastBeforeTools) {
  if (!isQwen3ModelPath(test_model_path)) {
    GTEST_SKIP() << "Test requires Qwen3 model for tools_compact feature";
  }

  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  config_files["tools_compact"] = "true";
  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW({
    std::string output = processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "Hi"}, {"type": "function", "name": "get_weather", "description": "Get weather", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}])",
        session1_path,
        true);
    EXPECT_FALSE(output.empty());
  });

  llama_pos nPastBeforeTools1 = model->getNPastBeforeTools();
  EXPECT_EQ(nPastBeforeTools1, -1);

  EXPECT_TRUE(fs::exists(session1_path));

  auto model2 = createModel();
  if (!model2) {
    FAIL() << "Model2 failed to load";
  }

  EXPECT_NO_THROW({
    std::string output = processPromptWithCacheOptions(
        model2,
        R"([{"role": "user", "content": "What about London?"}])",
        session1_path);
    EXPECT_FALSE(output.empty());
  });

  llama_pos nPastBeforeTools2 = model2->getNPastBeforeTools();
  EXPECT_EQ(nPastBeforeTools2, -1);
}

// Deterministic regression: once tools boundary is set, a later prefill slide
// must shift nPastBeforeTools left by exactly min(n_discarded, safeLimit).
// This exercises the same adjustAfterSlide path without stochastic generation.
TEST_F(
    CacheManagementQwen3Test,
    CacheToolsCompactSlidingDuringGenDoesNotLeakToolTokens) {
  if (!isQwen3ModelPath(test_model_path)) {
    GTEST_SKIP() << "Test requires Qwen3 model for tools_compact feature";
  }
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto runPrefillWithCache = [](const std::unique_ptr<LlamaModel>& model,
                                const std::string& input,
                                const std::string& cacheKey) {
    LlamaModel::Prompt p;
    p.input = input;
    p.prefill = true;
    p.cacheKey = cacheKey;
    model->processPrompt(p);
  };

  std::string toolJson =
      R"({"type":"function","name":"get_weather","description":"Get weather",)"
      R"("parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}})";

  std::string stepA =
      R"([{"role":"user","content":"What is weather in Tokyo?"},)" + toolJson +
      R"(])";

  std::string stepB =
      R"([{"role":"assistant","content":"<tool_call>{\"name\":\"get_weather\",\"arguments\":{\"city\":\"Tokyo\"}}</tool_call>"},)"
      R"({"role":"tool","content":"{\"city\":\"Tokyo\",\"temp_c\":24}"},)"
      R"({"role":"user","content":"Summarize weather and practical tips for clothes and hydration."}])";

  const std::string sessionPath = "test_sliding_qwen3.bin";
  constexpr int nDiscarded = 1000;

  config_files["tools_compact"] = "true";
  config_files["ctx_size"] = "2048";
  config_files["n_discarded"] = std::to_string(nDiscarded);
  config_files["temp"] = "0";
  config_files["n_predict"] = "0";

  auto seedModel = createModel();
  ASSERT_TRUE(seedModel);
  EXPECT_NO_THROW(processPromptWithCacheOptions(
      seedModel,
      R"([{"role":"system","content":"You are a helpful assistant."}])",
      sessionPath,
      true));

  auto baselineModel = createModel();
  ASSERT_TRUE(baselineModel);
  EXPECT_NO_THROW(runPrefillWithCache(baselineModel, stepA, sessionPath));
  const double anchorBefore =
      static_cast<double>(baselineModel->getNPastBeforeTools());
  const double firstMsg =
      getStatValue(baselineModel->runtimeDebugStats(), "firstMsgTokens");
  const double nPastAfterA =
      getStatValue(baselineModel->runtimeStats(), "CacheTokens");
  EXPECT_GT(anchorBefore, firstMsg);

  EXPECT_NO_THROW(runPrefillWithCache(baselineModel, stepB, sessionPath));
  const double nPastAfterB =
      getStatValue(baselineModel->runtimeStats(), "CacheTokens");
  const double stepBTokens = nPastAfterB - nPastAfterA;
  ASSERT_GT(stepBTokens, 0);

  // Force exactly one prefill slide in step B:
  // nPastAfterA + stepBTokens >= ctx
  // nPastAfterA + stepBTokens - discard < ctx
  // with discard = min(nDiscarded, anchorBefore-firstMsg)
  const double expectedDiscard =
      std::min(static_cast<double>(nDiscarded), anchorBefore - firstMsg);
  const int slideCtx = static_cast<int>(nPastAfterA + 1.0);

  config_files["ctx_size"] = std::to_string(slideCtx);
  auto slideModel = createModel();
  ASSERT_TRUE(slideModel);
  EXPECT_NO_THROW(runPrefillWithCache(slideModel, stepA, sessionPath));
  EXPECT_NO_THROW(runPrefillWithCache(slideModel, stepB, sessionPath));

  const auto slideStats = slideModel->runtimeStats();
  const double slides = getStatValue(slideStats, "contextSlides");
  const double anchorAfter =
      static_cast<double>(slideModel->getNPastBeforeTools());

  EXPECT_LE(anchorAfter, anchorBefore) << "Anchor should never move right";
  EXPECT_GE(anchorAfter, firstMsg)
      << "Anchor should never cross first message boundary";

  if (slides > 0) {
    EXPECT_LT(anchorAfter, anchorBefore)
        << "Anchor should move left when slide is reported";
  } else {
    EXPECT_GE(anchorAfter, anchorBefore - expectedDiscard)
        << "Without reported slide, anchor should not jump left unexpectedly";
  }
}

TEST_F(
    CacheManagementQwen3Test,
    ToolsCompactPromptValidationRejectsMalformedLayoutsEndToEnd) {
  if (!isQwen3ModelPath(test_model_path)) {
    GTEST_SKIP() << "Test requires Qwen3 model for tools_compact feature";
  }
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  config_files["tools_compact"] = "true";
  config_files["ctx_size"] = "256";
  config_files["n_predict"] = "0";
  config_files["temp"] = "0";

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  auto expectInvalid = [&](const std::string& input, const std::string& hint) {
    LlamaModel::Prompt prompt;
    prompt.input = input;
    try {
      (void)model->processPrompt(prompt);
      FAIL() << "Expected invalid prompt error: " << hint;
    } catch (const qvac_errors::StatusError& err) {
      const std::string msg = err.what();
      EXPECT_NE(msg.find(hint), std::string::npos)
          << "Unexpected error message: " << msg;
    }
  };

  expectInvalid(
      R"([{"role":"system","content":"policy"},{"type":"function","name":"get_weather","description":"Get weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}])",
      "tools_compact requires at least one user or tool message before tool definitions");

  expectInvalid(
      R"([{"role":"user","content":"hello"},{"role":"assistant","content":"thinking"},{"type":"function","name":"get_weather","description":"Get weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}])",
      "tools_compact requires tool definitions to immediately follow the last user/tool message");

  expectInvalid(
      R"([{"role":"user","content":"hello"},{"type":"function","name":"tool_a","description":"A","parameters":{"type":"object","properties":{"x":{"type":"string"}},"required":["x"]}},{"role":"assistant","content":"between"},{"type":"function","name":"tool_b","description":"B","parameters":{"type":"object","properties":{"y":{"type":"string"}},"required":["y"]}}])",
      "tools_compact requires tool definitions to form a contiguous block");

  expectInvalid(
      R"([{"role":"user","content":"hello"},{"type":"function","name":"get_weather","description":"Get weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}},{"role":"assistant","content":"after tools"}])",
      "tools_compact requires tool definitions to be at the end of the prompt");

  LlamaModel::Prompt validPrompt;
  validPrompt.input =
      R"([{"role":"user","content":"what weather?"},{"type":"function","name":"get_weather","description":"Get weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}])";
  EXPECT_NO_THROW((void)model->processPrompt(validPrompt));
}
