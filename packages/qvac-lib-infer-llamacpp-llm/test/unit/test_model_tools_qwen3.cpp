#include <filesystem>
#include <memory>
#include <string>
#include <unordered_map>

#include <gtest/gtest.h>

#include "common/chat.h"
#include "model-interface/LlamaModel.hpp"
#include "test_common.hpp"

namespace {
constexpr std::string_view THINK_START = "<think>";
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

namespace fs = std::filesystem;

class ModelToolsQwen3Test : public ::testing::Test {
protected:
  void SetUp() override {
    config_files["device"] = test_common::getTestDevice();
    config_files["ctx_size"] = "2048";
    config_files["gpu_layers"] = test_common::getTestGpuLayers();
    config_files["n_predict"] = "10";
    config_files["tools"] = "true";
    config_files["tools_compact"] = "true";

    // test_model_path = test_common::BaseTestModelPath::get();
    test_model_path = test_common::BaseTestModelPath::get(
        "Qwen3-1.7B-Q4_0.gguf", "Llama-3.2-1B-Instruct-Q4_0.gguf");
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

  std::string processPrompt(
      const std::unique_ptr<LlamaModel>& model, const std::string& input) {
    LlamaModel::Prompt prompt;
    prompt.input = input;
    return model->processPrompt(prompt);
  }
};

TEST_F(ModelToolsQwen3Test, CacheEnabledWithToolMessage) {
  if (!isQwen3ModelPath(test_model_path)) {
    GTEST_SKIP() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  const std::string session_file = "test_tool_cache.bin";

  if (fs::exists(session_file)) {
    fs::remove(session_file);
  }

  // Step 1: System prompt with tools + user "hi" to establish cache
  {
    std::string input1 = R"([{"role": "session", "content": ")" + session_file +
                         R"("},)"
                         R"( {"role": "user", "content": "hi"}])";

    EXPECT_NO_THROW({
      std::string output1 = processPrompt(model, input1);
      (void)output1;
    });
  }

  // Step 2: User prompt asking for tool invocation
  {
    std::string input2 =
        R"([{"role": "session", "content": ")" + session_file +
        R"("},)"
        R"( {"role": "user", "content": "What is the weather in Tokyo?"},)"
        R"( {"type": "function", "name": "getWeather", "description": "Get weather forecast for a city", "parameters": {"type": "object", "properties": {"city": {"type": "string"}, "date": {"type": "string"}}, "required": ["city", "date"]}}])";

    std::string output2;
    EXPECT_NO_THROW({ output2 = processPrompt(model, input2); });

    EXPECT_GT(output2.length(), 0)
        << "Expected non-empty output after prompt with tools";
    EXPECT_TRUE(output2.starts_with(THINK_START));
  }

  // Step 3: Tool result message (role: 'tool')
  {
    std::string input3 =
        R"([{"role": "session", "content": ")" + session_file +
        R"("},)"
        R"( {"role": "tool", "content": "{\"city\":\"Tokyo\",\"date\":\"2025-04-02\",\"temperature\":2,\"conditions\":\"rainy\"}"}])";

    std::string output3;
    EXPECT_NO_THROW({ output3 = processPrompt(model, input3); });

    EXPECT_GT(output3.length(), 0)
        << "Model should produce non-empty output after tool result";
    EXPECT_TRUE(output3.starts_with(THINK_START));
  }

  // Clean up
  if (fs::exists(session_file)) {
    fs::remove(session_file);
  }
}

TEST_F(ModelToolsQwen3Test, ToolsCompactRejectsPromptWithoutTools) {
  if (!isQwen3ModelPath(test_model_path)) {
    GTEST_SKIP() << "Test requires Qwen3 model for tools_compact feature";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  const std::string input =
      R"([{"role": "user", "content": "Hello without tools"}])";
  EXPECT_THROW(
      { (void)processPrompt(model, input); }, qvac_errors::StatusError);
}

TEST_F(ModelToolsQwen3Test, ToolsCompactRejectsToolsWithoutUserMessage) {
  if (!isQwen3ModelPath(test_model_path)) {
    GTEST_SKIP() << "Test requires Qwen3 model for tools_compact feature";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  const std::string input =
      R"([{"type":"function","name":"getWeather","parameters":{"type":"object"}}])";
  EXPECT_THROW(
      { (void)processPrompt(model, input); }, qvac_errors::StatusError);
}

TEST_F(ModelToolsQwen3Test, ToolsCompactRejectsSplitOrDetachedToolBlocks) {
  if (!isQwen3ModelPath(test_model_path)) {
    GTEST_SKIP() << "Test requires Qwen3 model for tools_compact feature";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  const std::string detachedInput = R"([
    {"role":"user","content":"What is weather?"},
    {"role":"assistant","content":"Let me check."},
    {"type":"function","name":"getWeather","parameters":{"type":"object"}}
  ])";
  EXPECT_THROW(
      { (void)processPrompt(model, detachedInput); }, qvac_errors::StatusError);

  const std::string splitInput = R"([
    {"role":"user","content":"What is weather?"},
    {"type":"function","name":"getWeather","parameters":{"type":"object"}},
    {"role":"assistant","content":"I may need another tool."},
    {"type":"function","name":"lookupCity","parameters":{"type":"object"}}
  ])";
  EXPECT_THROW(
      { (void)processPrompt(model, splitInput); }, qvac_errors::StatusError);
}

TEST_F(ModelToolsQwen3Test, CacheEnabledWithToolMessageToolsCompactFalse) {
  if (!isQwen3ModelPath(test_model_path)) {
    GTEST_SKIP() << "Test model not found";
  }

  config_files["tools_compact"] = "false";
  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  const std::string session_file = "test_tool_cache_no_tools_compact.bin";

  if (fs::exists(session_file)) {
    fs::remove(session_file);
  }

  // Step 1: Establish cache
  {
    std::string input1 = R"([{"role": "session", "content": ")" + session_file +
                         R"("}, {"role": "user", "content": "hi"}])";

    EXPECT_NO_THROW({
      std::string output1 = processPrompt(model, input1);
      (void)output1;
    });
  }

  // Step 2: Prompt with tools (should trigger tool call)
  {
    std::string input2 =
        R"([{"role": "session", "content": ")" + session_file +
        R"("}, {"role": "user", "content": "What is the weather in Tokyo?"}, {"type": "function", "name": "getWeather", "description": "Get weather forecast", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}])";

    std::string output2;
    EXPECT_NO_THROW({ output2 = processPrompt(model, input2); });

    EXPECT_GT(output2.length(), 5)
        << "Expected non-empty output after prompt with tools";
    EXPECT_TRUE(output2.starts_with(THINK_START));
  }

  // Step 3: Tool result message - this is the critical step
  {
    std::string input3 =
        R"([{"role": "session", "content": ")" + session_file +
        R"("}, {"role": "tool", "content": "{\"city\":\"Tokyo\",\"temperature\":2,\"conditions\":\"rainy\"}"}])";

    std::string output3;
    EXPECT_NO_THROW({ output3 = processPrompt(model, input3); });

    EXPECT_GT(output3.length(), 5)
        << "Model should produce non-empty output after tool result";
    EXPECT_TRUE(output3.starts_with(THINK_START));
  }

  // Clean up
  if (fs::exists(session_file)) {
    fs::remove(session_file);
  }
}

TEST_F(ModelToolsQwen3Test, MultiTurnWithToolsAndCache) {
  if (!isQwen3ModelPath(test_model_path)) {
    GTEST_SKIP() << "Test model not found";
  }

  config_files["tools_compact"] = "false";
  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  const std::string session_file = "test_multi_turn_tools.bin";

  if (fs::exists(session_file)) {
    fs::remove(session_file);
  }

  // Turn 1: User asks about weather (triggers tool call)
  {
    std::string input =
        R"([{"role": "session", "content": ")" + session_file +
        R"("},)"
        R"( {"role": "user", "content": "What is the weather in Paris and London?"},)"
        R"( {"type": "function", "name": "getWeather", "description": "Get weather", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}])";

    std::string output;
    EXPECT_NO_THROW({ output = processPrompt(model, input); });

    EXPECT_GT(output.length(), 5) << "Expected non-empty output in turn 1";
    EXPECT_TRUE(output.starts_with(THINK_START));
  }

  // Turn 2: Tool results for both Paris and London
  {
    std::string input =
        R"([{"role": "session", "content": ")" + session_file +
        R"("},)"
        R"( {"role": "tool", "content": "{\"city\":\"Paris\",\"temperature\":18,\"conditions\":\"cloudy\"}"},)"
        R"( {"role": "tool", "content": "{\"city\":\"London\",\"temperature\":8,\"conditions\":\"sunny\"}"}])";

    std::string output;
    EXPECT_NO_THROW({ output = processPrompt(model, input); });

    EXPECT_GT(output.length(), 5) << "Expected non-empty output in turn 2";
    EXPECT_TRUE(output.starts_with(THINK_START));
  }

  // Turn 3: Tool result for Tokyo, then final answer expected
  {
    std::string input = R"([{"role": "session", "content": ")" + session_file +
                        R"("},)"
                        R"( {"role": "user", "content": "What about Tokyo?"}])";

    std::string output;
    EXPECT_NO_THROW({ output = processPrompt(model, input); });

    EXPECT_GT(output.length(), 5)
        << "Expected non-empty final answer after tool result";
    EXPECT_TRUE(output.starts_with(THINK_START));
  }

  // Turn 4: Tool results for Tokyo
  {
    std::string input =
        R"([{"role": "session", "content": ")" + session_file +
        R"("},)"
        R"( {"role": "tool", "content": "{\"city\":\"Tokyo\",\"temperature\":25,\"conditions\":\"rainy\"}"}])";
    std::string output;
    EXPECT_NO_THROW({ output = processPrompt(model, input); });

    EXPECT_GT(output.length(), 5)
        << "Expected non-empty final answer after tool result";
    EXPECT_TRUE(output.starts_with(THINK_START));
  }

  // Clean up
  if (fs::exists(session_file)) {
    fs::remove(session_file);
  }
}
