#include <string>

#include <gtest/gtest.h>

#include "utils/QwenTemplate.hpp"

using namespace qvac_lib_inference_addon_llama::utils;

class QwenTemplateTest : public ::testing::Test {};

TEST_F(QwenTemplateTest, ReturnsNonEmptyTemplate) {
  const char* template_str = getFixedQwen3Template();
  ASSERT_NE(template_str, nullptr);
  EXPECT_GT(std::string(template_str).length(), 0);
}

TEST_F(QwenTemplateTest, ContainsJinjaSyntax) {
  const char* template_str = getFixedQwen3Template();
  std::string template_string(template_str);

  EXPECT_NE(template_string.find("{%"), std::string::npos);
  EXPECT_NE(template_string.find("{{"), std::string::npos);
}

TEST_F(QwenTemplateTest, ContainsToolsHandling) {
  const char* template_str = getFixedQwen3Template();
  std::string template_string(template_str);

  EXPECT_NE(template_string.find("tools"), std::string::npos);
  EXPECT_NE(template_string.find("tool_call"), std::string::npos);
}

TEST_F(QwenTemplateTest, ConsistentAcrossCalls) {
  const char* template1 = getFixedQwen3Template();
  const char* template2 = getFixedQwen3Template();
  const char* template3 = getFixedQwen3Template();

  EXPECT_EQ(template1, template2);
  EXPECT_EQ(template2, template3);
  EXPECT_EQ(std::string(template1), std::string(template2));
  EXPECT_EQ(std::string(template2), std::string(template3));
}

TEST_F(QwenTemplateTest, ContainsMessageRoleHandling) {
  const char* template_str = getFixedQwen3Template();
  std::string template_string(template_str);

  EXPECT_NE(template_string.find("message.role"), std::string::npos);
  EXPECT_NE(template_string.find("user"), std::string::npos);
  EXPECT_NE(template_string.find("assistant"), std::string::npos);
  EXPECT_NE(template_string.find("system"), std::string::npos);
}
