// Model-backed coverage for the chat template's tool grammar reaching the
// sampler, and for it not leaking across requests. All tests GTEST_SKIP when
// the Qwen3 unit-test model is absent (`npm run test:cpp:models`).
#include <chrono>
#include <filesystem>
#include <memory>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include <gtest/gtest.h>

#include "common/common.h"
#include "model-interface/LlamaModel.hpp"
#include "test_common.hpp"
#include "test_internal_peers.hpp"

namespace fs = std::filesystem;

namespace {

constexpr const char* TOOL_PROMPT =
    R"([{"role":"system","content":"You are a helpful assistant. /no_think"},)"
    R"({"type":"function","name":"get_weather","description":"Get the weather for a city",)"
    R"("parameters":{"type":"object","properties":{"city":{"type":"string"},)"
    R"("days":{"type":"integer"}},"required":["city"]}},)"
    R"({"role":"user","content":"What is the weather in Paris for the next 3 days? Use the tool."}])";

constexpr const char* PLAIN_PROMPT =
    R"([{"role":"system","content":"You are a helpful assistant. /no_think"},)"
    R"({"role":"user","content":"Name one colour of the rainbow."}])";

constexpr const char* TWO_TOOLS_PROMPT =
    R"([{"role":"system","content":"You are a helpful assistant. /no_think"},)"
    R"({"type":"function","name":"get_weather","description":"Get the weather for a city",)"
    R"("parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}},)"
    R"({"type":"function","name":"get_time","description":"Get the current time in a city",)"
    R"("parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}},)"
    R"({"role":"user","content":"What time is it in Paris right now? Use a tool."}])";

constexpr const char* COLOUR_SCHEMA =
    R"({"type":"object","properties":{"colour":{"type":"string"}},"required":["colour"]})";

bool hasToolCallBlock(const std::string& text) {
  return text.find("<tool_call>") != std::string::npos;
}

} // namespace

class ToolGrammarModelTest : public ::testing::Test {
protected:
  void SetUp() override {
    using MP = test_common::TestModelPath;
    qwen3Model_ =
        MP("Qwen3-0.6B-Q8_0.gguf",
           "QWEN3_MODEL_PATH",
           MP::OnMissing::Skip,
           "https://huggingface.co/Qwen/Qwen3-0.6B-GGUF");

    config_["ctx_size"] = "4096";
    config_["n_predict"] = "96";
    config_["seed"] = "50";
    config_["temp"] = "0";
    config_["top_p"] = "1";
    // `tools=true` is what turns on the Jinja renderer; without it there is
    // no tool grammar to apply and every test here passes vacuously.
    config_["tools"] = "true";
    config_["device"] = test_common::getTestDevice();
    config_["gpu_layers"] = test_common::getTestGpuLayers();
    config_["backendsDir"] = test_common::getTestBackendsDir().string();
  }

  [[nodiscard]] bool hasQwen3Model() const {
    return qwen3Model_.found() && fs::exists(qwen3Model_.path);
  }

  std::unique_ptr<LlamaModel> createModel() {
    std::unordered_map<std::string, std::string> config = config_;
    auto model = std::make_unique<LlamaModel>(
        std::string(qwen3Model_.path), std::string(), std::move(config));
    model->waitForLoadInitialization();
    if (!model->isLoaded()) {
      throw std::runtime_error("Qwen3 model failed to load");
    }
    return model;
  }

  static LlamaModel::Prompt makePrompt(const char* input) {
    LlamaModel::Prompt prompt;
    prompt.input = input;
    return prompt;
  }

  static const common_params_sampling& sampling(LlamaModel& model) {
    LlmContext* ctx = LlamaModelTestPeer::llmContext(model);
    if (ctx == nullptr) {
      throw std::runtime_error("no single-prompt context");
    }
    return ctx->getParams().sampling;
  }

  test_common::TestModelPath qwen3Model_;
  std::unordered_map<std::string, std::string> config_;
};

// With tools in the prompt the template's grammar must reach the live
// sampling params tagged TOOL_CALLS, and the request must still complete —
// a sampler that rejected the grammar would have thrown.
TEST_F(ToolGrammarModelTest, ToolGrammarAppliedOnToolRequest) {
  if (!hasQwen3Model()) {
    GTEST_SKIP() << qwen3Model_.missingMessage();
  }
  auto model = createModel();
  ASSERT_EQ(LlamaModelTestPeer::scheduler(*model), nullptr)
      << "this test must exercise the long-lived single-prompt context";

  const std::string output = model->processPrompt(makePrompt(TOOL_PROMPT));
  EXPECT_FALSE(output.empty());

  const common_params_sampling& s = sampling(*model);
  EXPECT_EQ(s.grammar.type, COMMON_GRAMMAR_TYPE_TOOL_CALLS);
  EXPECT_FALSE(s.grammar.grammar.empty());
  EXPECT_TRUE(common_grammar_needs_prefill(s.grammar));
  EXPECT_FALSE(s.generation_prompt.empty())
      << "a prefill-needing grammar must carry the generation prompt";
  if (s.grammar_lazy) {
    EXPECT_FALSE(s.grammar_triggers.empty());
  }
}

// Two tools requests in a row on the same context render the same grammar.
// The grammar sampler keeps state across requests and common_sampler_reset()
// does not rewind it, so the second request must get a fresh sampler or it
// generates nothing. Regression for the tool-calling follow-up turn.
TEST_F(ToolGrammarModelTest, ToolGrammarReappliedOnSecondToolRequest) {
  if (!hasQwen3Model()) {
    GTEST_SKIP() << qwen3Model_.missingMessage();
  }
  auto model = createModel();
  ASSERT_EQ(LlamaModelTestPeer::scheduler(*model), nullptr);

  const std::string first = model->processPrompt(makePrompt(TOOL_PROMPT));
  EXPECT_FALSE(first.empty());

  const std::string second = model->processPrompt(makePrompt(TOOL_PROMPT));
  EXPECT_FALSE(second.empty()) << "second tools request generated nothing";
  EXPECT_EQ(sampling(*model).grammar.type, COMMON_GRAMMAR_TYPE_TOOL_CALLS);
}

// The single-prompt context is long-lived and a request with no
// generationParams gets no restore lambda, so the tool grammar written by
// turn 1 must be cleared by turn 2's tokenizeChat, not left to leak.
TEST_F(ToolGrammarModelTest, ToolGrammarDoesNotLeakIntoNextRequest) {
  if (!hasQwen3Model()) {
    GTEST_SKIP() << qwen3Model_.missingMessage();
  }
  auto model = createModel();
  ASSERT_EQ(LlamaModelTestPeer::scheduler(*model), nullptr)
      << "with a scheduler the single-prompt context would never run";

  EXPECT_FALSE(model->processPrompt(makePrompt(TOOL_PROMPT)).empty());
  ASSERT_EQ(sampling(*model).grammar.type, COMMON_GRAMMAR_TYPE_TOOL_CALLS);

  const std::string second = model->processPrompt(makePrompt(PLAIN_PROMPT));
  EXPECT_FALSE(second.empty());
  EXPECT_FALSE(hasToolCallBlock(second)) << second;

  const common_params_sampling& s = sampling(*model);
  EXPECT_TRUE(s.grammar.empty());
  EXPECT_EQ(s.grammar.type, COMMON_GRAMMAR_TYPE_NONE);
  EXPECT_FALSE(s.grammar_lazy);
  EXPECT_TRUE(s.grammar_triggers.empty());
}

// A request without tools must leave the grammar-related sampling fields
// exactly as they were, so tools-free callers see no behaviour change.
TEST_F(ToolGrammarModelTest, NoToolsLeavesSamplingUntouched) {
  if (!hasQwen3Model()) {
    GTEST_SKIP() << qwen3Model_.missingMessage();
  }
  auto model = createModel();
  const common_params_sampling before = sampling(*model);

  EXPECT_FALSE(model->processPrompt(makePrompt(PLAIN_PROMPT)).empty());

  const common_params_sampling& after = sampling(*model);
  EXPECT_EQ(after.grammar.type, before.grammar.type);
  EXPECT_EQ(after.grammar.grammar, before.grammar.grammar);
  EXPECT_EQ(after.grammar_lazy, before.grammar_lazy);
  // By content, not size: both sides are empty on a default-configured model,
  // so a size comparison passes even when the triggers themselves are wrong.
  ASSERT_EQ(after.grammar_triggers.size(), before.grammar_triggers.size());
  for (size_t i = 0; i < after.grammar_triggers.size(); ++i) {
    EXPECT_EQ(after.grammar_triggers[i].type, before.grammar_triggers[i].type);
    EXPECT_EQ(
        after.grammar_triggers[i].value, before.grammar_triggers[i].value);
    EXPECT_EQ(
        after.grammar_triggers[i].token, before.grammar_triggers[i].token);
  }
  EXPECT_EQ(after.preserved_tokens, before.preserved_tokens);
  EXPECT_EQ(after.generation_prompt, before.generation_prompt);
}

// Multimodal twin of the leak test: MtmdLlmContext has its own tokenizeChat
// and must clear the tool grammar on the same rule as the text context.
TEST_F(ToolGrammarModelTest, MtmdToolGrammarDoesNotLeakIntoNextRequest) {
  using MP = test_common::TestModelPath;
  MP qwen35(
      "Qwen3.5-0.8B-Q8_0.gguf",
      "QWEN35_MODEL_PATH",
      MP::OnMissing::Skip,
      "https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF");
  MP mmproj(
      "mmproj-Qwen3.5-0.8B-F16.gguf",
      "QWEN35_MMPROJ_PATH",
      MP::OnMissing::Skip,
      "https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF");
  if (!qwen35.found() || !mmproj.found()) {
    GTEST_SKIP() << qwen35.missingMessage() << "; " << mmproj.missingMessage();
  }

  std::unordered_map<std::string, std::string> config = config_;
  config["ctx_size"] = "8192";
  auto model = std::make_unique<LlamaModel>(
      std::string(qwen35.path), std::string(mmproj.path), std::move(config));
  model->waitForLoadInitialization();
  ASSERT_TRUE(model->isLoaded());
  ASSERT_EQ(LlamaModelTestPeer::scheduler(*model), nullptr);

  EXPECT_FALSE(model->processPrompt(makePrompt(TOOL_PROMPT)).empty());
  EXPECT_EQ(sampling(*model).grammar.type, COMMON_GRAMMAR_TYPE_TOOL_CALLS);

  const std::string second = model->processPrompt(makePrompt(PLAIN_PROMPT));
  EXPECT_FALSE(second.empty());
  EXPECT_FALSE(hasToolCallBlock(second)) << second;
  EXPECT_TRUE(sampling(*model).grammar.empty());
  EXPECT_TRUE(sampling(*model).grammar_triggers.empty());
}

// tool_choice "required": the template emits an eager grammar, so the very
// first sampled tokens are already inside a tool call.
TEST_F(ToolGrammarModelTest, ToolChoiceRequiredForcesToolCall) {
  if (!hasQwen3Model()) {
    GTEST_SKIP() << qwen3Model_.missingMessage();
  }
  auto model = createModel();
  LlamaModel::Prompt prompt = makePrompt(TOOL_PROMPT);
  prompt.generationParams.tool_choice = "required";

  const std::string output = model->processPrompt(prompt);
  EXPECT_TRUE(hasToolCallBlock(output)) << output;
  const common_params_sampling& s = sampling(*model);
  EXPECT_EQ(s.grammar.type, COMMON_GRAMMAR_TYPE_TOOL_CALLS);
  EXPECT_FALSE(s.grammar_lazy);
}

// tool_choice "none" follows llama-server: the tool definitions stay in the
// prompt and only the grammar is switched off. The model may still choose to
// call a tool in free text, so the contract is "no constraint", not "no call".
TEST_F(ToolGrammarModelTest, ToolChoiceNoneAppliesNoGrammar) {
  if (!hasQwen3Model()) {
    GTEST_SKIP() << qwen3Model_.missingMessage();
  }
  auto model = createModel();
  LlamaModel::Prompt prompt = makePrompt(TOOL_PROMPT);
  prompt.generationParams.tool_choice = "none";

  const std::string output = model->processPrompt(prompt);
  EXPECT_FALSE(output.empty());
  EXPECT_EQ(sampling(*model).grammar.type, COMMON_GRAMMAR_TYPE_NONE);
  EXPECT_TRUE(sampling(*model).grammar_triggers.empty());
}

// A function name narrows the render to that tool and requires a call to it.
TEST_F(ToolGrammarModelTest, ToolChoiceNamedFunctionRestrictsTheCall) {
  if (!hasQwen3Model()) {
    GTEST_SKIP() << qwen3Model_.missingMessage();
  }
  auto model = createModel();
  LlamaModel::Prompt prompt = makePrompt(TWO_TOOLS_PROMPT);
  prompt.generationParams.tool_choice = "get_weather"; // not the obvious one

  const std::string output = model->processPrompt(prompt);
  EXPECT_TRUE(hasToolCallBlock(output)) << output;
  EXPECT_NE(output.find("\"get_weather\""), std::string::npos) << output;
  EXPECT_EQ(output.find("\"get_time\""), std::string::npos)
      << "the other tool must not be callable: " << output;
}

TEST_F(ToolGrammarModelTest, ToolChoiceUnknownFunctionIsRejected) {
  if (!hasQwen3Model()) {
    GTEST_SKIP() << qwen3Model_.missingMessage();
  }
  auto model = createModel();
  LlamaModel::Prompt prompt = makePrompt(TOOL_PROMPT);
  prompt.generationParams.tool_choice = "not_declared";
  EXPECT_THROW(model->processPrompt(prompt), qvac_errors::StatusError);

  // The rejection happens in `validateToolChoice`, before
  // `setRenderOverrides` is ever called, so this asserts only that the model
  // is still usable afterwards. It is NOT a test of the override-clearing
  // guard, which no longer sees this failure at all.
  EXPECT_FALSE(model->processPrompt(makePrompt(PLAIN_PROMPT)).empty());
}

// json_schema + tools: the schema wins and the tool grammar is suppressed, so
// the answer is schema-shaped rather than a tool call.
TEST_F(ToolGrammarModelTest, JsonSchemaWithToolsSuppressesToolGrammar) {
  if (!hasQwen3Model()) {
    GTEST_SKIP() << qwen3Model_.missingMessage();
  }
  auto model = createModel();
  LlamaModel::Prompt prompt = makePrompt(TOOL_PROMPT);
  prompt.generationParams.json_schema = COLOUR_SCHEMA;

  const std::string output = model->processPrompt(prompt);
  EXPECT_FALSE(output.empty());
  EXPECT_NE(output.find("\"colour\""), std::string::npos) << output;
  EXPECT_FALSE(hasToolCallBlock(output)) << output;
  EXPECT_EQ(
      test_common::getStatValue(
          model->runtimeStats(), "toolDefinitionsDropped"),
      0)
      << "json_schema with tools must not trip the tools-stripped retry";
}

// json_schema without tools keeps today's behaviour: the answer is JSON that
// matches the schema.
TEST_F(ToolGrammarModelTest, JsonSchemaWithoutToolsStillConstrainsOutput) {
  if (!hasQwen3Model()) {
    GTEST_SKIP() << qwen3Model_.missingMessage();
  }
  auto model = createModel();
  LlamaModel::Prompt prompt = makePrompt(PLAIN_PROMPT);
  prompt.generationParams.json_schema = COLOUR_SCHEMA;

  const std::string output = model->processPrompt(prompt);
  EXPECT_NE(output.find("\"colour\""), std::string::npos) << output;
  EXPECT_FALSE(hasToolCallBlock(output)) << output;
}

// Regression guard for the continuous-batching path: every slot gets a fresh
// driver, so a tool grammar from one request must never reach the next. This
// held before the tool grammar was ever applied and must keep holding.
TEST_F(ToolGrammarModelTest, BatchToolGrammarIsPerRequest) {
  if (!hasQwen3Model()) {
    GTEST_SKIP() << qwen3Model_.missingMessage();
  }
  config_["parallel"] = "2";
  auto model = createModel();
  ASSERT_NE(LlamaModelTestPeer::scheduler(*model), nullptr)
      << "parallel=2 must build the scheduler";

  // Both in one call, so the two are genuinely co-scheduled. Submitting them
  // sequentially exercised only the per-request clear, never the cross-slot
  // isolation this test is named for.
  const auto results = model->processPromptBatch(
      {makePrompt(TOOL_PROMPT), makePrompt(PLAIN_PROMPT)});
  ASSERT_EQ(results.size(), 2u);
  EXPECT_FALSE(results[0].empty());
  EXPECT_FALSE(results[1].empty());
  EXPECT_FALSE(hasToolCallBlock(results[1])) << results[1];
}
