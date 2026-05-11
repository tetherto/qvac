#include <gtest/gtest.h>

#include "qvac-onnx/OnnxConfig.hpp"

using namespace onnx_addon;

TEST(SessionConfigTest, Defaults) {
  SessionConfig config;
  EXPECT_EQ(config.provider, ExecutionProvider::AUTO_GPU);
  EXPECT_EQ(config.optimization, GraphOptimizationLevel::EXTENDED);
  EXPECT_EQ(config.intraOpThreads, 0);
  EXPECT_EQ(config.interOpThreads, 0);
  EXPECT_TRUE(config.enableMemoryPattern);
  EXPECT_TRUE(config.enableCpuMemArena);
  EXPECT_FALSE(config.enableXnnpack);
  EXPECT_EQ(config.executionMode, ExecutionMode::SEQUENTIAL);
}

TEST(SessionConfigTest, CustomValues) {
  SessionConfig config{
      .provider = ExecutionProvider::CPU,
      .optimization = GraphOptimizationLevel::ALL,
      .intraOpThreads = 4,
      .interOpThreads = 2,
      .enableMemoryPattern = false,
      .enableCpuMemArena = false,
      .enableXnnpack = false,
      .executionMode = ExecutionMode::PARALLEL};

  EXPECT_EQ(config.provider, ExecutionProvider::CPU);
  EXPECT_EQ(config.optimization, GraphOptimizationLevel::ALL);
  EXPECT_EQ(config.intraOpThreads, 4);
  EXPECT_EQ(config.interOpThreads, 2);
  EXPECT_FALSE(config.enableMemoryPattern);
  EXPECT_FALSE(config.enableCpuMemArena);
  EXPECT_FALSE(config.enableXnnpack);
  EXPECT_EQ(config.executionMode, ExecutionMode::PARALLEL);
}

TEST(ExecutionProviderTest, AllValues) {
  EXPECT_NE(ExecutionProvider::CPU, ExecutionProvider::AUTO_GPU);
  EXPECT_NE(ExecutionProvider::NNAPI, ExecutionProvider::CoreML);
  EXPECT_NE(ExecutionProvider::CoreML, ExecutionProvider::DirectML);
}

TEST(GraphOptimizationLevelTest, AllValues) {
  EXPECT_NE(GraphOptimizationLevel::DISABLE, GraphOptimizationLevel::BASIC);
  EXPECT_NE(GraphOptimizationLevel::BASIC, GraphOptimizationLevel::EXTENDED);
  EXPECT_NE(GraphOptimizationLevel::EXTENDED, GraphOptimizationLevel::ALL);
}

TEST(LoggingLevelTest, AllValues) {
  EXPECT_NE(LoggingLevel::VERBOSE, LoggingLevel::INFO);
  EXPECT_NE(LoggingLevel::INFO, LoggingLevel::WARNING);
  EXPECT_NE(LoggingLevel::WARNING, LoggingLevel::ERROR);
  EXPECT_NE(LoggingLevel::ERROR, LoggingLevel::FATAL);
}

TEST(ExecutionModeTest, AllValues) {
  EXPECT_NE(ExecutionMode::SEQUENTIAL, ExecutionMode::PARALLEL);
}

TEST(EnvironmentConfigTest, Defaults) {
  EnvironmentConfig cfg;
  EXPECT_EQ(cfg.loggingLevel, LoggingLevel::ERROR);
  EXPECT_EQ(cfg.loggingId, "qvac-onnx");
}

TEST(EnvironmentConfigTest, CustomValues) {
  EnvironmentConfig cfg{
      .loggingLevel = LoggingLevel::VERBOSE,
      .loggingId = "my-app"};
  EXPECT_EQ(cfg.loggingLevel, LoggingLevel::VERBOSE);
  EXPECT_EQ(cfg.loggingId, "my-app");
}
