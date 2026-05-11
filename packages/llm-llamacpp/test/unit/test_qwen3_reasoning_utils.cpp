#include <filesystem>
#include <string>
#include <unordered_map>

#include <gtest/gtest.h>
#include <llama.h>

#include "model-interface/LlamaModel.hpp"
#include "test_common.hpp"
#include "utils/Qwen3ReasoningUtils.hpp"

namespace fs = std::filesystem;
using namespace qvac_lib_inference_addon_llama::utils;

class Qwen3ReasoningUtilsTest : public ::testing::Test {
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

TEST_F(Qwen3ReasoningUtilsTest, UpdateBufferWithEmptyToken) {
  Qwen3ReasoningState state;
  state.inside_reasoning = false;
  state.recent_output_buffer = "existing";

  updateQwen3ReasoningBuffer("", state);

  EXPECT_EQ(state.recent_output_buffer, "existing");
  EXPECT_FALSE(state.inside_reasoning);
}

TEST_F(Qwen3ReasoningUtilsTest, UpdateBufferWithNormalToken) {
  Qwen3ReasoningState state;
  state.recent_output_buffer = "";

  updateQwen3ReasoningBuffer("Hello", state);

  EXPECT_EQ(state.recent_output_buffer, "Hello");
  EXPECT_FALSE(state.inside_reasoning);
}

TEST_F(Qwen3ReasoningUtilsTest, UpdateBufferDetectsOpeningTag) {
  Qwen3ReasoningState state;
  state.recent_output_buffer = "";
  state.inside_reasoning = false;

  updateQwen3ReasoningBuffer("<think>", state);

  EXPECT_TRUE(state.inside_reasoning);
  EXPECT_EQ(state.recent_output_buffer, "<think>");
}

TEST_F(Qwen3ReasoningUtilsTest, UpdateBufferDetectsClosingTag) {
  Qwen3ReasoningState state;
  state.recent_output_buffer = "";
  state.inside_reasoning = true;

  updateQwen3ReasoningBuffer("</think>", state);

  EXPECT_FALSE(state.inside_reasoning);
  EXPECT_EQ(state.recent_output_buffer, "</think>");
}

TEST_F(Qwen3ReasoningUtilsTest, UpdateBufferRespectsSizeLimit) {
  Qwen3ReasoningState state;
  state.recent_output_buffer = "";

  std::string longToken(60, 'a');
  updateQwen3ReasoningBuffer(longToken, state);

  EXPECT_EQ(
      state.recent_output_buffer.length(), Qwen3ReasoningState::BUFFER_SIZE);
  EXPECT_EQ(state.recent_output_buffer, std::string(60, 'a').substr(10));
}

TEST_F(Qwen3ReasoningUtilsTest, UpdateBufferMultipleTokens) {
  Qwen3ReasoningState state;
  state.recent_output_buffer = "";

  updateQwen3ReasoningBuffer("Hello ", state);
  updateQwen3ReasoningBuffer("world", state);
  updateQwen3ReasoningBuffer("!", state);

  EXPECT_EQ(state.recent_output_buffer, "Hello world!");
  EXPECT_FALSE(state.inside_reasoning);
}

TEST_F(Qwen3ReasoningUtilsTest, UpdateBufferStateTransition) {
  Qwen3ReasoningState state;
  state.recent_output_buffer = "";
  state.inside_reasoning = false;

  updateQwen3ReasoningBuffer("Some text <think> more text", state);
  EXPECT_TRUE(state.inside_reasoning);

  updateQwen3ReasoningBuffer("</think>", state);
  EXPECT_FALSE(state.inside_reasoning);
}

TEST_F(Qwen3ReasoningUtilsTest, UpdateBufferWithReasoningContent) {
  Qwen3ReasoningState state;
  state.recent_output_buffer = "";
  state.inside_reasoning = false;

  updateQwen3ReasoningBuffer("<think>", state);
  EXPECT_TRUE(state.inside_reasoning);

  updateQwen3ReasoningBuffer("Let me think...", state);
  EXPECT_TRUE(state.inside_reasoning);

  updateQwen3ReasoningBuffer("</think>", state);
  EXPECT_FALSE(state.inside_reasoning);
}

TEST_F(Qwen3ReasoningUtilsTest, ReasoningStateDefaultInitialization) {
  Qwen3ReasoningState state;

  EXPECT_FALSE(state.inside_reasoning);
  EXPECT_EQ(state.cached_close_tag_token, LLAMA_TOKEN_NULL);
  EXPECT_EQ(state.cached_newline_token, LLAMA_TOKEN_NULL);
  EXPECT_TRUE(state.recent_output_buffer.empty());
  EXPECT_EQ(state.BUFFER_SIZE, 50);
}
