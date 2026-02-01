#include <string>
#include <unordered_map>

#include <gtest/gtest.h>
#include <llama.h>

#include "model-interface/logging.h"

using namespace qvac_lib_infer_llamacpp_embed::logging;
using namespace qvac_lib_inference_addon_cpp::logger;

class LoggingTest : public ::testing::Test {
protected:
  void SetUp() override { g_verbosityLevel = Priority::ERROR; }

  void TearDown() override { g_verbosityLevel = Priority::ERROR; }
};

TEST_F(LoggingTest, SetVerbosityLevel0) {
  std::unordered_map<std::string, std::string> config;
  config["verbosity"] = "0";

  SetVerbosityLevel(config);

  EXPECT_EQ(g_verbosityLevel, Priority::ERROR);
  EXPECT_EQ(config.find("verbosity"), config.end());
}

TEST_F(LoggingTest, SetVerbosityLevel1) {
  std::unordered_map<std::string, std::string> config;
  config["verbosity"] = "1";

  SetVerbosityLevel(config);

  EXPECT_EQ(g_verbosityLevel, Priority::WARNING);
  EXPECT_EQ(config.find("verbosity"), config.end());
}

TEST_F(LoggingTest, SetVerbosityLevel2) {
  std::unordered_map<std::string, std::string> config;
  config["verbosity"] = "2";

  SetVerbosityLevel(config);

  EXPECT_EQ(g_verbosityLevel, Priority::INFO);
  EXPECT_EQ(config.find("verbosity"), config.end());
}

TEST_F(LoggingTest, SetVerbosityLevel3) {
  std::unordered_map<std::string, std::string> config;
  config["verbosity"] = "3";

  SetVerbosityLevel(config);

  EXPECT_EQ(g_verbosityLevel, Priority::DEBUG);
  EXPECT_EQ(config.find("verbosity"), config.end());
}

TEST_F(LoggingTest, SetVerbosityLevelMissingKey) {
  std::unordered_map<std::string, std::string> config;
  config["other_key"] = "value";

  Priority originalLevel = g_verbosityLevel;
  SetVerbosityLevel(config);

  EXPECT_EQ(g_verbosityLevel, originalLevel);
  EXPECT_NE(config.find("other_key"), config.end());
}

TEST_F(LoggingTest, SetVerbosityLevelEmptyMap) {
  std::unordered_map<std::string, std::string> config;

  Priority originalLevel = g_verbosityLevel;
  SetVerbosityLevel(config);

  EXPECT_EQ(g_verbosityLevel, originalLevel);
  EXPECT_TRUE(config.empty());
}

TEST_F(LoggingTest, SetVerbosityLevelInvalidNegative) {
  std::unordered_map<std::string, std::string> config;
  config["verbosity"] = "-1";

  SetVerbosityLevel(config);

  EXPECT_EQ(g_verbosityLevel, Priority::ERROR);
  EXPECT_NE(config.find("verbosity"), config.end());
}

TEST_F(LoggingTest, SetVerbosityLevelInvalidTooHigh) {
  std::unordered_map<std::string, std::string> config;
  config["verbosity"] = "4";

  SetVerbosityLevel(config);

  EXPECT_EQ(g_verbosityLevel, Priority::ERROR);
  EXPECT_NE(config.find("verbosity"), config.end());
}

TEST_F(LoggingTest, SetVerbosityLevelNonNumeric) {
  std::unordered_map<std::string, std::string> config;
  config["verbosity"] = "invalid";

  SetVerbosityLevel(config);

  EXPECT_EQ(g_verbosityLevel, Priority::ERROR);
  EXPECT_EQ(config.find("verbosity"), config.end());
}

TEST_F(LoggingTest, SetVerbosityLevelEmptyString) {
  std::unordered_map<std::string, std::string> config;
  config["verbosity"] = "";

  SetVerbosityLevel(config);

  EXPECT_EQ(g_verbosityLevel, Priority::ERROR);
  EXPECT_EQ(config.find("verbosity"), config.end());
}

TEST_F(LoggingTest, VerbosityLevelPersistence) {
  std::unordered_map<std::string, std::string> config1;
  config1["verbosity"] = "2";
  SetVerbosityLevel(config1);
  EXPECT_EQ(g_verbosityLevel, Priority::INFO);

  std::unordered_map<std::string, std::string> config2;
  config2["verbosity"] = "3";
  SetVerbosityLevel(config2);
  EXPECT_EQ(g_verbosityLevel, Priority::DEBUG);
}

TEST_F(LoggingTest, DefaultVerbosityLevel) {
  EXPECT_EQ(g_verbosityLevel, Priority::ERROR);
}

TEST_F(LoggingTest, LlamaLogCallbackError) {
  EXPECT_NO_THROW({
    llamaLogCallback(GGML_LOG_LEVEL_ERROR, "Test error message", nullptr);
  });
}

TEST_F(LoggingTest, LlamaLogCallbackWarn) {
  EXPECT_NO_THROW({
    llamaLogCallback(GGML_LOG_LEVEL_WARN, "Test warning message", nullptr);
  });
}

TEST_F(LoggingTest, LlamaLogCallbackInfo) {
  EXPECT_NO_THROW(
      { llamaLogCallback(GGML_LOG_LEVEL_INFO, "Test info message", nullptr); });
}

TEST_F(LoggingTest, LlamaLogCallbackDebug) {
  EXPECT_NO_THROW({
    llamaLogCallback(GGML_LOG_LEVEL_DEBUG, "Test debug message", nullptr);
  });
}

TEST_F(LoggingTest, LlamaLogCallbackNone) {
  EXPECT_NO_THROW(
      { llamaLogCallback(GGML_LOG_LEVEL_NONE, "Test none message", nullptr); });
}

TEST_F(LoggingTest, LlamaLogCallbackCont) {
  EXPECT_NO_THROW(
      { llamaLogCallback(GGML_LOG_LEVEL_CONT, "Test cont message", nullptr); });
}

TEST_F(LoggingTest, LlamaLogCallbackNullText) {
  EXPECT_NO_THROW({ llamaLogCallback(GGML_LOG_LEVEL_INFO, nullptr, nullptr); });
}
