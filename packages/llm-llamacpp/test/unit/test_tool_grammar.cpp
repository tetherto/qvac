// Model-backed coverage for the chat template's tool grammar reaching the
// sampler, and for it not leaking across requests. All tests GTEST_SKIP when
// the Qwen3 unit-test model is absent (`npm run test:cpp:models`).
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <memory>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include <gtest/gtest.h>

#include "common/common.h"
#include "common/sampling.h"
#include "model-interface/LlamaModel.hpp"
#include "model-interface/TextLlmContext.hpp"
#include "test_common.hpp"
#include "test_internal_peers.hpp"
#include "utils/ChatTemplateUtils.hpp"

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

// TOOL_PROMPT and PLAIN_PROMPT without `/no_think`. The reasoning channel has
// to stay ON for the EOS-substitution tests below: the recovery only runs
// while `inside_reasoning` is set, which Qwen3 reaches by generating `<think>`
// as its first token rather than having the template force it open.
constexpr const char* THINKING_TOOL_PROMPT =
    R"([{"role":"system","content":"You are a helpful assistant."},)"
    R"({"type":"function","name":"get_weather","description":"Get the weather for a city",)"
    R"("parameters":{"type":"object","properties":{"city":{"type":"string"},)"
    R"("days":{"type":"integer"}},"required":["city"]}},)"
    R"({"role":"user","content":"What is the weather in Paris for the next 3 days? Use the tool."}])";

constexpr const char* THINKING_PLAIN_PROMPT =
    R"([{"role":"system","content":"You are a helpful assistant."},)"
    R"({"role":"user","content":"Name one colour of the rainbow."}])";

constexpr const char* MEDIA_TOOL_PROMPT =
    R"([{"role":"system","content":"You are a helpful assistant. /no_think"},)"
    R"({"type":"function","name":"get_weather","description":"Get the weather for a city",)"
    R"("parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}},)"
    R"({"role":"user","type":"media","content":""},)"
    R"({"role":"user","content":"Describe this image in one sentence."}])";

constexpr const char* THINK_CLOSE_TAG = "</think>";

bool hasToolCallBlock(const std::string& text) {
  return text.find("<tool_call>") != std::string::npos;
}

/// The first `<tool_call>` block, so a name assertion reads only the call and
/// not any prose around it. Empty when the output carries no call.
std::string firstToolCallBlock(const std::string& text) {
  const size_t open = text.find("<tool_call>");
  if (open == std::string::npos) {
    return "";
  }
  const size_t close = text.find("</tool_call>", open);
  return text.substr(
      open, close == std::string::npos ? std::string::npos : close - open);
}

std::vector<uint8_t> readBinaryFile(const fs::path& path) {
  std::ifstream stream(path, std::ios::binary);
  return {
      std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}

// Mirrors test_mtmd_llm_context.cpp: the image resolves relative to the
// package when the suite runs from there, and relative to the test binary
// when ctest runs it from the build tree.
fs::path multimodalTestImagePath() {
  const fs::path packageRelative = "media/fruitPlate.png";
  if (fs::exists(packageRelative)) {
    return packageRelative;
  }
#ifdef TEST_BINARY_DIR
  const fs::path binaryRelative = fs::path(TEST_BINARY_DIR) / ".." / ".." /
                                  ".." / "media" / "fruitPlate.png";
  if (fs::exists(binaryRelative)) {
    return binaryRelative.lexically_normal();
  }
#endif
  return "packages/llm-llamacpp/media/fruitPlate.png";
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

// A rejected `tool_choice` must not cost the NEXT request its turn. Media is
// staged on the long-lived multimodal context and drained only by
// `tokenizeChat`, so validating after the load would leave this request's
// bitmap behind — and fabric then refuses the following request outright,
// because its prompt carries fewer markers than the context has bitmaps.
//
// The bitmap count is read through a test peer rather than inferred from
// generated text: a stale bitmap makes the next request *throw*, so an
// output-only assertion would confirm the symptom while saying nothing about
// whether the state was actually clean.
TEST_F(ToolGrammarModelTest, ToolChoiceRejectionLeavesNoMediaBehind) {
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
  const fs::path imagePath = multimodalTestImagePath();
  if (!fs::exists(imagePath)) {
    GTEST_SKIP() << "multimodal test image not found at " << imagePath;
  }

  std::unordered_map<std::string, std::string> config = config_;
  config["ctx_size"] = "8192";
  auto model = std::make_unique<LlamaModel>(
      std::string(qwen35.path), std::string(mmproj.path), std::move(config));
  model->waitForLoadInitialization();
  ASSERT_TRUE(model->isLoaded());

  auto* mtmdContext =
      dynamic_cast<MtmdLlmContext*>(LlamaModelTestPeer::llmContext(*model));
  ASSERT_NE(mtmdContext, nullptr) << "an mmproj model must build an Mtmd "
                                     "context for the peer to inspect";
  ASSERT_EQ(MtmdLlmContextTestPeer::loadedMediaCount(*mtmdContext), 0u)
      << "nothing staged before the first request";

  LlamaModel::Prompt rejected = makePrompt(MEDIA_TOOL_PROMPT);
  rejected.media.push_back(readBinaryFile(imagePath));
  rejected.generationParams.tool_choice = "notDeclared";
  EXPECT_THROW(model->processPrompt(rejected), qvac_errors::StatusError);

  EXPECT_EQ(MtmdLlmContextTestPeer::loadedMediaCount(*mtmdContext), 0u)
      << "the rejected request's bitmap outlived it";

  // The consequence, stated separately: the next multimodal request still
  // works. Pre-fix this threw `EncoderFailed` from `mtmd_tokenize`, because
  // two bitmaps arrived for one marker.
  LlamaModel::Prompt accepted = makePrompt(MEDIA_TOOL_PROMPT);
  accepted.media.push_back(readBinaryFile(imagePath));
  EXPECT_FALSE(model->processPrompt(accepted).empty());
  EXPECT_EQ(MtmdLlmContextTestPeer::loadedMediaCount(*mtmdContext), 0u)
      << "a successful request drains its own media";
}

// An EOS sampled inside the reasoning channel is replaced by the cached
// `</think>` token, and that substituted close is handed to the sampler so
// fabric's reasoning-budget matcher leaves COUNTING. Without the accept the
// matcher stays in COUNTING for the rest of the request, `grammar_should_apply`
// returns false for a lazy grammar, and the tool grammar is silently disarmed
// on the default `tool_choice: "auto"` — the constraint switching itself off
// with no error anywhere.
//
// The EOS is forced rather than waited for: a 0.6B model emits a premature EOS
// inside `<think>` only occasionally, which is no basis for a regression test.
TEST_F(
    ToolGrammarModelTest,
    ReasoningEOSInsideThinkingIsReplacedAndGenerationContinues) {
  if (!hasQwen3Model()) {
    GTEST_SKIP() << qwen3Model_.missingMessage();
  }
  // Load-time budget, not a per-request one: it must survive the
  // generation-params restore so the assertions below can still see the
  // sampler the accept was gated on.
  config_["reasoning-budget"] = "64";
  // The fixture's 96 does not reach the call: after the synthetic close the
  // model spends what is left restating the request in prose and runs out
  // mid-sentence. 512 lets it finish and emit the call, which is what makes
  // the end-to-end assertion at the bottom possible.
  config_["n_predict"] = "512";
  auto model = createModel();
  ASSERT_EQ(LlamaModelTestPeer::scheduler(*model), nullptr)
      << "this test must exercise the long-lived single-prompt context";

  auto* textContext =
      dynamic_cast<TextLlmContext*>(LlamaModelTestPeer::llmContext(*model));
  ASSERT_NE(textContext, nullptr);
  const llama_token eos =
      llama_vocab_eos(llama_model_get_vocab(textContext->getModel()));
  ASSERT_NE(eos, LLAMA_TOKEN_NULL);

  // Armed before the request: prefill samples nothing, and the seam waits for
  // the reasoning block to open, so this lands on the first token the model
  // generates inside `<think>`.
  textContext->forceNextSampledTokenInsideReasoningForTesting(eos);

  // The assertion with teeth, and it has to be taken mid-generation. Nothing
  // above depends on the substituted close reaching the *sampler* — the
  // visible recovery happens either way — so a purely post-hoc test would
  // pass on the very bug this exists for. And the state cannot be read after
  // the request either: end-of-generation compaction resets the sampler.
  //
  // `common_sampler_reasoning_budget_force` returns true only from
  // REASONING_BUDGET_COUNTING (fabric common/reasoning-budget.cpp:289-308),
  // which is exactly the state that makes `grammar_should_apply` disarm a
  // lazy tool grammar for the rest of the request. Probed on the first piece
  // *after* the close, because the close is streamed before the accept runs.
  // On the passing path the call is a no-op returning false; it only mutates
  // the sampler when the assertion is already going to fail.
  std::string streamed;
  bool closeSeen = false;
  bool probed = false;
  bool budgetStillCounting = false;
  LlamaModel::Prompt prompt = makePrompt(THINKING_TOOL_PROMPT);
  prompt.outputCallback = [&](const std::string& piece) {
    streamed += piece;
    if (closeSeen && !probed) {
      probed = true;
      budgetStillCounting = common_sampler_reasoning_budget_force(
          textContext->samplerForTesting());
    }
    closeSeen =
        closeSeen || streamed.find(THINK_CLOSE_TAG) != std::string::npos;
  };
  model->processPrompt(prompt);
  const std::string& output = streamed;

  ASSERT_FALSE(output.empty()) << "the request must not end on the EOS";
  const size_t close = output.find(THINK_CLOSE_TAG);
  ASSERT_NE(close, std::string::npos)
      << "EOS must be replaced by the cached close tag: " << output;
  EXPECT_GT(output.size(), close + std::string(THINK_CLOSE_TAG).size())
      << "generation must continue past the synthetic close (EOG is banned "
         "for exactly one token afterwards): "
      << output;

  ASSERT_TRUE(probed)
      << "nothing was streamed after the close, so the sampler state was "
         "never sampled: "
      << output;
  EXPECT_FALSE(budgetStillCounting)
      << "the reasoning-budget matcher was still COUNTING after the close, so "
         "the substituted close never reached the sampler and a lazy tool "
         "grammar would stay disarmed for the rest of the request";

  // The gate the accept is conditioned on. Asserted after the fact rather
  // than assumed: if a template or fabric change made the tool grammar eager,
  // or stopped building the reasoning-budget sampler, the branch above would
  // still run but would no longer accept anything — and this test would pass
  // while covering nothing.
  const common_params_sampling& s = sampling(*model);
  EXPECT_EQ(s.grammar.type, COMMON_GRAMMAR_TYPE_TOOL_CALLS);
  EXPECT_TRUE(s.grammar_lazy)
      << "an eager grammar cannot reach the substitution branch at all";
  EXPECT_TRUE(
      qvac_lib_inference_addon_llama::utils::reasoningBudgetSamplerBuilt(s))
      << "without a budget sampler the accept is skipped as unsafe";

  // And the end of the contract, which the sampler probe alone does not
  // reach: the request goes on to arm the lazy grammar on `<tool_call>` and
  // emit a call the grammar admits. A recovered request that could no longer
  // be constrained would still satisfy every assertion above.
  const std::string call = firstToolCallBlock(output);
  ASSERT_FALSE(call.empty())
      << "no tool call after the recovery, so the lazy grammar was never "
         "armed: "
      << output;
  EXPECT_NE(call.find("get_weather"), std::string::npos)
      << "the call must name the one declared tool: " << call;
  EXPECT_NE(call.find("\"city\""), std::string::npos)
      << "the grammar admits only the declared argument shape, whose one "
         "required property is `city`: "
      << call;
}

// `onLogitsReady` reaches the substitution through its own inline branch when
// there is no inline decode batch, so the single-prompt regression above never
// executes the scheduler's copy. Only the tools slot is forced to EOS; its
// co-scheduled sibling generates normally, which is what makes the second
// assertion meaningful — a throw out of the substituted token's
// `common_sampler_accept` escapes to the scheduler's step handler and fails
// every request in the batch, not just the one that caused it.
TEST_F(
    ToolGrammarModelTest, ReasoningEOSRecoveryDoesNotFailCoScheduledSibling) {
  if (!hasQwen3Model()) {
    GTEST_SKIP() << qwen3Model_.missingMessage();
  }
  config_["parallel"] = "2";
  config_["reasoning-budget"] = "64";
  // See the single-prompt twin: the recovered slot needs room to finish its
  // prose and reach the call.
  config_["n_predict"] = "512";
  auto model = createModel();
  auto* scheduler = LlamaModelTestPeer::scheduler(*model);
  ASSERT_NE(scheduler, nullptr) << "parallel=2 must build the scheduler";

  auto* loadedContext = LlamaModelTestPeer::llmContext(*model);
  ASSERT_NE(loadedContext, nullptr);
  const llama_token eos =
      llama_vocab_eos(llama_model_get_vocab(loadedContext->getModel()));
  ASSERT_NE(eos, LLAMA_TOKEN_NULL);

  // The factory is the only seam that reaches a slot driver in time: it runs
  // once per admission, and `slots_[seqId]` is not populated until after it
  // returns. Armed for seq 0 alone — `processPromptBatch` submits in order and
  // the first submission takes the first free seq id — so the recorded pointer
  // belongs to the tools item, and the sibling stays untouched.
  TextLlmContext* toolsDriver = nullptr;
  qvac_lib_inference_addon_llama::batching::DriverFactory original =
      ContinuousBatchSchedulerTestPeer::driverFactory(*scheduler);
  ContinuousBatchSchedulerTestPeer::setDriverFactory(
      *scheduler,
      [original, eos, &toolsDriver](
          const common_params& params, uint32_t seqId, llama_pos ceiling) {
        std::unique_ptr<SequenceDriver> driver =
            original(params, seqId, ceiling);
        auto* text = dynamic_cast<TextLlmContext*>(driver.get());
        if (text != nullptr && seqId == 0) {
          toolsDriver = text;
          text->forceNextSampledTokenInsideReasoningForTesting(eos);
        }
        return driver;
      });

  // Same mid-generation probe as the single-prompt test, against this slot's
  // own driver: the scheduler's accept has to advance this sequence's
  // reasoning-budget matcher off COUNTING, and the state is gone by the time
  // the batch returns.
  std::string streamed;
  bool closeSeen = false;
  bool probed = false;
  bool budgetStillCounting = false;
  LlamaModel::Prompt toolsPrompt = makePrompt(THINKING_TOOL_PROMPT);
  toolsPrompt.outputCallback = [&](const std::string& piece) {
    streamed += piece;
    if (closeSeen && !probed && toolsDriver != nullptr) {
      probed = true;
      budgetStillCounting = common_sampler_reasoning_budget_force(
          toolsDriver->samplerForTesting());
    }
    closeSeen =
        closeSeen || streamed.find(THINK_CLOSE_TAG) != std::string::npos;
  };

  const auto results = model->processPromptBatch(
      {toolsPrompt, makePrompt(THINKING_PLAIN_PROMPT)});
  ASSERT_EQ(results.size(), 2u);
  ASSERT_NE(toolsDriver, nullptr) << "seq 0's driver was never built";
  EXPECT_FALSE(streamed.empty()) << "the tools slot must recover from EOS";
  EXPECT_NE(streamed.find(THINK_CLOSE_TAG), std::string::npos)
      << "the tools slot's EOS must be replaced by the close tag: " << streamed;
  EXPECT_FALSE(results[1].empty())
      << "the sibling must survive the tools slot's grammar processing";

  ASSERT_TRUE(probed) << "nothing was streamed after the close: " << streamed;
  EXPECT_FALSE(budgetStillCounting)
      << "this slot's reasoning-budget matcher was still COUNTING after the "
         "close, so the substituted close never reached its sampler";

  // Same end-of-contract assertion as the single-prompt twin: the recovered
  // slot must go on to arm its lazy grammar and complete a call the grammar
  // admits, while its sibling is still running.
  const std::string call = firstToolCallBlock(streamed);
  ASSERT_FALSE(call.empty())
      << "the recovered slot never entered a tool call, so its lazy grammar "
         "was never armed: "
      << streamed;
  EXPECT_NE(call.find("get_weather"), std::string::npos)
      << "the call must name the one declared tool: " << call;
  EXPECT_NE(call.find("\"city\""), std::string::npos)
      << "the grammar admits only the declared argument shape: " << call;
}

// `BatchToolGrammarIsPerRequest` above proves a tool grammar does not cross
// slots. This proves the narrower thing per-request `tool_choice` adds: three
// co-scheduled slots, three different choices, each honoured on its own slot
// only. `required` and the named choice both resolve to an eager grammar, so
// the two are distinguishable only by *which* tool the call names — which is
// why the prompt declares two.
TEST_F(ToolGrammarModelTest, BatchToolChoiceIsHonouredPerSlot) {
  if (!hasQwen3Model()) {
    GTEST_SKIP() << qwen3Model_.missingMessage();
  }
  config_["parallel"] = "3";
  config_["ctx_size"] = "8192";
  config_["n_predict"] = "256";
  auto model = createModel();
  ASSERT_NE(LlamaModelTestPeer::scheduler(*model), nullptr)
      << "parallel=3 must build the scheduler";

  // `reasoning_budget: 0` on the two constrained items for the reason recorded
  // in tool-calling.test.js: a named choice resolves to `required`, whose eager
  // grammar permits an arbitrarily long `<think>` prefix, and the whole
  // n_predict budget can be spent inside it before the call is reached.
  LlamaModel::Prompt required = makePrompt(TWO_TOOLS_PROMPT);
  required.generationParams.tool_choice = "required";
  required.generationParams.reasoning_budget = 0;

  // Deliberately the tool the prompt does *not* ask for: TWO_TOOLS_PROMPT asks
  // the time, so a slot that ignored its choice would call `get_time` and the
  // assertion below would pass for the wrong reason.
  LlamaModel::Prompt named = makePrompt(TWO_TOOLS_PROMPT);
  named.generationParams.tool_choice = "get_weather";
  named.generationParams.reasoning_budget = 0;

  LlamaModel::Prompt none = makePrompt(TWO_TOOLS_PROMPT);
  none.generationParams.tool_choice = "none";

  // One call, so all three are genuinely in flight together rather than
  // exercising only the per-request clear.
  const auto results = model->processPromptBatch({required, named, none});
  ASSERT_EQ(results.size(), 3u);

  EXPECT_TRUE(hasToolCallBlock(results[0]))
      << "required must force a call on its own slot: " << results[0];

  const std::string namedCall = firstToolCallBlock(results[1]);
  ASSERT_FALSE(namedCall.empty())
      << "a named choice must force a call: " << results[1];
  EXPECT_NE(namedCall.find("get_weather"), std::string::npos)
      << "the named slot must call the tool its own choice names, overriding "
         "what the prompt asks for: "
      << namedCall;
  EXPECT_EQ(namedCall.find("get_time"), std::string::npos)
      << "the named slot must not reach the tool the prompt asks for, which "
         "its co-scheduled siblings left unconstrained: "
      << namedCall;

  EXPECT_FALSE(results[2].empty())
      << "the none slot must complete rather than inherit a peer's grammar";

  // Second wave over the now-freed sequence ids. This cannot fail today —
  // `submitLocked` builds a fresh `SequenceDriver` per admission, so there is
  // no object for a stale choice to survive in — and it is here to pin that
  // lifecycle rather than to catch a live bug: driver pooling or a reused slot
  // cache would break it first.
  //
  // Every transition below has to be *discriminating*: the assertion must fail
  // if the previous wave's grammar survived. That rules out landing on the tool
  // the prompt already asks for, because an unconstrained or stale-`required`
  // slot reaches `get_time` on its own and the assertion would pass without the
  // new choice being honoured at all.
  //
  //   slot 0  required -> named get_weather : a surviving `required` permits
  //           both tools, and the prompt pulls it to `get_time`, so only a
  //           fresh named grammar produces `get_weather`.
  //   slot 1  named get_weather -> named get_time : two named grammars, each
  //           of which hard-excludes the other's tool. Deterministic in both
  //           directions regardless of what the model would have preferred.
  LlamaModel::Prompt reusedRequiredSlot = makePrompt(TWO_TOOLS_PROMPT);
  reusedRequiredSlot.generationParams.tool_choice = "get_weather";
  reusedRequiredSlot.generationParams.reasoning_budget = 0;
  LlamaModel::Prompt reusedNamedSlot = makePrompt(TWO_TOOLS_PROMPT);
  reusedNamedSlot.generationParams.tool_choice = "get_time";
  reusedNamedSlot.generationParams.reasoning_budget = 0;

  const auto second =
      model->processPromptBatch({reusedRequiredSlot, reusedNamedSlot, none});
  ASSERT_EQ(second.size(), 3u);

  // Slot 0 carried `required` and now carries a name for the tool the prompt
  // does not ask for. A surviving `required` grammar would call `get_time`.
  const std::string wasRequired = firstToolCallBlock(second[0]);
  ASSERT_FALSE(wasRequired.empty())
      << "the reused slot must honour its new named choice: " << second[0];
  EXPECT_NE(wasRequired.find("get_weather"), std::string::npos)
      << "the slot that carried `required` did not honour its new name; a "
         "stale eager grammar would have reached the tool the prompt asks "
         "for: "
      << wasRequired;
  EXPECT_EQ(wasRequired.find("get_time"), std::string::npos)
      << "the reused slot reached a tool its new choice excludes: "
      << wasRequired;

  // Slot 1 goes named -> named. A surviving `get_weather` grammar cannot emit
  // `get_time`, and a fresh `get_time` grammar cannot emit `get_weather`, so
  // this discriminates whichever way the model would have leaned.
  const std::string wasNamed = firstToolCallBlock(second[1]);
  ASSERT_FALSE(wasNamed.empty())
      << "the reused slot must honour its new named choice: " << second[1];
  EXPECT_NE(wasNamed.find("get_time"), std::string::npos)
      << "the slot that carried `get_weather` did not move to its new name: "
      << wasNamed;
  EXPECT_EQ(wasNamed.find("get_weather"), std::string::npos)
      << "the previous wave's named grammar survived into the reused slot: "
      << wasNamed;

  // No output assertion for the `none` slot, deliberately. `tool_choice:
  // "none"` drops the grammar but leaves the definitions in the prompt, so the
  // model may still emit a call — `ToolChoiceNoneAppliesNoGrammar` asserts on
  // the sampler for exactly that reason. Asserting the absence of a call here
  // would be flaky rather than discriminating; there is no deterministic
  // negative signal available for a `none` slot.
  EXPECT_FALSE(second[2].empty())
      << "the none slot must complete rather than inherit a peer's grammar";
}

// A rejected `tool_choice` must not cost the caller its warm cache. The throw
// sits outside `processPromptImpl`'s try, whose catch-all runs
// `resetAndInvalidateActiveCache()`, so this guards an ordering property
// rather than repairing one — it fails the moment validation is moved inside
// that try, which is exactly the change someone would make without knowing
// why the call sits where it does.
//
// Scope: the cache *session* is resolved before this point, because
// `resolveChatAndTools` calls `handleCache` itself. What is asserted here is
// that the last known-good checkpoint survives on disk and in memory.
TEST_F(ToolGrammarModelTest, ToolChoiceRejectionPreservesTheCacheCheckpoint) {
  if (!hasQwen3Model()) {
    GTEST_SKIP() << qwen3Model_.missingMessage();
  }
  const fs::path cacheDir = "tool_choice_cache_dir";
  fs::remove_all(cacheDir);
  fs::create_directories(cacheDir);
  const std::string cacheKey = (cacheDir / "session.bin").string();

  auto model = createModel();

  LlamaModel::Prompt primed = makePrompt(TOOL_PROMPT);
  primed.cacheKey = cacheKey;
  primed.saveCacheToDisk = true;
  EXPECT_FALSE(model->processPrompt(primed).empty());
  ASSERT_TRUE(fs::exists(cacheKey)) << "the checkpoint must be on disk first";
  const auto checkpointSize = fs::file_size(cacheKey);
  const auto checkpointWrite = fs::last_write_time(cacheKey);

  auto* mem = llama_get_memory(model->getContext());
  ASSERT_NE(mem, nullptr);
  const llama_pos primedNPast = llama_memory_seq_pos_max(mem, 0) + 1;
  ASSERT_GT(primedNPast, 0);

  LlamaModel::Prompt rejected = makePrompt(TOOL_PROMPT);
  rejected.cacheKey = cacheKey;
  rejected.saveCacheToDisk = true;
  rejected.generationParams.tool_choice = "notDeclared";
  EXPECT_THROW(model->processPrompt(rejected), qvac_errors::StatusError);

  EXPECT_EQ(fs::file_size(cacheKey), checkpointSize)
      << "the failed request overwrote the on-disk checkpoint";
  EXPECT_TRUE(fs::last_write_time(cacheKey) == checkpointWrite)
      << "the failed request rewrote the on-disk checkpoint";
  EXPECT_EQ(llama_memory_seq_pos_max(mem, 0) + 1, primedNPast)
      << "the failed request advanced or wiped the live cursor, so it ran "
         "either the eval or the catch-all's resetAndInvalidateActiveCache()";

  LlamaModel::Prompt followUp = makePrompt(TOOL_PROMPT);
  followUp.cacheKey = cacheKey;
  followUp.saveCacheToDisk = true;
  EXPECT_FALSE(model->processPrompt(followUp).empty())
      << "the key must still be usable after the rejection";
  EXPECT_GT(test_common::getStatValue(model->runtimeStats(), "CacheTokens"), 0)
      << "the follow-up re-prefilled from empty instead of the checkpoint";

  // The other half, and a genuinely different path: everything above runs
  // against an already-active session, where `handleCache` short-circuits on
  // `sessionPath_ == cacheKey`. A checkpoint restored from disk goes through
  // `loadCache` instead — a fresh model on the same key. Same rejection, same
  // guarantee.
  const auto persistedSize = fs::file_size(cacheKey);
  const auto persistedWrite = fs::last_write_time(cacheKey);
  auto reloaded = createModel();

  LlamaModel::Prompt rejectedAfterLoad = makePrompt(TOOL_PROMPT);
  rejectedAfterLoad.cacheKey = cacheKey;
  rejectedAfterLoad.saveCacheToDisk = true;
  rejectedAfterLoad.generationParams.tool_choice = "notDeclared";
  EXPECT_THROW(
      reloaded->processPrompt(rejectedAfterLoad), qvac_errors::StatusError);

  EXPECT_EQ(fs::file_size(cacheKey), persistedSize)
      << "the rejection overwrote a checkpoint it had only loaded";
  EXPECT_TRUE(fs::last_write_time(cacheKey) == persistedWrite)
      << "the rejection rewrote a checkpoint it had only loaded";

  LlamaModel::Prompt loadedFollowUp = makePrompt(TOOL_PROMPT);
  loadedFollowUp.cacheKey = cacheKey;
  loadedFollowUp.saveCacheToDisk = true;
  EXPECT_FALSE(reloaded->processPrompt(loadedFollowUp).empty())
      << "a checkpoint loaded from disk must survive the rejection too";
  EXPECT_GT(
      test_common::getStatValue(reloaded->runtimeStats(), "CacheTokens"), 0)
      << "the reloaded follow-up re-prefilled from empty";

  fs::remove_all(cacheDir);
}

// Moving `validateToolChoice` ahead of the media load also moved it ahead of
// `processPromptImpl`'s no-messages early return, which changes what an empty
// prompt carrying a demanding `tool_choice` does: it used to return "" in
// silence, and now it reports the contradiction. That is the documented
// contract — "`required` or a function name without tools throws" — which the
// early return had been quietly exempting itself from. Pinned because it is a
// behaviour change no reviewer asked for, so it should not be able to drift
// back unnoticed.
TEST_F(ToolGrammarModelTest, DemandingToolChoiceOnAnEmptyPromptIsRejected) {
  if (!hasQwen3Model()) {
    GTEST_SKIP() << qwen3Model_.missingMessage();
  }
  auto model = createModel();

  for (const char* choice : {"required", "get_weather"}) {
    LlamaModel::Prompt empty = makePrompt("[]");
    empty.generationParams.tool_choice = choice;
    EXPECT_THROW(model->processPrompt(empty), qvac_errors::StatusError)
        << "tool_choice " << choice << " cannot be honoured by an empty prompt";
  }

  // Unchanged for the choices an empty prompt can satisfy: "auto" and "none"
  // ask for nothing, so the early return still applies.
  for (const char* choice : {"auto", "none"}) {
    LlamaModel::Prompt empty = makePrompt("[]");
    empty.generationParams.tool_choice = choice;
    EXPECT_NO_THROW({
      EXPECT_TRUE(model->processPrompt(empty).empty())
          << "tool_choice " << choice << " must still return early";
    });
  }

  // And with no choice at all, which is the case `LlamaModelTest.EmptyPrompt`
  // already covers on the other side of this boundary.
  EXPECT_NO_THROW(EXPECT_TRUE(model->processPrompt(makePrompt("[]")).empty()));
}

// The other half of the media-leak story, and the half `validateToolChoice`
// cannot cover. Media is staged before `tokenizeChat`, which drains it, so
// every way of leaving this request that skips the drain leaks a bitmap —
// `requireSampler()` and `requireToolChoiceHonoured()` inside `tokenizeChat`
// ahead of `mtmd_tokenize`, a throw out of `applyGenerationParams`, and the
// no-messages early return. `resetState` does not touch `bitmaps_`, so the
// catch-all does not clean up either.
//
// `requireToolChoiceHonoured` is the reachable one: with Jinja off the legacy
// renderer silently ignores the tool definitions, so `toolDefinitionsDropped`
// is true and a `"required"` choice cannot be honoured. Note the missing
// `tools=true` below, which is what turns Jinja off.
TEST_F(ToolGrammarModelTest, PreDrainThrowLeavesNoMediaBehind) {
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
  const fs::path imagePath = multimodalTestImagePath();
  if (!fs::exists(imagePath)) {
    GTEST_SKIP() << "multimodal test image not found at " << imagePath;
  }

  std::unordered_map<std::string, std::string> config = config_;
  config["ctx_size"] = "8192";
  auto model = std::make_unique<LlamaModel>(
      std::string(qwen35.path), std::string(mmproj.path), std::move(config));
  model->waitForLoadInitialization();
  ASSERT_TRUE(model->isLoaded());

  auto* mtmdContext =
      dynamic_cast<MtmdLlmContext*>(LlamaModelTestPeer::llmContext(*model));
  ASSERT_NE(mtmdContext, nullptr);

  // An unparseable per-request grammar: `applyGenerationParams` rejects it via
  // `common_sampler_init` after `resolveChatAndTools` has staged the bitmap and
  // before `tokenizeChat` is entered. One guard covers this and the throws
  // inside `tokenizeChat`, so exercising the cheap one proves the mechanism;
  // the expensive ones need a template that rejects tool definitions, which no
  // model in the unit-test set ships.
  LlamaModel::Prompt rejected = makePrompt(MEDIA_TOOL_PROMPT);
  rejected.media.push_back(readBinaryFile(imagePath));
  rejected.generationParams.grammar = "root ::= ((((";
  // `EXPECT_ANY_THROW`, not `EXPECT_THROW(..., StatusError)`: on this path the
  // GBNF parse failure escapes as fabric's own `std::runtime_error("failed to
  // parse grammar")` rather than a mapped `StatusError`, unlike the batch
  // path's `submitLocked`, which maps it. Not this test's subject — what
  // matters here is only that the request left by *some* throw.
  EXPECT_ANY_THROW(model->processPrompt(rejected));

  EXPECT_EQ(MtmdLlmContextTestPeer::loadedMediaCount(*mtmdContext), 0u)
      << "a throw between staging and the tokenizeChat drain left the bitmap "
         "behind";

  // The consequence: without the guard the next image request dies in
  // `mtmd_tokenize` with two bitmaps for one marker.
  LlamaModel::Prompt accepted = makePrompt(MEDIA_TOOL_PROMPT);
  accepted.media.push_back(readBinaryFile(imagePath));
  EXPECT_FALSE(model->processPrompt(accepted).empty());
  EXPECT_EQ(MtmdLlmContextTestPeer::loadedMediaCount(*mtmdContext), 0u);
}

// Multimodal twin of
// `ReasoningEOSInsideThinkingIsReplacedAndGenerationContinues`. The two
// contexts duplicate the EOS-substitution recovery rather than sharing it, so a
// divergence between them is precisely what a text-only test cannot see.
// Single-prompt path: `MtmdLlmContext::generateResponse` samples its own
// tokens, separately from `onLogitsReady`.
TEST_F(ToolGrammarModelTest, MtmdReasoningEOSInsideThinkingIsReplaced) {
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
  config["reasoning-budget"] = "64";
  auto model = std::make_unique<LlamaModel>(
      std::string(qwen35.path), std::string(mmproj.path), std::move(config));
  model->waitForLoadInitialization();
  ASSERT_TRUE(model->isLoaded());
  ASSERT_EQ(LlamaModelTestPeer::scheduler(*model), nullptr)
      << "this test must exercise the single-prompt path";

  auto* mtmdContext =
      dynamic_cast<MtmdLlmContext*>(LlamaModelTestPeer::llmContext(*model));
  ASSERT_NE(mtmdContext, nullptr);
  const llama_token eos =
      llama_vocab_eos(llama_model_get_vocab(mtmdContext->getModel()));
  ASSERT_NE(eos, LLAMA_TOKEN_NULL);

  mtmdContext->forceNextSampledTokenInsideReasoningForTesting(eos);

  // Probed on the piece that CARRIES the close, not the one after it, and the
  // difference is a real divergence between the two contexts rather than a
  // detail of this test: `MtmdLlmContext` accepts the substituted token before
  // streaming it, where `TextLlmContext::handleReasoningEOS` streams first and
  // accepts after. Probing "the piece after the close" — correct for the text
  // twin — never fires here, because this path also `break`s out of generation
  // at the close instead of banning EOG for one token and continuing.
  std::string streamed;
  bool probed = false;
  bool budgetStillCounting = false;
  LlamaModel::Prompt prompt = makePrompt(THINKING_TOOL_PROMPT);
  prompt.outputCallback = [&](const std::string& piece) {
    streamed += piece;
    if (!probed && streamed.find(THINK_CLOSE_TAG) != std::string::npos) {
      probed = true;
      budgetStillCounting = common_sampler_reasoning_budget_force(
          mtmdContext->samplerForTesting());
    }
  };
  model->processPrompt(prompt);

  ASSERT_NE(streamed.find(THINK_CLOSE_TAG), std::string::npos)
      << "EOS must be replaced by the cached close tag: " << streamed;

  ASSERT_TRUE(probed) << "the close was never streamed: " << streamed;
  EXPECT_FALSE(budgetStillCounting)
      << "the multimodal context's reasoning-budget matcher was still "
         "COUNTING after the close, so its substituted close never reached "
         "its sampler";
}

// And the multimodal scheduler path, `MtmdLlmContext::onLogitsReady`. Nothing
// in this suite had run a multimodal model under the scheduler before, though
// nothing prevented it: `isMultiBatchActivated` is `llama_n_seq_max(ctx) > 1`
// with no multimodal exclusion, so `buildDriverFactory` hands out
// `MtmdLlmContext` drivers whenever an mmproj model is loaded with parallel
// >= 2. The first assertion below is that harness fact.
TEST_F(ToolGrammarModelTest, MtmdBatchReasoningEOSRecoveryKeepsSlotAlive) {
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
  config["parallel"] = "2";
  config["reasoning-budget"] = "64";
  auto model = std::make_unique<LlamaModel>(
      std::string(qwen35.path), std::string(mmproj.path), std::move(config));
  model->waitForLoadInitialization();
  ASSERT_TRUE(model->isLoaded());
  auto* scheduler = LlamaModelTestPeer::scheduler(*model);
  ASSERT_NE(scheduler, nullptr)
      << "a multimodal model at parallel=2 must still build the scheduler";

  auto* loadedContext = LlamaModelTestPeer::llmContext(*model);
  ASSERT_NE(loadedContext, nullptr);
  const llama_token eos =
      llama_vocab_eos(llama_model_get_vocab(loadedContext->getModel()));
  ASSERT_NE(eos, LLAMA_TOKEN_NULL);

  MtmdLlmContext* toolsDriver = nullptr;
  qvac_lib_inference_addon_llama::batching::DriverFactory original =
      ContinuousBatchSchedulerTestPeer::driverFactory(*scheduler);
  ContinuousBatchSchedulerTestPeer::setDriverFactory(
      *scheduler,
      [original, eos, &toolsDriver](
          const common_params& params, uint32_t seqId, llama_pos ceiling) {
        std::unique_ptr<SequenceDriver> driver =
            original(params, seqId, ceiling);
        auto* mtmd = dynamic_cast<MtmdLlmContext*>(driver.get());
        if (mtmd != nullptr && seqId == 0) {
          toolsDriver = mtmd;
          mtmd->forceNextSampledTokenInsideReasoningForTesting(eos);
        }
        return driver;
      });

  std::string streamed;
  bool closeSeen = false;
  bool probed = false;
  bool budgetStillCounting = false;
  LlamaModel::Prompt toolsPrompt = makePrompt(THINKING_TOOL_PROMPT);
  toolsPrompt.outputCallback = [&](const std::string& piece) {
    streamed += piece;
    if (closeSeen && !probed && toolsDriver != nullptr) {
      probed = true;
      budgetStillCounting = common_sampler_reasoning_budget_force(
          toolsDriver->samplerForTesting());
    }
    closeSeen =
        closeSeen || streamed.find(THINK_CLOSE_TAG) != std::string::npos;
  };

  const auto results = model->processPromptBatch(
      {toolsPrompt, makePrompt(THINKING_PLAIN_PROMPT)});
  ASSERT_EQ(results.size(), 2u);
  ASSERT_NE(toolsDriver, nullptr) << "seq 0's driver was never built";
  EXPECT_NE(streamed.find(THINK_CLOSE_TAG), std::string::npos)
      << "the tools slot's EOS must be replaced by the close tag: " << streamed;
  EXPECT_FALSE(results[1].empty())
      << "the sibling must survive the tools slot's grammar processing";

  ASSERT_TRUE(probed) << "nothing was streamed after the close: " << streamed;
  EXPECT_FALSE(budgetStillCounting)
      << "this multimodal slot's reasoning-budget matcher was still COUNTING "
         "after the close";
}

// The interaction this PR actually introduced between the two features:
// EOS substitution seeds the compactor itself (`recordCloseMarkerForReplay` +
// `requestCloseCapture` at each substitution site) because the substituted
// close never passes through the `updateReasoningBuffer` handshake that
// normally trips capture. Get that wrong and `compactThinkSpan` bails at
// `end < 0` — the discard silently does not happen — or, worse, the replay
// restores a prefix that opens a `<think>` nothing closes, which only shows up
// on the *next* request from that cache. So this drives a synthetic close with
// compaction on, persists the cache, and then reuses it.
TEST_F(ToolGrammarModelTest, SyntheticCloseCompactsAndLeavesAReusableCache) {
  if (!hasQwen3Model()) {
    GTEST_SKIP() << qwen3Model_.missingMessage();
  }
  const fs::path cacheDir = "synthetic_close_cache_dir";
  fs::remove_all(cacheDir);
  fs::create_directories(cacheDir);
  const std::string cacheKey = (cacheDir / "session.bin").string();

  config_["reasoning-budget"] = "64";
  config_["n_predict"] = "512";
  auto model = createModel();
  auto* textContext =
      dynamic_cast<TextLlmContext*>(LlamaModelTestPeer::llmContext(*model));
  ASSERT_NE(textContext, nullptr);
  const llama_token eos =
      llama_vocab_eos(llama_model_get_vocab(textContext->getModel()));
  ASSERT_NE(eos, LLAMA_TOKEN_NULL);

  LlamaModel::Prompt first = makePrompt(THINKING_TOOL_PROMPT);
  first.cacheKey = cacheKey;
  first.saveCacheToDisk = true;
  first.generationParams.remove_thinking_from_context = true;
  textContext->forceNextSampledTokenInsideReasoningForTesting(eos);

  const std::string output = model->processPrompt(first);
  ASSERT_NE(output.find(THINK_CLOSE_TAG), std::string::npos)
      << "EOS must be replaced by the cached close tag: " << output;
  EXPECT_GT(
      test_common::getStatValue(model->runtimeStats(), "thinkingBlockDiscards"),
      0)
      << "the substituted close must reach the compactor, or the span end "
         "stays unset and nothing is discarded: "
      << output;
  ASSERT_TRUE(fs::exists(cacheKey)) << "the cache must have been persisted";

  // The part a discard assertion alone cannot catch: a compaction that
  // rewound to an unbalanced prefix leaves a cache whose next turn is broken,
  // not one that fails now.
  LlamaModel::Prompt followUp = makePrompt(THINKING_TOOL_PROMPT);
  followUp.cacheKey = cacheKey;
  followUp.saveCacheToDisk = true;
  followUp.generationParams.remove_thinking_from_context = true;
  EXPECT_FALSE(model->processPrompt(followUp).empty())
      << "the cache left behind by a compacted synthetic close must still be "
         "usable";

  fs::remove_all(cacheDir);
}

// Cancelling mid-generation with a live tool grammar. The rollback code itself
// is untouched by this PR, but the *sampler state* is new, and it is the half
// that survives a reset: `common_sampler_reset` clears `prev` and the chain and
// nothing else, so a grammar and a reasoning-budget matcher advanced by the
// cancelled request are still advanced afterwards. What has to hold is that the
// next request inherits neither — not the cursor, not the constraint.
//
// Scope, and why this fixture is the right one. `rollbackCurrentRequest()` runs
// two mechanisms in sequence: the state rollback, which is
// architecture-specific, and the sampler reset, which is not. This test covers
// the second — the only one this PR adds state to — and deliberately does not
// re-cover the first. Qwen3-0.6B is pure attention, so the
// `RecurrentStateSnapshot` restore path in `TextLlmContext.cpp` is not entered
// here, and that path already has dedicated coverage on the Qwen3.5 hybrid
// fixture in `test_cancel_rollback.cpp`:
//
//   * `SnapshotRestoreRoundtripQwen35Hybrid`     — the restore primitive
//   * `OnCancelRestoresPreRequestSnapshotOnHybrid` — cancel restores the
//                                                    pre-request checkpoint
//   * `HybridModelSurvivesMidGenCancel`          — mid-generation cancel
//   * `MidPrefillCancelRollsBackHybridCache`     — mid-prefill cancel
//
// A combined case — a live tool grammar driven through the full-state restore
// path on the hybrid fixture — would be a stronger single regression than
// either half, and the fixture is present to build it on. It is tracked
// separately rather than added here: the two mechanisms run in sequence and
// are independent, and each already has coverage, so the combination would
// pin no behaviour that is unpinned today.
//
// `remove_thinking_from_context` is forced off so the cursor assertion reads
// the cancel rollback rather than end-of-generation compaction, which moves
// `nPast` for its own reasons.
TEST_F(ToolGrammarModelTest, CancelWithLiveToolGrammarLeavesNextRequestClean) {
  if (!hasQwen3Model()) {
    GTEST_SKIP() << qwen3Model_.missingMessage();
  }
  config_["reasoning-budget"] = "64";
  config_["n_predict"] = "512";
  auto model = createModel();
  ASSERT_EQ(LlamaModelTestPeer::scheduler(*model), nullptr)
      << "this test must exercise the long-lived single-prompt context";

  auto* mem = llama_get_memory(model->getContext());
  ASSERT_NE(mem, nullptr);
  const llama_pos preRequestNPast = llama_memory_seq_pos_max(mem, 0) + 1;

  // Cancel only after enough pieces to be sure the lazy grammar and the
  // budget matcher have both seen accepted tokens; one piece could still be
  // the opening `<think>`.
  constexpr int kPiecesBeforeCancel = 8;
  std::atomic<int> pieces{0};
  LlamaModel::Prompt cancelled = makePrompt(THINKING_TOOL_PROMPT);
  cancelled.generationParams.remove_thinking_from_context = false;
  cancelled.outputCallback = [&](const std::string&) {
    if (pieces.fetch_add(1) == kPiecesBeforeCancel) {
      model->cancel();
    }
  };
  ASSERT_NO_THROW(model->processPrompt(cancelled));
  ASSERT_GT(pieces.load(), kPiecesBeforeCancel)
      << "generation never reached the cancel point, so no sampler state was "
         "advanced and this test proves nothing";

  EXPECT_EQ(llama_memory_seq_pos_max(mem, 0) + 1, preRequestNPast)
      << "the cancel must roll the cursor back to where the request started";

  // The part that would break if the cancelled request's sampler state
  // survived: a following request carrying no tools must be unconstrained.
  LlamaModelTestPeer::llmContext(*model)->resetStopFlag();
  const std::string plain = model->processPrompt(makePrompt(PLAIN_PROMPT));
  EXPECT_FALSE(plain.empty())
      << "the next request must run, not inherit the cancelled request's stop "
         "state";
  EXPECT_FALSE(hasToolCallBlock(plain))
      << "the next request was still constrained by the cancelled request's "
         "tool grammar: "
      << plain;
  EXPECT_TRUE(sampling(*model).grammar.empty())
      << "the cancelled request's tool grammar is still resident";
  EXPECT_TRUE(sampling(*model).grammar_triggers.empty())
      << "the cancelled request's lazy triggers are still attached";
}
