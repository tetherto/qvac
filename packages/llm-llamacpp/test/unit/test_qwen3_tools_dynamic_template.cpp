#include <string>
#include <vector>

#include <gtest/gtest.h>

#include "common/chat.h"
#include "utils/Qwen3ToolsDynamicTemplate.hpp"

using namespace qvac_lib_inference_addon_llama::utils;

namespace {

const std::string WEATHER_TOOL_JSON =
    R"({"type": "function", "function": {"name": "getWeather", "description": "Get weather forecast", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}})";

const std::string TIME_TOOL_JSON =
    R"({"type": "function", "function": {"name": "getTime", "description": "Get current time", "parameters": {"type": "object", "properties": {"timezone": {"type": "string"}}, "required": ["timezone"]}}})";

const std::string TOOLS_PREAMBLE =
    "# Tools\n\n"
    "You may call one or more functions to assist with the user query.\n\n"
    "You are provided with function signatures within <tools></tools> XML "
    "tags:\n"
    "<tools>";

const std::string TOOLS_POSTAMBLE =
    "\n</tools>\n\n"
    "For each function call, return a json object with function name and "
    "arguments within <tool_call></tool_call> XML tags:\n"
    "<tool_call>\n"
    R"({"name": <function-name>, "arguments": <args-json-object>})"
    "\n</tool_call>";

} // namespace

class Qwen3ToolsDynamicTemplateRenderTest : public ::testing::Test {
protected:
  common_chat_templates_ptr tmpls_;

  void SetUp() override {
    const char* tmpl = getToolsDynamicQwen3Template();
    tmpls_ = common_chat_templates_init(nullptr, tmpl);
  }

  common_chat_templates_inputs makeInputs(
      std::vector<common_chat_msg> messages,
      std::vector<common_chat_tool> tools = {},
      bool addGenerationPrompt = true) {
    common_chat_templates_inputs inputs;
    inputs.use_jinja = true;
    inputs.add_generation_prompt = addGenerationPrompt;
    inputs.messages = std::move(messages);
    inputs.tools = std::move(tools);
    return inputs;
  }

  std::string render(common_chat_templates_inputs& inputs) {
    return common_chat_templates_apply(tmpls_.get(), inputs).prompt;
  }

  static common_chat_msg
  msg(const std::string& role, const std::string& content) {
    common_chat_msg m;
    m.role = role;
    m.content = content;
    return m;
  }

  static common_chat_tool tool(
      const std::string& name, const std::string& description,
      const std::string& parameters) {
    common_chat_tool t;
    t.name = name;
    t.description = description;
    t.parameters = parameters;
    return t;
  }

  static common_chat_tool weatherTool() {
    return tool(
        "getWeather",
        "Get weather forecast",
        R"({"type":"object","properties":{"city":{"type":"string"}},"required":["city"]})");
  }

  static common_chat_tool timeTool() {
    return tool(
        "getTime",
        "Get current time",
        R"({"type":"object","properties":{"timezone":{"type":"string"}},"required":["timezone"]})");
  }
};

TEST_F(Qwen3ToolsDynamicTemplateRenderTest, UserWithSingleTool) {
  auto inputs = makeInputs(
      {msg("user", "What is the weather in Tokyo?")}, {weatherTool()});

  std::string expected = "<|im_start|>user\n"
                         "What is the weather in Tokyo?<|im_end|>\n"
                         "<|im_start|>system\n" +
                         TOOLS_PREAMBLE + "\n" + WEATHER_TOOL_JSON +
                         TOOLS_POSTAMBLE +
                         "<|im_end|>\n"
                         "<|im_start|>assistant\n";

  EXPECT_EQ(render(inputs), expected);
}

TEST_F(Qwen3ToolsDynamicTemplateRenderTest, UserWithMultipleTools) {
  auto inputs = makeInputs(
      {msg("user", "What is the weather in Tokyo?")},
      {weatherTool(), timeTool()});

  std::string expected = "<|im_start|>user\n"
                         "What is the weather in Tokyo?<|im_end|>\n"
                         "<|im_start|>system\n" +
                         TOOLS_PREAMBLE + "\n" + WEATHER_TOOL_JSON + "\n" +
                         TIME_TOOL_JSON + TOOLS_POSTAMBLE +
                         "<|im_end|>\n"
                         "<|im_start|>assistant\n";

  EXPECT_EQ(render(inputs), expected);
}

TEST_F(Qwen3ToolsDynamicTemplateRenderTest, SystemAndUserWithTool) {
  auto inputs = makeInputs(
      {msg("system", "You are a helpful assistant."),
       msg("user", "What is the weather in Tokyo?")},
      {weatherTool()});

  std::string expected = "<|im_start|>system\n"
                         "You are a helpful assistant.<|im_end|>\n"
                         "<|im_start|>user\n"
                         "What is the weather in Tokyo?<|im_end|>\n"
                         "<|im_start|>system\n" +
                         TOOLS_PREAMBLE + "\n" + WEATHER_TOOL_JSON +
                         TOOLS_POSTAMBLE +
                         "<|im_end|>\n"
                         "<|im_start|>assistant\n";

  EXPECT_EQ(render(inputs), expected);
}

TEST_F(Qwen3ToolsDynamicTemplateRenderTest, ToolsAfterLastUserMessage) {
  auto inputs = makeInputs(
      {msg("user", "Hi"),
       msg("assistant", "Hello!"),
       msg("user", "What is the weather in Tokyo?")},
      {weatherTool()});

  std::string prompt = render(inputs);

  auto firstUserPos = prompt.find("<|im_start|>user\nHi<|im_end|>");
  auto assistantPos = prompt.find("<|im_start|>assistant\nHello!<|im_end|>");
  auto secondUserPos =
      prompt.find("<|im_start|>user\nWhat is the weather in Tokyo?<|im_end|>");
  auto toolsPos = prompt.find("<|im_start|>system\n# Tools");

  ASSERT_NE(firstUserPos, std::string::npos);
  ASSERT_NE(assistantPos, std::string::npos);
  ASSERT_NE(secondUserPos, std::string::npos);
  ASSERT_NE(toolsPos, std::string::npos);

  EXPECT_LT(firstUserPos, assistantPos);
  EXPECT_LT(assistantPos, secondUserPos);
  EXPECT_LT(secondUserPos, toolsPos)
      << "tools block must follow the last user message";

  auto toolsBetweenFirst =
      prompt.substr(firstUserPos, assistantPos - firstUserPos);
  EXPECT_EQ(toolsBetweenFirst.find("# Tools"), std::string::npos)
      << "tools block must NOT appear after the first user message";
}

TEST_F(
    Qwen3ToolsDynamicTemplateRenderTest,
    ToolsAfterLastUserWhenConversationContinues) {
  auto inputs = makeInputs(
      {msg("user", "Hi"),
       msg("assistant", "Hello!"),
       msg("user", "What is the weather in Tokyo?"),
       msg("assistant", "Let me check that.")},
      {weatherTool()});

  std::string prompt = render(inputs);

  auto firstUserPos = prompt.find("<|im_start|>user\nHi<|im_end|>");
  auto firstAssistantPos =
      prompt.find("<|im_start|>assistant\nHello!<|im_end|>");
  auto secondUserPos =
      prompt.find("<|im_start|>user\nWhat is the weather in Tokyo?<|im_end|>");
  auto toolsPos = prompt.find("<|im_start|>system\n# Tools");
  auto secondAssistantPos =
      prompt.find("<|im_start|>assistant\nLet me check that.<|im_end|>");

  ASSERT_NE(firstUserPos, std::string::npos);
  ASSERT_NE(firstAssistantPos, std::string::npos);
  ASSERT_NE(secondUserPos, std::string::npos);
  ASSERT_NE(toolsPos, std::string::npos);
  ASSERT_NE(secondAssistantPos, std::string::npos);

  EXPECT_LT(firstUserPos, firstAssistantPos);
  EXPECT_LT(firstAssistantPos, secondUserPos);
  EXPECT_LT(secondUserPos, toolsPos)
      << "tools block must follow the last user message";
  EXPECT_LT(toolsPos, secondAssistantPos)
      << "tools block must appear before subsequent assistant messages";

  auto betweenFirstUserAndAssistant =
      prompt.substr(firstUserPos, firstAssistantPos - firstUserPos);
  EXPECT_EQ(betweenFirstUserAndAssistant.find("# Tools"), std::string::npos)
      << "tools block must NOT appear after the first user message";
}

TEST_F(Qwen3ToolsDynamicTemplateRenderTest, ToolResponseMessage) {
  auto inputs = makeInputs(
      {msg("user", "What is the weather in Tokyo?"),
       msg("assistant", "Let me check."),
       msg("tool",
           R"({"city":"Tokyo","temperature":25,"conditions":"sunny"})")},
      {weatherTool()});

  std::string expected =
      "<|im_start|>user\n"
      "What is the weather in Tokyo?<|im_end|>\n"
      "<|im_start|>system\n" +
      TOOLS_PREAMBLE + "\n" + WEATHER_TOOL_JSON + TOOLS_POSTAMBLE +
      "<|im_end|>\n"
      "<|im_start|>assistant\n"
      "Let me check.<|im_end|>\n"
      "<|im_start|>user\n"
      "<tool_response>\n"
      R"({"city":"Tokyo","temperature":25,"conditions":"sunny"})"
      "\n</tool_response><|im_end|>\n"
      "<|im_start|>assistant\n";

  EXPECT_EQ(render(inputs), expected);
}

TEST_F(Qwen3ToolsDynamicTemplateRenderTest, MultipleToolResponses) {
  auto inputs = makeInputs(
      {msg("user", "Weather in Paris and London?"),
       msg("assistant", "Checking."),
       msg("tool", R"({"city":"Paris","temperature":18})"),
       msg("tool", R"({"city":"London","temperature":8})")},
      {weatherTool()});

  std::string expected = "<|im_start|>user\n"
                         "Weather in Paris and London?<|im_end|>\n"
                         "<|im_start|>system\n" +
                         TOOLS_PREAMBLE + "\n" + WEATHER_TOOL_JSON +
                         TOOLS_POSTAMBLE +
                         "<|im_end|>\n"
                         "<|im_start|>assistant\n"
                         "Checking.<|im_end|>\n"
                         "<|im_start|>user\n"
                         "<tool_response>\n"
                         R"({"city":"Paris","temperature":18})"
                         "\n</tool_response>\n"
                         "<tool_response>\n"
                         R"({"city":"London","temperature":8})"
                         "\n</tool_response><|im_end|>\n"
                         "<|im_start|>assistant\n";

  EXPECT_EQ(render(inputs), expected);
}

// Edge case: tools present but no user message. In practice, the outer logic
// (tokenizeChat / processPrompt) should set add_generation_prompt correctly;
// the template's job is to honour the config it receives.
TEST_F(Qwen3ToolsDynamicTemplateRenderTest, NoUserMessagesToolsCompact) {
  auto inputs = makeInputs(
      {msg("system", "You are a helpful assistant.")}, {weatherTool()});

  std::string expected = "<|im_start|>system\n"
                         "You are a helpful assistant.<|im_end|>\n"
                         "<|im_start|>system\n" +
                         TOOLS_PREAMBLE + "\n" + WEATHER_TOOL_JSON +
                         TOOLS_POSTAMBLE +
                         "<|im_end|>\n"
                         "<|im_start|>assistant\n";

  EXPECT_EQ(render(inputs), expected);
}

TEST_F(Qwen3ToolsDynamicTemplateRenderTest, AddGenerationPromptFalse) {
  auto inputs = makeInputs({msg("user", "Hello")}, {}, false);

  std::string expected = "<|im_start|>user\n"
                         "Hello<|im_end|>\n";

  EXPECT_EQ(render(inputs), expected);
}

TEST_F(Qwen3ToolsDynamicTemplateRenderTest, EnableThinkingFalse) {
  auto inputs = makeInputs({msg("user", "Hello")});
  inputs.enable_thinking = false;

  std::string expected = "<|im_start|>user\n"
                         "Hello<|im_end|>\n"
                         "<|im_start|>assistant\n"
                         "<think>\n\n</think>\n\n";

  EXPECT_EQ(render(inputs), expected);
}

TEST_F(Qwen3ToolsDynamicTemplateRenderTest, EnableThinkingTrue) {
  auto inputs = makeInputs({msg("user", "Hello")});
  inputs.enable_thinking = true;

  std::string expected = "<|im_start|>user\n"
                         "Hello<|im_end|>\n"
                         "<|im_start|>assistant\n";

  EXPECT_EQ(render(inputs), expected);
}

TEST_F(Qwen3ToolsDynamicTemplateRenderTest, NoToolsNoToolBlock) {
  auto inputs = makeInputs({msg("user", "Hello")});

  std::string prompt = render(inputs);

  EXPECT_EQ(prompt.find("# Tools"), std::string::npos)
      << "no tools block when tools list is empty";
  EXPECT_EQ(prompt.find("<tools>"), std::string::npos);
}

TEST_F(
    Qwen3ToolsDynamicTemplateRenderTest, AssistantWithThinkTagStripsThinking) {
  auto inputs = makeInputs(
      {msg("user", "Hello"),
       msg("assistant",
           "<think>internal reasoning</think>\n\nHere is my answer."),
       msg("user", "Thanks")},
      {});

  std::string prompt = render(inputs);

  EXPECT_NE(prompt.find("Here is my answer."), std::string::npos);
  EXPECT_EQ(prompt.find("internal reasoning"), std::string::npos)
      << "thinking content should be stripped from assistant messages";
}
