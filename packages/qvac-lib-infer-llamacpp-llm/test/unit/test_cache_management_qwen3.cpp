#include <any>
#include <filesystem>
#include <iostream>
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

TEST_F(CacheManagementQwen3Test, CacheToolsCompactModeRestoresNPastBeforeTools) {
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

// Regression test: context sliding during generation with tools_compact
// must adjust nPastBeforeTools so the post-generation trim does not leave
// stale tool tokens in the KV cache.
//
// Strategy: two-phase comparison.
//   Phase 1 (baseline): large context, n_predict=0 → no generation,
//     no sliding. nPastBeforeTools is the original boundary.
//   Phase 2 (sliding): small context, n_predict=200 → generation fills
//     context, sliding fires. After trim, nPastBeforeTools should be
//     smaller than baseline because adjustAfterSlide reduced it.
//
//   With fix:    nPastBeforeTools < baseline (adjusted)
//   Without fix: nPastBeforeTools == baseline (stale) → FAIL
TEST_F(
    CacheManagementQwen3Test,
    CacheToolsCompactSlidingDuringGenDoesNotLeakToolTokens) {
  if (!isQwen3ModelPath(test_model_path)) {
    GTEST_SKIP() << "Test requires Qwen3 model for tools_compact feature";
  }

  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  // Shared tool definition and user message for both phases
  std::string toolJson =
      R"({"type": "function", "name": "get_weather",)"
      R"( "description": "Get weather forecast for a city",)"
      R"( "parameters": {"type": "object", "properties": {)"
      R"("city": {"type": "string", "description": "City name"},)"
      R"("units": {"type": "string", "description": "Units metric or imperial"})"
      R"(}, "required": ["city"]}})";

  std::string userMsg =
      "I am planning a comprehensive outdoor event for next Saturday and "
      "I need very detailed weather information for the entire weekend. "
      "Please check the forecast for New York City including temperature "
      "ranges, precipitation probability, wind speed and direction, "
      "humidity levels, UV index, sunrise and sunset times, and any "
      "severe weather advisories that might be in effect.";

  // We need a session so firstMsgTokens is small (just system prompt).
  // Without a session, firstMsgTokens = entire prefill and sliding
  // can't affect the anchor (it's within the protected first message).
  std::string sessionPath = "test_sliding_qwen3.bin";

  // ── Phase 1: establish session cache with system prompt ──
  config_files["tools_compact"] = "true";
  config_files["ctx_size"] = "1024";
  config_files["n_predict"] = "0";
  auto initModel = createModel();
  if (!initModel) {
    FAIL() << "Init model failed to load";
  }

  processPromptWithCacheOptions(
      initModel,
      R"( {"role": "system", "content": "You are a helpful assistant."}])",
      sessionPath,
      true);

  // ── Phase 2 (baseline): load session, send user+tools, n_predict=0 ──
  // No generation, no sliding. Records the original nPastBeforeTools.
  config_files["ctx_size"] = "1024";
  config_files["n_predict"] = "0";
  auto baselineModel = createModel();
  if (!baselineModel) {
    FAIL() << "Baseline model failed to load";
  }

  processPromptWithCacheOptions(
      baselineModel,
      R"( {"role": "user", "content": ")" + userMsg + R"("}, )" + toolJson + R"(])",
      sessionPath,
      true);
  auto baselineStats = baselineModel->runtimeStats();
  auto baselineDebug = baselineModel->runtimeDebugStats();
  double baselineNPBT = getStatValue(baselineDebug, "nPastBeforeTools");
  double baselineSlides = getStatValue(baselineStats, "contextSlides");

  EXPECT_EQ(baselineSlides, 0)
      << "Baseline must not slide (n_predict=0 in 1024 context)";
  EXPECT_GT(baselineNPBT, 0)
      << "Baseline nPastBeforeTools must be set";

  // ── Phase 3 (sliding): load session, same input, small context ──
  // Generation fills context → sliding fires. After sliding,
  // nPastBeforeTools must be exactly (baseline - slides * nDiscarded).
  constexpr int nDiscarded = 100;
  config_files["ctx_size"] = "256";
  config_files["n_discarded"] = std::to_string(nDiscarded);
  config_files["n_predict"] = "200";
  auto slideModel = createModel();
  if (!slideModel) {
    FAIL() << "Sliding model failed to load";
  }

  EXPECT_NO_THROW({
    std::string output = processPromptWithCacheOptions(
        slideModel,
        R"( {"role": "user", "content": ")" + userMsg + R"("}, )" + toolJson + R"(])",
        sessionPath,
        true);
    EXPECT_FALSE(output.empty());
  });

  auto slideStats = slideModel->runtimeStats();
  auto slideDebug = slideModel->runtimeDebugStats();
  double slideNPBT = getStatValue(slideDebug, "nPastBeforeTools");
  double slideSlides = getStatValue(slideStats, "contextSlides");
  double slideTrimmed = getStatValue(slideDebug, "toolsTrimmed");

  EXPECT_GT(slideSlides, 0)
      << "Context sliding must occur (if not, increase user message "
         "length or reduce ctx_size)";

  // The first slide discards min(nDiscarded, nPastBeforeTools - firstMsgTokens)
  // tokens. With a session, firstMsgTokens is the system prompt tokens (small).
  // Subsequent slides have a smaller safeLimit as the anchor shrinks.
  // We use firstMsgTokens from baseline debug stats to compute exact expected values.
  double baselineFirstMsg = getStatValue(baselineDebug, "firstMsgTokens");
  double safeLimit = baselineNPBT - baselineFirstMsg;
  EXPECT_GT(safeLimit, 0)
      << "safeLimit (nPBT - firstMsg = " << baselineNPBT << " - "
      << baselineFirstMsg << ") must be positive";

  // For each slide, the actual discard is min(nDiscarded, current safeLimit).
  // Compute expected anchor by simulating slides.
  double expectedNPBT = baselineNPBT;
  for (int i = 0; i < static_cast<int>(slideSlides); i++) {
    double currentSafe = expectedNPBT - baselineFirstMsg;
    if (currentSafe <= 0) break;
    double actualDiscard = std::min(static_cast<double>(nDiscarded), currentSafe);
    expectedNPBT -= actualDiscard;
  }

  EXPECT_EQ(slideNPBT, expectedNPBT)
      << "nPastBeforeTools should be " << expectedNPBT
      << " (baseline=" << baselineNPBT
      << ", firstMsg=" << baselineFirstMsg
      << ", slides=" << slideSlides
      << ", nDiscarded=" << nDiscarded << ")"
      << ", got " << slideNPBT;

  if (slideTrimmed > 0) {
    // Cache should equal the adjusted anchor after trim
    double slideCacheTokens = getStatValue(slideStats, "CacheTokens");
    EXPECT_EQ(slideCacheTokens, slideNPBT)
        << "CacheTokens should equal adjusted nPastBeforeTools after trim";
  }

  // Cleanup session file
  std::remove(sessionPath.c_str());
}

// Same as above but with a conversation region larger than n_discarded.
// No clamping — each slide discards exactly n_discarded tokens and the
// anchor moves by exactly that amount per slide.
TEST_F(
    CacheManagementQwen3Test,
    CacheToolsCompactSlidingUnclampedFullDiscard) {
  if (!isQwen3ModelPath(test_model_path)) {
    GTEST_SKIP() << "Test requires Qwen3 model for tools_compact feature";
  }

  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  std::string toolJson =
      R"({"type": "function", "name": "get_weather",)"
      R"( "description": "Get weather",)"
      R"( "parameters": {"type": "object", "properties": {)"
      R"("city": {"type": "string"})"
      R"(}, "required": ["city"]}})";

  // Very long user message to ensure conversation region > n_discarded (100).
  // ~300 tokens of user text → safeLimit ≈ 300 > 100, no clamping even
  // after 2 slides (300-200=100 still >= n_discarded).
  std::string userMsg =
      "I am organizing a large outdoor music festival that will span three "
      "full days next weekend and I need comprehensive weather forecasts for "
      "each day. The festival will be held in Central Park, New York City. "
      "Please provide detailed hourly temperature projections, precipitation "
      "probability percentages, wind speed and direction forecasts, humidity "
      "levels throughout the day, UV index readings, sunrise and sunset "
      "times, and any severe weather advisories or watches that may be in "
      "effect. I also need information about overnight low temperatures "
      "since some attendees will be camping. Additionally check for any "
      "fog advisories for the early morning sound check sessions. "
      "Furthermore I need to know about air quality index measurements "
      "and pollen count forecasts for allergy sensitive attendees. "
      "Please also include information about road conditions and any "
      "construction detours that might affect traffic flow to the venue. "
      "I would appreciate tidal information for the nearby harbor area "
      "and marine forecasts for the river cruise after party event. "
      "Finally check the aviation weather for drone filming permits "
      "and agricultural forecasts for the organic food vendor section. "
      "The event insurance company requires all of this documentation "
      "before they will finalize coverage for the outdoor portions "
      "of the festival including the main stage and acoustic tent areas.";

  std::string sessionPath = "test_sliding_unclamped_qwen3.bin";

  // ── Phase 1: establish session ──
  config_files["tools_compact"] = "true";
  config_files["ctx_size"] = "2048";
  config_files["n_predict"] = "0";
  auto initModel = createModel();
  if (!initModel) {
    FAIL() << "Init model failed to load";
  }

  processPromptWithCacheOptions(
      initModel,
      R"( {"role": "system", "content": "You are a helpful assistant."}])",
      sessionPath,
      true);

  // ── Phase 2: baseline (no sliding) ──
  config_files["ctx_size"] = "2048";
  config_files["n_predict"] = "0";
  auto baselineModel = createModel();
  if (!baselineModel) {
    FAIL() << "Baseline model failed to load";
  }

  processPromptWithCacheOptions(
      baselineModel,
      R"( {"role": "user", "content": ")" + userMsg + R"("}, )" + toolJson + R"(])",
      sessionPath);
  auto baselineStats = baselineModel->runtimeStats();
  auto baselineDebug = baselineModel->runtimeDebugStats();
  double baselineNPBT = getStatValue(baselineDebug, "nPastBeforeTools");
  double baselineFirstMsg = getStatValue(baselineDebug, "firstMsgTokens");
  double baselineSlides = getStatValue(baselineStats, "contextSlides");

  EXPECT_EQ(baselineSlides, 0) << "Baseline must not slide";
  EXPECT_GT(baselineNPBT, 0) << "Baseline anchor must be set";

  // Verify the conversation region is larger than n_discarded (100).
  // With ~300 tokens of user text, safeLimit ≈ 300 > 100. Even after
  // 2 slides (300-200=100), the safe limit still equals n_discarded.
  constexpr int nDiscarded = 100;
  double safeLimit = baselineNPBT - baselineFirstMsg;
  EXPECT_GT(safeLimit, nDiscarded)
      << "Conversation region (" << safeLimit
      << ") must exceed n_discarded (" << nDiscarded
      << ") for unclamped test";

  // ── Phase 3: sliding ──
  // Prefill ≈ 350 tokens (300 user + 50 tools). ctx=512 leaves
  // ~160 tokens for generation before first slide. n_predict=200
  // fills context. Each slide discards exactly 100 tokens (unclamped
  // because safeLimit ≈ 300 >> 100).
  config_files["ctx_size"] = "512";
  config_files["n_discarded"] = std::to_string(nDiscarded);
  config_files["n_predict"] = "200";
  auto slideModel = createModel();
  if (!slideModel) {
    FAIL() << "Sliding model failed to load";
  }

  EXPECT_NO_THROW({
    std::string output = processPromptWithCacheOptions(
        slideModel,
        R"( {"role": "user", "content": ")" + userMsg + R"("}, )" + toolJson + R"(])",
        sessionPath);
    EXPECT_FALSE(output.empty());
  });

  auto slideStats = slideModel->runtimeStats();
  auto slideDebug = slideModel->runtimeDebugStats();
  double slideNPBT = getStatValue(slideDebug, "nPastBeforeTools");
  double slideSlides = getStatValue(slideStats, "contextSlides");

  EXPECT_GT(slideSlides, 0) << "Sliding must occur";

  // Simulate per-slide discard with clamping.
  double expectedNPBT = baselineNPBT;
  int unclampedSlides = 0;
  for (int i = 0; i < static_cast<int>(slideSlides); i++) {
    double currentSafe = expectedNPBT - baselineFirstMsg;
    if (currentSafe <= 0) break;
    double actualDiscard = std::min(static_cast<double>(nDiscarded), currentSafe);
    if (actualDiscard == nDiscarded) unclampedSlides++;
    expectedNPBT -= actualDiscard;
  }

  // With a long user message and small n_discarded, most slides should
  // be unclamped (full nDiscarded tokens discarded each time).
  EXPECT_GE(unclampedSlides, 1)
      << "At least 1 slide should be unclamped (full " << nDiscarded
      << " tokens discarded)";

  EXPECT_EQ(slideNPBT, expectedNPBT)
      << "Anchor should be " << expectedNPBT
      << " (baseline=" << baselineNPBT
      << ", firstMsg=" << baselineFirstMsg
      << ", slides=" << slideSlides
      << ", nDiscarded=" << nDiscarded
      << ", unclamped=" << unclampedSlides << ")"
      << ", got " << slideNPBT;

  // Cleanup
  std::remove(sessionPath.c_str());
}
