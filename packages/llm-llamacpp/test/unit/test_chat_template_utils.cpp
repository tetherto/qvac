#include <filesystem>
#include <string>
#include <string_view>
#include <unordered_map>

#include <gtest/gtest.h>
#include <llama.h>

#include "model-interface/LlamaModel.hpp"
#include "test_common.hpp"
#include "utils/ChatTemplateUtils.hpp"
#include "utils/Qwen3ToolsDynamicTemplate.hpp"
#include "utils/QwenTemplate.hpp"

namespace fs = std::filesystem;
using namespace qvac_lib_inference_addon_llama::utils;

class ChatTemplateUtilsTest : public ::testing::Test {
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

TEST_F(ChatTemplateUtilsTest, IsQwen3ModelWithNullptr) {
  EXPECT_FALSE(isQwen3Model(nullptr));
}

TEST_F(ChatTemplateUtilsTest, IsMedPsyModelWithNullptr) {
  EXPECT_FALSE(isMedPsyModel(nullptr));
}

TEST_F(ChatTemplateUtilsTest, IsMedPsyBasenameEmpty) {
  EXPECT_FALSE(isMedPsyBasename(std::string_view{}));
  EXPECT_FALSE(isMedPsyBasename(""));
}

TEST_F(ChatTemplateUtilsTest, IsMedPsyBasenameExactMatch) {
  EXPECT_TRUE(isMedPsyBasename("MedPsy"));
}

TEST_F(ChatTemplateUtilsTest, IsMedPsyBasenameCaseInsensitive) {
  EXPECT_TRUE(isMedPsyBasename("medpsy"));
  EXPECT_TRUE(isMedPsyBasename("MEDPSY"));
  EXPECT_TRUE(isMedPsyBasename("MedPSY"));
}

TEST_F(ChatTemplateUtilsTest, IsMedPsyBasenameRejectsOtherNames) {
  EXPECT_FALSE(isMedPsyBasename("Qwen3"));
  EXPECT_FALSE(isMedPsyBasename("Llama-3.1"));
  EXPECT_FALSE(isMedPsyBasename("MedPsy-7B"));
  EXPECT_FALSE(isMedPsyBasename("NotMedPsy"));
}

TEST_F(
    ChatTemplateUtilsTest, SupportsToolsCompactForModelMetadataByArchitecture) {
  EXPECT_TRUE(supportsToolsCompactForModelMetadata(std::string("qwen3")));
  EXPECT_FALSE(supportsToolsCompactForModelMetadata(std::string("qwen35")));
  EXPECT_FALSE(supportsToolsCompactForModelMetadata(std::string("llama")));
  EXPECT_FALSE(supportsToolsCompactForModelMetadata(std::nullopt));
}

TEST_F(
    ChatTemplateUtilsTest,
    SelectToolsCompactMarkerForModelMetadataUsesArchitecture) {
  auto markerFromArch =
      selectToolsCompactMarkerForModelMetadata(std::string("qwen3"));
  ASSERT_TRUE(markerFromArch.has_value());
  EXPECT_EQ(markerFromArch.value(), "<tool_call>");

  EXPECT_FALSE(selectToolsCompactMarkerForModelMetadata(std::string("qwen35"))
                   .has_value());
  EXPECT_FALSE(selectToolsCompactMarkerForModelMetadata(std::string("llama"))
                   .has_value());
  EXPECT_FALSE(
      selectToolsCompactMarkerForModelMetadata(std::nullopt).has_value());
}

TEST_F(
    ChatTemplateUtilsTest,
    GetChatTemplateForModelWithManualOverrideToolsCompactFalse) {
  std::string manual_override = "custom template";
  std::string result = getChatTemplateForModel(nullptr, manual_override, false);
  EXPECT_EQ(result, manual_override);
}

TEST_F(
    ChatTemplateUtilsTest,
    GetChatTemplateForModelWithManualOverrideToolsCompactTrue) {
  std::string manual_override = "custom template";
  std::string result = getChatTemplateForModel(nullptr, manual_override, true);
  EXPECT_EQ(result, manual_override);
}

TEST_F(
    ChatTemplateUtilsTest,
    GetChatTemplateForModelEmptyOverrideNullptrToolsCompactFalse) {
  std::string result = getChatTemplateForModel(nullptr, "", false);
  EXPECT_EQ(result, "");
}

TEST_F(
    ChatTemplateUtilsTest,
    GetChatTemplateForModelEmptyOverrideNullptrToolsCompactTrue) {
  std::string result = getChatTemplateForModel(nullptr, "", true);
  EXPECT_EQ(result, "");
}

TEST_F(ChatTemplateUtilsTest, GetChatTemplateWithNullptrModel) {
  common_params params;
  params.chat_template = "test template";
  params.use_jinja = false;

  std::string result = getChatTemplate(nullptr, params, false);
  EXPECT_EQ(result, params.chat_template);
}

TEST_F(ChatTemplateUtilsTest, GetChatTemplateJinjaDisabled) {
  common_params params;
  params.chat_template = "test template";
  params.use_jinja = false;

  std::string result = getChatTemplate(nullptr, params, false);
  EXPECT_EQ(result, "test template");
}

TEST_F(ChatTemplateUtilsTest, GetChatTemplateJinjaEnabledWithOverride) {
  common_params params;
  params.chat_template = "custom template";
  params.use_jinja = true;

  std::string result = getChatTemplate(nullptr, params, false);
  EXPECT_EQ(result, "custom template");
}

TEST_F(ChatTemplateUtilsTest, GetChatTemplateJinjaEnabledWithoutOverride) {
  common_params params;
  params.chat_template = "";
  params.use_jinja = true;

  std::string result = getChatTemplate(nullptr, params, false);
  EXPECT_EQ(result, "");
}

TEST_F(ChatTemplateUtilsTest, GetChatTemplateParamsNotModified) {
  common_params params;
  params.chat_template = "original template";
  params.use_jinja = false;

  std::string result = getChatTemplate(nullptr, params, false);

  EXPECT_EQ(params.chat_template, "original template");
  EXPECT_FALSE(params.use_jinja);
  EXPECT_EQ(result, "original template");
}

TEST_F(ChatTemplateUtilsTest, GetChatTemplateForModelPreservesWhitespace) {
  std::string overrideWithSpaces = "  template with spaces  ";
  std::string result =
      getChatTemplateForModel(nullptr, overrideWithSpaces, false);
  EXPECT_EQ(result, overrideWithSpaces);
}

TEST_F(
    ChatTemplateUtilsTest, GetChatTemplateForModelPreservesSpecialCharacters) {
  std::string overrideSpecial = "template\nwith\tspecial\rchars";
  std::string result = getChatTemplateForModel(nullptr, overrideSpecial, false);
  EXPECT_EQ(result, overrideSpecial);
}

TEST_F(ChatTemplateUtilsTest, GetFixedQwen3TemplateNotNull) {
  const char* expectedTemplate = getFixedQwen3Template();
  ASSERT_NE(expectedTemplate, nullptr);
  EXPECT_GT(strlen(expectedTemplate), 0u);
}

TEST_F(ChatTemplateUtilsTest, GetToolsDynamicQwen3TemplateNotNull) {
  const char* expectedTemplate = getToolsDynamicQwen3Template();
  ASSERT_NE(expectedTemplate, nullptr);
  EXPECT_GT(strlen(expectedTemplate), 0u);
}

TEST_F(ChatTemplateUtilsTest, TemplatesAreDifferent) {
  const char* fixedTemplate = getFixedQwen3Template();
  const char* dynamicTemplate = getToolsDynamicQwen3Template();
  ASSERT_NE(fixedTemplate, nullptr);
  ASSERT_NE(dynamicTemplate, nullptr);
  EXPECT_STRNE(fixedTemplate, dynamicTemplate);
}

TEST_F(ChatTemplateUtilsTest, ManualOverrideTakesPrecedenceOverToolsCompact) {
  common_params params;
  params.chat_template = "my_custom_template";
  params.use_jinja = true;

  std::string result = getChatTemplate(nullptr, params, true);
  EXPECT_EQ(result, "my_custom_template");
}

TEST_F(
    ChatTemplateUtilsTest, ManualOverrideTakesPrecedenceOverToolsCompactFalse) {
  common_params params;
  params.chat_template = "my_custom_template";
  params.use_jinja = true;

  std::string result = getChatTemplate(nullptr, params, false);
  EXPECT_EQ(result, "my_custom_template");
}

TEST_F(ChatTemplateUtilsTest, GetPromptExportsQwenThinkingMetadata) {
  common_chat_templates_ptr tmpls =
      common_chat_templates_init(nullptr, getFixedQwen3Template());
  ASSERT_NE(tmpls, nullptr);

  common_chat_templates_inputs inputs;
  inputs.use_jinja = true;
  inputs.enable_thinking = true;
  inputs.add_generation_prompt = true;
  inputs.messages = {common_chat_msg{
      /* role = */ "user",
      /* content = */ "What is the capital of France?",
  }};

  bool thinkingForcedOpen = true;
  std::string thinkingStartTag;
  std::string thinkingEndTag;
  std::string generationPrompt;
  const std::string prompt = getPrompt(
      tmpls.get(),
      inputs,
      &thinkingForcedOpen,
      &thinkingStartTag,
      &thinkingEndTag,
      &generationPrompt);

  EXPECT_NE(prompt.find("<|im_start|>assistant"), std::string::npos);
  EXPECT_EQ(thinkingStartTag, "<think>\n");
  EXPECT_EQ(thinkingEndTag, "\n</think>\n\n");
  EXPECT_NE(generationPrompt.find("<|im_start|>assistant"), std::string::npos);
  EXPECT_FALSE(thinkingForcedOpen);
}

TEST_F(ChatTemplateUtilsTest, ThinkingForcedOpenTextUsesTemplateSuffix) {
  EXPECT_EQ(
      getThinkingForcedOpenText("<|assistant|>\n<reason>\n", "<reason>"),
      "<reason>\n");
}

TEST_F(ChatTemplateUtilsTest, ThinkingForcedOpenTextFallsBackToStartTag) {
  EXPECT_EQ(
      getThinkingForcedOpenText("<|assistant|>\n", "<reason>"), "<reason>");
}

TEST_F(ChatTemplateUtilsTest, ThinkingForcedOpenTextEmptyWithoutStartTag) {
  EXPECT_EQ(getThinkingForcedOpenText("<|assistant|>\n", ""), "");
}
