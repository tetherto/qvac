#include <filesystem>
#include <string>
#include <unordered_map>

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
  EXPECT_EQ(state.openTokenCount, 0);
  EXPECT_EQ(state.forcedOpenTokenCount, 0);
  EXPECT_EQ(state.cached_close_tag_token, LLAMA_TOKEN_NULL);
  EXPECT_EQ(state.cached_newline_token, LLAMA_TOKEN_NULL);
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
