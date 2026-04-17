#include <string>
#include <vector>

#include <gtest/gtest.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>

#include "common/chat.h"
#include "model-interface/ToolsCompactController.hpp"

namespace {
common_chat_tool makeTool(const std::string& name = "tool") {
  common_chat_tool tool;
  tool.name = name;
  return tool;
}
} // namespace

TEST(ToolsCompactControllerTest, EnabledReturnsTrueWhenConstructedWithTrue) {
  ToolsCompactController controller(true);
  EXPECT_TRUE(controller.enabled());
}

TEST(ToolsCompactControllerTest, EnabledReturnsFalseWhenConstructedWithFalse) {
  ToolsCompactController controller(false);
  EXPECT_FALSE(controller.enabled());
}

TEST(ToolsCompactControllerTest, AnchorIsMinusOneInitially) {
  ToolsCompactController controller(true);
  EXPECT_EQ(controller.anchor(), -1);
}

TEST(ToolsCompactControllerTest, ResetClearsAnchor) {
  ToolsCompactController controller(true);
  controller.onTokenize(200, 100);
  controller.onEvalComplete(200, 200);
  EXPECT_EQ(controller.anchor(), 100);
  controller.reset();
  EXPECT_EQ(controller.anchor(), -1);
}

TEST(ToolsCompactControllerTest, ValidatePromptNoOpsWhenDisabled) {
  ToolsCompactController controller(false);
  PromptLayout layout;
  layout.totalItems = 1;
  layout.lastItemIsUserMsg = true;
  std::vector<common_chat_msg> chatMsgs;
  std::vector<common_chat_tool> tools;
  EXPECT_NO_THROW(controller.validatePrompt(chatMsgs, tools, layout));
}

TEST(
    ToolsCompactControllerTest,
    ValidatePromptRejectsMissingToolsOnLastUserMessage) {
  ToolsCompactController controller(true);
  PromptLayout layout;
  layout.totalItems = 1;
  layout.lastItemIsUserMsg = true;
  std::vector<common_chat_msg> chatMsgs;
  std::vector<common_chat_tool> tools;
  EXPECT_THROW(
      controller.validatePrompt(chatMsgs, tools, layout),
      qvac_errors::StatusError);
}

TEST(ToolsCompactControllerTest, ValidatePromptRejectsMissingAnchor) {
  ToolsCompactController controller(true);
  PromptLayout layout;
  layout.totalItems = 1;
  layout.firstToolIdx = 0;
  layout.lastToolIdx = 0;
  layout.toolCount = 1;
  std::vector<common_chat_tool> tools = {makeTool()};
  std::vector<common_chat_msg> chatMsgs;
  EXPECT_THROW(
      controller.validatePrompt(chatMsgs, tools, layout),
      qvac_errors::StatusError);
}

TEST(ToolsCompactControllerTest, ValidatePromptRejectsDetachedToolBlock) {
  ToolsCompactController controller(true);
  PromptLayout layout;
  layout.totalItems = 3;
  layout.firstToolIdx = 2;
  layout.lastToolIdx = 2;
  layout.lastAnchorIdx = 0;
  layout.toolCount = 1;
  std::vector<common_chat_tool> tools = {makeTool()};
  std::vector<common_chat_msg> chatMsgs;
  EXPECT_THROW(
      controller.validatePrompt(chatMsgs, tools, layout),
      qvac_errors::StatusError);
}

TEST(ToolsCompactControllerTest, ValidatePromptRejectsSplitToolBlock) {
  ToolsCompactController controller(true);
  PromptLayout layout;
  layout.totalItems = 4;
  layout.firstToolIdx = 1;
  layout.lastToolIdx = 3;
  layout.lastAnchorIdx = 0;
  layout.toolCount = 2;
  std::vector<common_chat_tool> tools = {makeTool("a"), makeTool("b")};
  std::vector<common_chat_msg> chatMsgs;
  EXPECT_THROW(
      controller.validatePrompt(chatMsgs, tools, layout),
      qvac_errors::StatusError);
}

TEST(ToolsCompactControllerTest, ValidatePromptRejectsToolBlockNotAtEnd) {
  ToolsCompactController controller(true);
  PromptLayout layout;
  layout.totalItems = 3;
  layout.firstToolIdx = 1;
  layout.lastToolIdx = 1;
  layout.lastAnchorIdx = 0;
  layout.toolCount = 1;
  std::vector<common_chat_tool> tools = {makeTool()};
  std::vector<common_chat_msg> chatMsgs;
  EXPECT_THROW(
      controller.validatePrompt(chatMsgs, tools, layout),
      qvac_errors::StatusError);
}

TEST(ToolsCompactControllerTest, ValidatePromptAcceptsContiguousAttachedBlock) {
  ToolsCompactController controller(true);
  PromptLayout layout;
  layout.totalItems = 3;
  layout.firstToolIdx = 1;
  layout.lastToolIdx = 2;
  layout.lastAnchorIdx = 0;
  layout.toolCount = 2;
  std::vector<common_chat_tool> tools = {makeTool("a"), makeTool("b")};
  std::vector<common_chat_msg> chatMsgs;
  EXPECT_NO_THROW(controller.validatePrompt(chatMsgs, tools, layout));
}

TEST(ToolsCompactControllerTest, ClampDiscardPreservesToolRegion) {
  ToolsCompactController controller(true);
  constexpr llama_pos firstMsgTokens = 50;
  controller.onTokenize(200, 100);
  controller.onEvalComplete(200, 200);
  EXPECT_EQ(controller.anchor(), 100);
  EXPECT_EQ(controller.clampDiscard(80, firstMsgTokens), 50);
}

TEST(ToolsCompactControllerTest, ClampDiscardReturnsRequestedWhenSafe) {
  ToolsCompactController controller(true);
  constexpr llama_pos firstMsgTokens = 10;
  controller.onTokenize(300, 200);
  controller.onEvalComplete(300, 300);
  EXPECT_EQ(controller.anchor(), 200);
  EXPECT_EQ(controller.clampDiscard(30, firstMsgTokens), 30);
}

TEST(ToolsCompactControllerTest, OnSlideAdjustsAnchor) {
  ToolsCompactController controller(true);
  constexpr llama_pos firstMsgTokens = 50;
  controller.onTokenize(200, 100);
  controller.onEvalComplete(200, 200);
  controller.onSlide(30, firstMsgTokens);
  EXPECT_EQ(controller.anchor(), 70);
}

TEST(ToolsCompactControllerTest, OnSlideStopsAtFirstMsgTokens) {
  ToolsCompactController controller(true);
  constexpr llama_pos firstMsgTokens = 80;
  controller.onTokenize(200, 100);
  controller.onEvalComplete(200, 200);
  controller.onSlide(30, firstMsgTokens);
  EXPECT_EQ(controller.anchor(), firstMsgTokens);
}

TEST(ToolsCompactControllerTest, AnchorCanReachFirstMessageBoundaryAfterSlide) {
  ToolsCompactController controller(true);
  controller.onTokenize(200, 120);
  controller.onEvalComplete(200, 200);
  constexpr llama_pos firstMsgTokens = 100;
  controller.onSlide(20, firstMsgTokens);
  EXPECT_EQ(controller.anchor(), firstMsgTokens);
  controller.onSlide(5, firstMsgTokens);
  EXPECT_EQ(controller.anchor(), firstMsgTokens);
}

TEST(ToolsCompactControllerTest, DegenerateAnchorIsNotUsableForPostGenerationTrim) {
  ToolsCompactController controller(true);
  constexpr llama_pos firstMsgTokens = 100;
  controller.onTokenize(220, 100);
  controller.onEvalComplete(220, 220);
  EXPECT_TRUE(controller.degenerateBoundary(firstMsgTokens));
  EXPECT_FALSE(controller.usableBoundary(firstMsgTokens));
}

TEST(ToolsCompactControllerTest, PositiveNonDegenerateAnchorIsUsableForPostTrim) {
  ToolsCompactController controller(true);
  constexpr llama_pos firstMsgTokens = 100;
  controller.onTokenize(100, 80);
  controller.onEvalComplete(100, 100);
  EXPECT_EQ(controller.anchor(), 80);
  EXPECT_TRUE(controller.usableBoundary(firstMsgTokens));
}

TEST(ToolsCompactControllerTest, SlidingUnclampedFullDiscard) {
  ToolsCompactController controller(true);
  constexpr llama_pos firstMsgTokens = 11;
  constexpr llama_pos anchorBefore = 241;
  constexpr llama_pos nDiscarded = 32;
  controller.onTokenize(341, 241);
  controller.onEvalComplete(341, 341);
  const llama_pos discard = controller.clampDiscard(nDiscarded, firstMsgTokens);
  controller.onSlide(discard, firstMsgTokens);
  EXPECT_EQ(discard, nDiscarded);
  EXPECT_EQ(controller.anchor(), anchorBefore - nDiscarded);
  EXPECT_GE(controller.anchor(), firstMsgTokens);
}

TEST(ToolsCompactControllerTest, GenerationCompleteNoopWhenDisabled) {
  ToolsCompactController controller(false);
  auto decision = controller.onGenerationComplete("done", 10, 5);
  EXPECT_FALSE(decision.trim);
  EXPECT_EQ(decision.tokensToRemoveFromTail, 0);
  EXPECT_FALSE(decision.clampFirstMsgTokensToNPast);
}

TEST(ToolsCompactControllerTest, GenerationCompleteDegenerateBoundaryResetsState) {
  ToolsCompactController controller(true);
  constexpr llama_pos firstMsgTokens = 100;
  controller.onTokenize(200, 100);
  controller.onEvalComplete(200, 200); // anchor == firstMsgTokens
  auto decision = controller.onGenerationComplete("done", 150, firstMsgTokens);
  EXPECT_FALSE(decision.trim);
  EXPECT_EQ(controller.anchor(), -1);
  auto snapshot = controller.debugSnapshot();
  EXPECT_EQ(snapshot.nPastBeforeTools, firstMsgTokens);
  EXPECT_FALSE(snapshot.lastToolsTrimmed);
}

TEST(ToolsCompactControllerTest, GenerationCompleteNoTrimWhenToolCallContinuesChain) {
  ToolsCompactController controller(true);
  constexpr llama_pos firstMsgTokens = 50;
  controller.onTokenize(140, 80);
  controller.onEvalComplete(140, 140); // anchor = 80
  auto decision = controller.onGenerationComplete(
      "<tool_call>{\"name\":\"foo\"}</tool_call>", 120, firstMsgTokens);
  EXPECT_FALSE(decision.trim);
  EXPECT_EQ(controller.anchor(), 80);
  auto snapshot = controller.debugSnapshot();
  EXPECT_EQ(snapshot.nPastBeforeTools, 80);
  EXPECT_FALSE(snapshot.lastToolsTrimmed);
}

TEST(ToolsCompactControllerTest, GenerationCompleteNoTrimWhenNPastNotPastAnchor) {
  ToolsCompactController controller(true);
  constexpr llama_pos firstMsgTokens = 50;
  controller.onTokenize(140, 80);
  controller.onEvalComplete(140, 140); // anchor = 80
  auto decision = controller.onGenerationComplete("done", 80, firstMsgTokens);
  EXPECT_FALSE(decision.trim);
  EXPECT_EQ(controller.anchor(), 80);
}

TEST(ToolsCompactControllerTest, GenerationCompleteTrimDecisionAndResetWhenChainDone) {
  ToolsCompactController controller(true);
  constexpr llama_pos firstMsgTokens = 50;
  controller.onTokenize(140, 80);
  controller.onEvalComplete(140, 140); // anchor = 80
  auto decision = controller.onGenerationComplete("final answer", 130, firstMsgTokens);
  EXPECT_TRUE(decision.trim);
  EXPECT_EQ(decision.tokensToRemoveFromTail, 50);
  EXPECT_TRUE(decision.clampFirstMsgTokensToNPast);
  EXPECT_EQ(controller.anchor(), -1);
  auto snapshot = controller.debugSnapshot();
  EXPECT_EQ(snapshot.nPastBeforeTools, 80);
  EXPECT_TRUE(snapshot.lastToolsTrimmed);
}
