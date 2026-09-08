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
}
