// Owns ToolsCompactController behavior and prompt-shape validation contract.
// Slider orchestration and llama KV side effects are intentionally tested in
// test_context_slider.cpp.

#include <optional>
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

ToolsCompactProfile makeQwen3Profile() {
  ToolsCompactProfile profile;
  profile.toolCallStartMarker = "<tool_call>";
  return profile;
}

common_chat_msg
makeMsg(const std::string& role, const std::string& content = "") {
  common_chat_msg msg;
  msg.role = role;
  msg.content = content;
  return msg;
}

common_chat_msg makeAssistantMsgWithToolCalls() {
  common_chat_msg msg;
  msg.role = "assistant";
  msg.content = "";

  common_chat_tool_call toolCall;
  toolCall.id = "call_01";
  toolCall.name = "get_weather";
  toolCall.arguments = "{\"city\":\"Paris\"}";
  msg.tool_calls.push_back(toolCall);

  return msg;
}
} // namespace

TEST(ToolsCompactControllerTest, EnabledReturnsTrueWhenConstructedWithProfile) {
  ToolsCompactController controller(ToolsCompactProfile{});
  EXPECT_TRUE(controller.enabled());
}

TEST(
    ToolsCompactControllerTest,
    EnabledReturnsFalseWhenConstructedWithoutProfile) {
  ToolsCompactController controller(std::nullopt);
  EXPECT_FALSE(controller.enabled());
}

TEST(ToolsCompactControllerTest, AnchorIsMinusOneInitially) {
  ToolsCompactController controller(ToolsCompactProfile{});
  EXPECT_EQ(controller.anchor(), -1);
}

TEST(ToolsCompactControllerTest, ResetClearsAnchor) {
  ToolsCompactController controller(ToolsCompactProfile{});
  controller.onTokenize(200, 100);
  controller.onEvalComplete(200, 200);
  EXPECT_EQ(controller.anchor(), 100);
  controller.reset();
  EXPECT_EQ(controller.anchor(), -1);
}

TEST(ToolsCompactControllerTest, ValidatePromptNoOpsWhenDisabled) {
  ToolsCompactController controller(std::nullopt);
  PromptLayout layout;
  layout.totalItems = 1;
  layout.lastItemIsUserMsg = true;
  std::vector<common_chat_msg> chatMsgs;
  std::vector<common_chat_tool> tools;
  EXPECT_NO_THROW(controller.validatePrompt(chatMsgs, tools, layout, false));
}

TEST(ToolsCompactControllerTest, ValidatePromptRejectsMissingAnchor) {
  ToolsCompactController controller(ToolsCompactProfile{});
  PromptLayout layout;
  layout.totalItems = 1;
  layout.firstToolIdx = 0;
  layout.lastToolIdx = 0;
  layout.toolCount = 1;
  std::vector<common_chat_tool> tools = {makeTool()};
  std::vector<common_chat_msg> chatMsgs;
  EXPECT_THROW(
      controller.validatePrompt(chatMsgs, tools, layout, false),
      qvac_errors::StatusError);
}

TEST(ToolsCompactControllerTest, ValidatePromptRejectsDetachedToolBlock) {
  ToolsCompactController controller(ToolsCompactProfile{});
  PromptLayout layout;
  layout.totalItems = 3;
  layout.firstToolIdx = 2;
  layout.lastToolIdx = 2;
  layout.lastAnchorIdx = 0;
  layout.toolCount = 1;
  std::vector<common_chat_tool> tools = {makeTool()};
  std::vector<common_chat_msg> chatMsgs;
  EXPECT_THROW(
      controller.validatePrompt(chatMsgs, tools, layout, false),
      qvac_errors::StatusError);
}

TEST(ToolsCompactControllerTest, ValidatePromptRejectsSplitToolBlock) {
  ToolsCompactController controller(ToolsCompactProfile{});
  PromptLayout layout;
  layout.totalItems = 4;
  layout.firstToolIdx = 1;
  layout.lastToolIdx = 3;
  layout.lastAnchorIdx = 0;
  layout.toolCount = 2;
  std::vector<common_chat_tool> tools = {makeTool("a"), makeTool("b")};
  std::vector<common_chat_msg> chatMsgs;
  EXPECT_THROW(
      controller.validatePrompt(chatMsgs, tools, layout, false),
      qvac_errors::StatusError);
}

TEST(ToolsCompactControllerTest, ValidatePromptRejectsToolBlockNotAtEnd) {
  ToolsCompactController controller(ToolsCompactProfile{});
  PromptLayout layout;
  layout.totalItems = 3;
  layout.firstToolIdx = 1;
  layout.lastToolIdx = 1;
  layout.lastAnchorIdx = 0;
  layout.toolCount = 1;
  std::vector<common_chat_tool> tools = {makeTool()};
  std::vector<common_chat_msg> chatMsgs;
  EXPECT_THROW(
      controller.validatePrompt(chatMsgs, tools, layout, false),
      qvac_errors::StatusError);
}

TEST(ToolsCompactControllerTest, ValidatePromptAcceptsContiguousAttachedBlock) {
  ToolsCompactController controller(ToolsCompactProfile{});
  PromptLayout layout;
  layout.totalItems = 3;
  layout.firstToolIdx = 1;
  layout.lastToolIdx = 2;
  layout.lastAnchorIdx = 0;
  layout.toolCount = 2;
  std::vector<common_chat_tool> tools = {makeTool("a"), makeTool("b")};
  std::vector<common_chat_msg> chatMsgs;
  EXPECT_NO_THROW(controller.validatePrompt(chatMsgs, tools, layout, false));
}

TEST(
    ToolsCompactControllerTest,
    ValidatePromptRequiresToolsForUserTailWithoutCache) {
  ToolsCompactController controller(makeQwen3Profile());
  PromptLayout layout;
  std::vector<common_chat_msg> chatMsgs = {
      makeMsg("system", "You are helpful"), makeMsg("user", "Need weather")};
  std::vector<common_chat_tool> tools;
  EXPECT_THROW(
      controller.validatePrompt(chatMsgs, tools, layout, false),
      qvac_errors::StatusError);
}

TEST(
    ToolsCompactControllerTest,
    ValidatePromptRequiresToolsForAssistantToolCallTailWithoutCache) {
  ToolsCompactController controller(makeQwen3Profile());
  PromptLayout layout;
  std::vector<common_chat_msg> chatMsgs = {
      makeMsg("system", "You are helpful"),
      makeMsg("user", "Need weather"),
      makeMsg(
          "assistant", "<tool_call>{\"name\":\"get_weather\"}</tool_call>")};
  std::vector<common_chat_tool> tools;
  EXPECT_THROW(
      controller.validatePrompt(chatMsgs, tools, layout, false),
      qvac_errors::StatusError);
}

TEST(
    ToolsCompactControllerTest,
    ValidatePromptRequiresToolsForAssistantToolCallsTailWithoutCache) {
  ToolsCompactController controller(makeQwen3Profile());
  PromptLayout layout;
  std::vector<common_chat_msg> chatMsgs = {
      makeMsg("system", "You are helpful"),
      makeMsg("user", "Need weather"),
      makeAssistantMsgWithToolCalls()};
  std::vector<common_chat_tool> tools;
  EXPECT_THROW(
      controller.validatePrompt(chatMsgs, tools, layout, false),
      qvac_errors::StatusError);
}

TEST(
    ToolsCompactControllerTest,
    ValidatePromptAllowsAssistantToolCallTailWithCacheAndNoTools) {
  ToolsCompactController controller(makeQwen3Profile());
  PromptLayout layout;
  std::vector<common_chat_msg> chatMsgs = {
      makeMsg("system", "You are helpful"),
      makeMsg("user", "Need weather"),
      makeMsg(
          "assistant", "<tool_call>{\"name\":\"get_weather\"}</tool_call>")};
  std::vector<common_chat_tool> tools;
  EXPECT_NO_THROW(controller.validatePrompt(chatMsgs, tools, layout, true));
}

TEST(
    ToolsCompactControllerTest,
    ValidatePromptRequiresToolsForToolTailWithoutCache) {
  ToolsCompactController controller(makeQwen3Profile());
  PromptLayout layout;
  std::vector<common_chat_msg> chatMsgs = {
      makeMsg("system", "You are helpful"),
      makeMsg("user", "Need weather"),
      makeMsg("assistant", "I will call a tool"),
      makeMsg("tool", "{\"temp\": 20}")};
  std::vector<common_chat_tool> tools;
  EXPECT_THROW(
      controller.validatePrompt(chatMsgs, tools, layout, false),
      qvac_errors::StatusError);
}

TEST(
    ToolsCompactControllerTest,
    ValidatePromptAllowsToolTailWithCacheAndNoTools) {
  ToolsCompactController controller(makeQwen3Profile());
  PromptLayout layout;
  std::vector<common_chat_msg> chatMsgs = {
      makeMsg("system", "You are helpful"),
      makeMsg("user", "Need weather"),
      makeMsg("assistant", "I will call a tool"),
      makeMsg("tool", "{\"temp\": 20}")};
  std::vector<common_chat_tool> tools;
  EXPECT_NO_THROW(controller.validatePrompt(chatMsgs, tools, layout, true));
}

TEST(
    ToolsCompactControllerTest,
    ValidatePromptAllowsAssistantNonToolCallTailWithoutCacheAndNoTools) {
  ToolsCompactController controller(makeQwen3Profile());
  PromptLayout layout;
  std::vector<common_chat_msg> chatMsgs = {
      makeMsg("system", "You are helpful"),
      makeMsg("user", "Need weather"),
      makeMsg("assistant", "It is sunny in Tokyo")};
  std::vector<common_chat_tool> tools;
  EXPECT_NO_THROW(controller.validatePrompt(chatMsgs, tools, layout, false));
}

TEST(
    ToolsCompactControllerTest,
    ValidatePromptAllowsFinalAssistantAfterToolRoundWithoutCacheAndNoTools) {
  ToolsCompactController controller(makeQwen3Profile());
  PromptLayout layout;
  std::vector<common_chat_msg> chatMsgs = {
      makeMsg("system", "You are helpful"),
      makeMsg("user", "Need weather"),
      makeMsg("assistant", "<tool_call>{\"name\":\"get_weather\"}</tool_call>"),
      makeMsg("tool", "{\"temp\": 20}"),
      makeMsg("assistant", "It is 20C and sunny")};
  std::vector<common_chat_tool> tools;
  EXPECT_NO_THROW(controller.validatePrompt(chatMsgs, tools, layout, false));
}

TEST(
    ToolsCompactControllerTest,
    OnTokenizeAndEvalSetAnchorOnlyWhenToolsAddExtraTokens) {
  ToolsCompactController controller(ToolsCompactProfile{});

  controller.onTokenize(120, 120);
  controller.onEvalComplete(120, 120);
  EXPECT_EQ(controller.anchor(), -1);

  controller.reset();
  controller.onTokenize(120, 80);
  controller.onEvalComplete(120, 120);
  EXPECT_EQ(controller.anchor(), 80);
}

TEST(ToolsCompactControllerTest, OnTokenizeAndEvalNoOpWhenDisabled) {
  ToolsCompactController controller(std::nullopt);
  controller.onTokenize(120, 80);
  controller.onEvalComplete(120, 120);
  EXPECT_EQ(controller.anchor(), -1);
}

TEST(ToolsCompactControllerTest, ClampDiscardPreservesToolRegion) {
  ToolsCompactController controller(ToolsCompactProfile{});
  constexpr llama_pos firstMsgTokens = 50;
  controller.onTokenize(200, 100);
  controller.onEvalComplete(200, 200);
  EXPECT_EQ(controller.anchor(), 100);
  EXPECT_EQ(controller.clampDiscard(80, firstMsgTokens), 50);
}

TEST(ToolsCompactControllerTest, ClampDiscardReturnsRequestedWhenSafe) {
  ToolsCompactController controller(ToolsCompactProfile{});
  constexpr llama_pos firstMsgTokens = 10;
  controller.onTokenize(300, 200);
  controller.onEvalComplete(300, 300);
  EXPECT_EQ(controller.anchor(), 200);
  EXPECT_EQ(controller.clampDiscard(30, firstMsgTokens), 30);
}

TEST(ToolsCompactControllerTest, OnSlideAdjustsAnchor) {
  ToolsCompactController controller(ToolsCompactProfile{});
  constexpr llama_pos firstMsgTokens = 50;
  controller.onTokenize(200, 100);
  controller.onEvalComplete(200, 200);
  controller.onSlide(30, firstMsgTokens);
  EXPECT_EQ(controller.anchor(), 70);
}

TEST(ToolsCompactControllerTest, OnSlideStopsAtFirstMsgTokens) {
  ToolsCompactController controller(ToolsCompactProfile{});
  constexpr llama_pos firstMsgTokens = 80;
  controller.onTokenize(200, 100);
  controller.onEvalComplete(200, 200);
  controller.onSlide(30, firstMsgTokens);
  EXPECT_EQ(controller.anchor(), firstMsgTokens);
}

TEST(
    ToolsCompactControllerTest,
    DegenerateAnchorIsNotUsableForPostGenerationTrim) {
  ToolsCompactController controller(ToolsCompactProfile{});
  constexpr llama_pos firstMsgTokens = 100;
  controller.onTokenize(220, 100);
  controller.onEvalComplete(220, 220);
  EXPECT_TRUE(controller.degenerateBoundary(firstMsgTokens));
  EXPECT_FALSE(controller.usableBoundary(firstMsgTokens));
}

TEST(
    ToolsCompactControllerTest,
    PositiveNonDegenerateAnchorIsUsableForPostTrim) {
  ToolsCompactController controller(ToolsCompactProfile{});
  constexpr llama_pos firstMsgTokens = 100;
  controller.onTokenize(100, 80);
  controller.onEvalComplete(100, 100);
  EXPECT_EQ(controller.anchor(), 80);
  EXPECT_TRUE(controller.usableBoundary(firstMsgTokens));
}

TEST(ToolsCompactControllerTest, SlidingUnclampedFullDiscard) {
  ToolsCompactController controller(ToolsCompactProfile{});
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
  ToolsCompactController controller(std::nullopt);
  auto decision = controller.onGenerationComplete("done", 10, 5);
  EXPECT_FALSE(decision.trim);
  EXPECT_EQ(decision.tokensToRemoveFromTail, 0);
  EXPECT_FALSE(decision.clampFirstMsgTokensToNPast);
}

TEST(
    ToolsCompactControllerTest,
    GenerationCompleteDegenerateBoundaryResetsState) {
  ToolsCompactController controller(ToolsCompactProfile{});
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

TEST(
    ToolsCompactControllerTest,
    GenerationCompleteNoTrimWhenToolCallContinuesChain) {
  ToolsCompactController controller(makeQwen3Profile());
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

TEST(
    ToolsCompactControllerTest,
    GenerationCompleteNoTrimWhenToolCallMatchesCustomProfileMarker) {
  ToolsCompactProfile profile;
  profile.toolCallStartMarker = "<function_call>";
  ToolsCompactController controller(profile);
  constexpr llama_pos firstMsgTokens = 50;
  controller.onTokenize(140, 80);
  controller.onEvalComplete(140, 140); // anchor = 80
  auto decision = controller.onGenerationComplete(
      "<function_call>{\"name\":\"foo\"}</function_call>", 120, firstMsgTokens);
  EXPECT_FALSE(decision.trim);
  EXPECT_EQ(controller.anchor(), 80);
}

TEST(
    ToolsCompactControllerTest,
    GenerationCompleteTrimWhenMarkerDoesNotMatchProfile) {
  ToolsCompactProfile profile;
  profile.toolCallStartMarker = "<function_call>";
  ToolsCompactController controller(profile);
  constexpr llama_pos firstMsgTokens = 50;
  controller.onTokenize(140, 80);
  controller.onEvalComplete(140, 140); // anchor = 80
  auto decision = controller.onGenerationComplete(
      "<tool_call>{\"name\":\"foo\"}</tool_call>", 120, firstMsgTokens);
  EXPECT_TRUE(decision.trim);
  EXPECT_EQ(decision.tokensToRemoveFromTail, 40);
  EXPECT_EQ(controller.anchor(), -1);
}

TEST(
    ToolsCompactControllerTest,
    GenerationCompleteNoTrimWhenProfileMarkerIsEmpty) {
  ToolsCompactController controller(ToolsCompactProfile{});
  constexpr llama_pos firstMsgTokens = 50;
  controller.onTokenize(140, 80);
  controller.onEvalComplete(140, 140); // anchor = 80
  auto decision =
      controller.onGenerationComplete("final answer", 120, firstMsgTokens);
  EXPECT_FALSE(decision.trim);
  EXPECT_EQ(controller.anchor(), 80);
}

TEST(
    ToolsCompactControllerTest,
    GenerationCompleteNoTrimWhenNPastNotPastAnchor) {
  ToolsCompactController controller(ToolsCompactProfile{});
  constexpr llama_pos firstMsgTokens = 50;
  controller.onTokenize(140, 80);
  controller.onEvalComplete(140, 140); // anchor = 80
  auto decision = controller.onGenerationComplete("done", 80, firstMsgTokens);
  EXPECT_FALSE(decision.trim);
  EXPECT_EQ(controller.anchor(), 80);
}

TEST(
    ToolsCompactControllerTest,
    GenerationCompleteTrimDecisionAndResetWhenChainDone) {
  ToolsCompactController controller(makeQwen3Profile());
  constexpr llama_pos firstMsgTokens = 50;
  controller.onTokenize(140, 80);
  controller.onEvalComplete(140, 140); // anchor = 80
  auto decision =
      controller.onGenerationComplete("final answer", 130, firstMsgTokens);
  EXPECT_TRUE(decision.trim);
  EXPECT_EQ(decision.tokensToRemoveFromTail, 50);
  EXPECT_TRUE(decision.clampFirstMsgTokensToNPast);
  EXPECT_EQ(controller.anchor(), -1);
  auto snapshot = controller.debugSnapshot();
  EXPECT_EQ(snapshot.nPastBeforeTools, 80);
  EXPECT_TRUE(snapshot.lastToolsTrimmed);
}

TEST(ToolsCompactControllerTest, DebugSnapshotStaysConsistentAcrossReset) {
  ToolsCompactController controller(makeQwen3Profile());
  constexpr llama_pos firstMsgTokens = 50;
  controller.onTokenize(140, 80);
  controller.onEvalComplete(140, 140);

  auto decision =
      controller.onGenerationComplete("final answer", 130, firstMsgTokens);
  EXPECT_TRUE(decision.trim);

  auto snapshotBeforeReset = controller.debugSnapshot();
  EXPECT_EQ(snapshotBeforeReset.nPastBeforeTools, 80);
  EXPECT_TRUE(snapshotBeforeReset.lastToolsTrimmed);

  controller.reset();
  EXPECT_EQ(controller.anchor(), -1);

  auto snapshotAfterReset = controller.debugSnapshot();
  EXPECT_EQ(snapshotAfterReset.nPastBeforeTools, 80);
  EXPECT_TRUE(snapshotAfterReset.lastToolsTrimmed);
}

TEST(
    ToolsCompactControllerTest,
    DebugSnapshotIsGenerationCapturedNotLiveAnchorAfterSlide) {
  ToolsCompactController controller(makeQwen3Profile());
  constexpr llama_pos firstMsgTokens = 50;
  controller.onTokenize(140, 80);
  controller.onEvalComplete(140, 140); // anchor = 80

  auto decision = controller.onGenerationComplete(
      "<tool_call>{\"name\":\"foo\"}</tool_call>", 120, firstMsgTokens);
  EXPECT_FALSE(decision.trim);
  EXPECT_EQ(controller.anchor(), 80);

  auto snapshotBeforeSlide = controller.debugSnapshot();
  EXPECT_EQ(snapshotBeforeSlide.nPastBeforeTools, 80);
  EXPECT_FALSE(snapshotBeforeSlide.lastToolsTrimmed);

  controller.onSlide(20, firstMsgTokens);
  EXPECT_EQ(controller.anchor(), 60);

  auto snapshotAfterSlide = controller.debugSnapshot();
  EXPECT_EQ(snapshotAfterSlide.nPastBeforeTools, 80);
  EXPECT_FALSE(snapshotAfterSlide.lastToolsTrimmed);
}

TEST(
    ToolsCompactControllerTest,
    ResetDoesNotClearDebugSnapshotAfterNoTrimGenerationComplete) {
  ToolsCompactController controller(makeQwen3Profile());
  constexpr llama_pos firstMsgTokens = 50;
  controller.onTokenize(140, 80);
  controller.onEvalComplete(140, 140); // anchor = 80

  auto decision = controller.onGenerationComplete(
      "<tool_call>{\"name\":\"foo\"}</tool_call>", 120, firstMsgTokens);
  EXPECT_FALSE(decision.trim);

  auto snapshotBeforeReset = controller.debugSnapshot();
  EXPECT_EQ(snapshotBeforeReset.nPastBeforeTools, 80);
  EXPECT_FALSE(snapshotBeforeReset.lastToolsTrimmed);

  controller.reset();
  EXPECT_EQ(controller.anchor(), -1);

  auto snapshotAfterReset = controller.debugSnapshot();
  EXPECT_EQ(snapshotAfterReset.nPastBeforeTools, 80);
  EXPECT_FALSE(snapshotAfterReset.lastToolsTrimmed);
}
