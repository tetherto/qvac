#include <filesystem>
#include <string>
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

TEST_F(ChatTemplateUtilsTest, SelectToolsCompactMarkerForQwen3) {
  auto marker = selectToolsCompactMarker("qwen3");
  ASSERT_TRUE(marker.has_value());
  EXPECT_EQ(marker.value(), "<tool_call>");
}

TEST_F(
    ChatTemplateUtilsTest, SelectToolsCompactMarkerForUnsupportedArchitecture) {
  EXPECT_FALSE(selectToolsCompactMarker("llama").has_value());
  EXPECT_FALSE(selectToolsCompactMarker("mistral").has_value());
  EXPECT_FALSE(selectToolsCompactMarker("gemma").has_value());
}

TEST_F(
    ChatTemplateUtilsTest, SupportsToolsCompactForModelMetadataByArchitecture) {
  EXPECT_TRUE(
      supportsToolsCompactForModelMetadata(std::string("qwen3"), std::nullopt));
  EXPECT_FALSE(
      supportsToolsCompactForModelMetadata(std::string("llama"), std::nullopt));
}

TEST_F(ChatTemplateUtilsTest, SupportsToolsCompactForModelMetadataByModelName) {
  EXPECT_TRUE(supportsToolsCompactForModelMetadata(
      std::nullopt, std::string("Qwen3-1.7B-Instruct")));
  EXPECT_TRUE(supportsToolsCompactForModelMetadata(
      std::nullopt, std::string("qwen-3-4b")));
  EXPECT_FALSE(supportsToolsCompactForModelMetadata(
      std::nullopt, std::string("Llama-3.1-8B")));
}

TEST_F(
    ChatTemplateUtilsTest,
    SelectToolsCompactMarkerForModelMetadataUsesArchitectureOrNameFallback) {
  auto markerFromArch = selectToolsCompactMarkerForModelMetadata(
      std::string("qwen3"), std::nullopt);
  ASSERT_TRUE(markerFromArch.has_value());
  EXPECT_EQ(markerFromArch.value(), "<tool_call>");

  auto markerFromName = selectToolsCompactMarkerForModelMetadata(
      std::nullopt, std::string("Qwen3-1.7B-Instruct"));
  ASSERT_TRUE(markerFromName.has_value());
  EXPECT_EQ(markerFromName.value(), "<tool_call>");

  EXPECT_FALSE(selectToolsCompactMarkerForModelMetadata(
                   std::string("llama"), std::string("Llama-3.1-8B"))
                   .has_value());
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
