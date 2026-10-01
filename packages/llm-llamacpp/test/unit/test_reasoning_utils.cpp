#include <filesystem>
#include <string>
#include <unordered_map>
#include <vector>

#include <gtest/gtest.h>
#include <llama.h>

#include "model-interface/LlamaModel.hpp"
#include "test_common.hpp"
#include "utils/ReasoningUtils.hpp"

namespace fs = std::filesystem;
using namespace qvac_lib_inference_addon_llama::utils;

namespace {

// Convenience helper: a ReasoningState pre-configured with Qwen3 markers
// so each test does not need to repeat the `state.tags = ...` boilerplate.
// The detection helpers are tokenizer-agnostic for the substring path, so
// these tests do not need a real ::llama_context.
ReasoningState makeQwen3State() {
  ReasoningState state;
  state.tags = {.open = "<think>", .close = "</think>"};
  return state;
}

} // namespace

class ReasoningUtilsTest : public ::testing::Test {
protected:
  void SetUp() override {
    config_files["device"] = test_common::getTestDevice();
    config_files["ctx_size"] = "2048";
    config_files["gpu_layers"] = test_common::getTestGpuLayers();
    config_files["n_predict"] = "10";

    test_model_path = test_common::BaseTestModelPath::get();
    test_projection_path = "";

    config_files["backendsDir"] = test_common::getTestBackendsDir().string();
  }

  std::unordered_map<std::string, std::string> config_files;
  std::string test_model_path;
  std::string test_projection_path;

  bool hasValidModel() { return fs::exists(test_model_path); }
};

TEST_F(ReasoningUtilsTest, UpdateBufferWithEmptyToken) {
  ReasoningState state = makeQwen3State();
  state.inside_reasoning = false;
  state.recent_output_buffer = "existing";

  updateReasoningBuffer("", state);

  EXPECT_EQ(state.recent_output_buffer, "existing");
  EXPECT_FALSE(state.inside_reasoning);
}

TEST_F(ReasoningUtilsTest, UpdateBufferWithNormalToken) {
  ReasoningState state = makeQwen3State();

  updateReasoningBuffer("Hello", state);

  EXPECT_EQ(state.recent_output_buffer, "Hello");
  EXPECT_FALSE(state.inside_reasoning);
}

TEST_F(ReasoningUtilsTest, UpdateBufferDetectsQwen3OpeningTag) {
  ReasoningState state = makeQwen3State();

  updateReasoningBuffer("<think>", state);

  EXPECT_TRUE(state.inside_reasoning);
  EXPECT_EQ(state.recent_output_buffer, "<think>");
}

TEST_F(ReasoningUtilsTest, UpdateBufferDetectsQwen3ClosingTag) {
  ReasoningState state = makeQwen3State();
  state.inside_reasoning = true;

  updateReasoningBuffer("</think>", state);

  EXPECT_FALSE(state.inside_reasoning);
  EXPECT_EQ(state.recent_output_buffer, "</think>");
}

TEST_F(ReasoningUtilsTest, UpdateBufferRespectsSizeLimit) {
  ReasoningState state = makeQwen3State();

  std::string longToken(60, 'a');
  updateReasoningBuffer(longToken, state);

  EXPECT_EQ(state.recent_output_buffer.length(), ReasoningState::BUFFER_SIZE);
  EXPECT_EQ(state.recent_output_buffer, std::string(60, 'a').substr(10));
}

TEST_F(ReasoningUtilsTest, UpdateBufferMultipleTokens) {
  ReasoningState state = makeQwen3State();

  updateReasoningBuffer("Hello ", state);
  updateReasoningBuffer("world", state);
  updateReasoningBuffer("!", state);

  EXPECT_EQ(state.recent_output_buffer, "Hello world!");
  EXPECT_FALSE(state.inside_reasoning);
}

TEST_F(ReasoningUtilsTest, UpdateBufferStateTransition) {
  ReasoningState state = makeQwen3State();

  updateReasoningBuffer("Some text <think> more text", state);
  EXPECT_TRUE(state.inside_reasoning);

  updateReasoningBuffer("</think>", state);
  EXPECT_FALSE(state.inside_reasoning);
}

TEST_F(ReasoningUtilsTest, UpdateBufferWithReasoningContent) {
  ReasoningState state = makeQwen3State();

  updateReasoningBuffer("<think>", state);
  EXPECT_TRUE(state.inside_reasoning);

  updateReasoningBuffer("Let me think...", state);
  EXPECT_TRUE(state.inside_reasoning);

  updateReasoningBuffer("</think>", state);
  EXPECT_FALSE(state.inside_reasoning);
}

TEST_F(ReasoningUtilsTest, ReasoningStateDefaultInitialization) {
  ReasoningState state;

  EXPECT_FALSE(state.inside_reasoning);
  EXPECT_TRUE(state.tags.open.empty());
  EXPECT_TRUE(state.tags.close.empty());
  EXPECT_TRUE(state.recent_output_buffer.empty());
  EXPECT_EQ(state.BUFFER_SIZE, 50);
}

// Detection is a no-op when no tags have been configured (model has no
// recognised reasoning channel). Guards against false-positive flips on
// arbitrary output that happens to contain reserved-looking substrings.
TEST_F(ReasoningUtilsTest, UpdateBufferDisabledWhenTagsEmpty) {
  ReasoningState state;
  EXPECT_TRUE(state.tags.open.empty());

  updateReasoningBuffer("<think> something </think>", state);

  EXPECT_FALSE(state.inside_reasoning);
}

// Gemma 4 channel markers. The open marker `<|channel>thought` and close
// marker `<channel|>` are detected via raw substring match on the
// streamed piece buffer (same path Qwen3 uses), even when they tokenise
// to multiple BPE pieces under the active tokenizer.
TEST_F(ReasoningUtilsTest, UpdateBufferDetectsGemma4Markers) {
  ReasoningState state;
  state.tags = {.open = "<|channel>thought", .close = "<channel|>"};

  updateReasoningBuffer("<|channel>thought", state);
  EXPECT_TRUE(state.inside_reasoning);

  updateReasoningBuffer(" let me reason ", state);
  EXPECT_TRUE(state.inside_reasoning);

  updateReasoningBuffer("<channel|>", state);
  EXPECT_FALSE(state.inside_reasoning);
}

// The buffer is trimmed to BUFFER_SIZE characters from the tail, so a
// marker that arrives in two separate token-pieces is detected as long
// as both pieces fit within the rolling window.
TEST_F(ReasoningUtilsTest, UpdateBufferDetectsSplitGemma4Open) {
  ReasoningState state;
  state.tags = {.open = "<|channel>thought", .close = "<channel|>"};

  updateReasoningBuffer("<|channel>", state);
  EXPECT_FALSE(state.inside_reasoning);

  updateReasoningBuffer("thought", state);
  EXPECT_TRUE(state.inside_reasoning);
}

// Tags configured but markers not present: state should not flip, and
// the buffer should still accumulate normally.
TEST_F(ReasoningUtilsTest, UpdateBufferStaysOutsideForUnrelatedContent) {
  ReasoningState state = makeQwen3State();

  updateReasoningBuffer("Hello world, <thinking> is not the marker.", state);

  EXPECT_FALSE(state.inside_reasoning);
}

// Regression guard for padded close-tag detection: on chat templates whose
// `state.tags.close` carries
// surrounding whitespace padding (Qwen3's canonical form is
// `"\n</think>\n\n"`), `updateReasoningBuffer` runs
// `find(state.tags.close)` against the streamed piece buffer, so the
// `inside_reasoning` flip fires only once the entire padded string is
// present — i.e. on the LAST padding piece, not on `</think>` itself.
TEST_F(
    ReasoningUtilsTest, UpdateBufferFlipDefersToTrailingPaddingOnPaddedClose) {
  ReasoningState state;
  state.tags = {.open = "<think>", .close = "\n</think>\n\n"};
  state.inside_reasoning = true;

  updateReasoningBuffer("\n", state);
  EXPECT_TRUE(state.inside_reasoning)
      << "leading padding newline alone does not complete the padded close";

  updateReasoningBuffer("</think>", state);
  EXPECT_TRUE(state.inside_reasoning)
      << "canonical `</think>` piece does not by itself complete the padded "
         "close — trailing padding is still pending";

  updateReasoningBuffer("\n", state);
  EXPECT_TRUE(state.inside_reasoning)
      << "one trailing newline still leaves padding incomplete";

  updateReasoningBuffer("\n", state);
  EXPECT_FALSE(state.inside_reasoning)
      << "flip fires only on the LAST padding token, so the sampled `tokenId` "
         "at the flip site is a padding newline — not the canonical close";
}

// An answer sent back with its reasoning inline splits the way Qwen's
// templates split it.
TEST(ReasoningSplit, CutsTheReasoningBlockOutOfContent) {
  const ReasoningTags think{.open = "<think>", .close = "</think>"};
  const auto split = splitReasoningFromContent(
      "<think>\nI reason here.\n</think>\n\nRed, green, blue.", think);
  ASSERT_TRUE(split.has_value());
  EXPECT_EQ(split->reasoning, "I reason here.");
  EXPECT_EQ(split->content, "Red, green, blue.");

  // Opened by the template rather than the model: only the close is present.
  const auto forcedOpen =
      splitReasoningFromContent("I reason.\n</think>\n\nBlue.", think);
  ASSERT_TRUE(forcedOpen.has_value());
  EXPECT_EQ(forcedOpen->reasoning, "I reason.");
  EXPECT_EQ(forcedOpen->content, "Blue.");

  const ReasoningTags gemma{.open = "<|channel>thought", .close = "<channel|>"};
  const auto channel = splitReasoningFromContent(
      "<|channel>thought\nHmm.<channel|>Green.", gemma);
  ASSERT_TRUE(channel.has_value());
  EXPECT_EQ(channel->reasoning, "Hmm.");
  EXPECT_EQ(channel->content, "Green.");

  EXPECT_FALSE(splitReasoningFromContent("Just an answer.", think).has_value());
  EXPECT_FALSE(
      splitReasoningFromContent("a</think>b", ReasoningTags{}).has_value());
}

// Only assistant turns without their own `reasoning_content` are split.
TEST(ReasoningSplit, MovesReasoningOnlyOutOfAssistantContent) {
  const ReasoningTags think{.open = "<think>", .close = "</think>"};
  std::vector<common_chat_msg> messages(3);
  messages[0].role = "user";
  messages[0].content = "<think>not mine</think>Hi";
  messages[1].role = "assistant";
  messages[1].content = "<think>\nPlan.\n</think>\n\nAnswer.";
  messages[2].role = "assistant";
  messages[2].content = "<think>inline</think>Kept.";
  messages[2].reasoning_content = "given";

  moveReasoningOutOfContent(messages, think);

  EXPECT_EQ(messages[0].content, "<think>not mine</think>Hi");
  EXPECT_TRUE(messages[0].reasoning_content.empty());
  EXPECT_EQ(messages[1].reasoning_content, "Plan.");
  EXPECT_EQ(messages[1].content, "Answer.");
  EXPECT_EQ(messages[2].reasoning_content, "given");
  EXPECT_EQ(messages[2].content, "<think>inline</think>Kept.");
}
