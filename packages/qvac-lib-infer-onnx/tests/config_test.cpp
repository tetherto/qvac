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
  EXPECT_TRUE(config.enableXnnpack);
}

TEST(SessionConfigTest, CustomValues) {
  SessionConfig config{
      .provider = ExecutionProvider::CPU,
      .optimization = GraphOptimizationLevel::ALL,
      .intraOpThreads = 4,
      .interOpThreads = 2,
      .enableMemoryPattern = false,
      .enableCpuMemArena = false,
      .enableXnnpack = false};

  EXPECT_EQ(config.provider, ExecutionProvider::CPU);
  EXPECT_EQ(config.optimization, GraphOptimizationLevel::ALL);
  EXPECT_EQ(config.intraOpThreads, 4);
  EXPECT_EQ(config.interOpThreads, 2);
  EXPECT_FALSE(config.enableMemoryPattern);
  EXPECT_FALSE(config.enableCpuMemArena);
  EXPECT_FALSE(config.enableXnnpack);
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
