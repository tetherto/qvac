#include <gtest/gtest.h>

#include "qvac-onnx/OnnxSessionOptionsBuilder.hpp"

// Do not use "using namespace onnx_addon" here because the ORT C API
// defines a global GraphOptimizationLevel typedef that collides with
// onnx_addon::GraphOptimizationLevel.
namespace oa = onnx_addon;

TEST(SessionOptionsTest, CpuProviderReturnsValidOptions) {
  oa::SessionConfig config{.provider = oa::ExecutionProvider::CPU};
  auto options = oa::buildSessionOptions(config);
  // If we get here without throwing, the options are valid
  SUCCEED();
}

TEST(SessionOptionsTest, AutoGpuProviderReturnsValidOptions) {
  oa::SessionConfig config{.provider = oa::ExecutionProvider::AUTO_GPU};
  auto options = oa::buildSessionOptions(config);
  SUCCEED();
}

TEST(SessionOptionsTest, DefaultConfigReturnsValidOptions) {
  oa::SessionConfig config;
  auto options = oa::buildSessionOptions(config);
  SUCCEED();
}

TEST(SessionOptionsTest, AllOptimizationLevels) {
  for (auto level : {oa::GraphOptimizationLevel::DISABLE,
                     oa::GraphOptimizationLevel::BASIC,
                     oa::GraphOptimizationLevel::EXTENDED,
                     oa::GraphOptimizationLevel::ALL}) {
    oa::SessionConfig config{
        .provider = oa::ExecutionProvider::CPU, .optimization = level};
    auto options = oa::buildSessionOptions(config);
    SUCCEED();
  }
}

TEST(SessionOptionsTest, CustomThreadCounts) {
  oa::SessionConfig config{
      .provider = oa::ExecutionProvider::CPU,
      .intraOpThreads = 2,
      .interOpThreads = 1};
  auto options = oa::buildSessionOptions(config);
  SUCCEED();
}

TEST(SessionOptionsTest, XnnpackEnabledDoesNotThrow) {
  oa::SessionConfig config{
      .provider = oa::ExecutionProvider::CPU, .enableXnnpack = true};
  EXPECT_NO_THROW(oa::buildSessionOptions(config));
}

TEST(SessionOptionsTest, XnnpackDisabledDoesNotThrow) {
  oa::SessionConfig config{
      .provider = oa::ExecutionProvider::CPU, .enableXnnpack = false};
  EXPECT_NO_THROW(oa::buildSessionOptions(config));
}

TEST(SessionOptionsTest, TryAppendXnnpackDoesNotThrow) {
  Ort::SessionOptions options;
  EXPECT_NO_THROW(oa::tryAppendXnnpack(options));
}

TEST(SessionOptionsTest, XnnpackWithAutoGpuDoesNotThrow) {
  oa::SessionConfig config{
      .provider = oa::ExecutionProvider::AUTO_GPU, .enableXnnpack = true};
  EXPECT_NO_THROW(oa::buildSessionOptions(config));
}

TEST(SessionOptionsTest, AllProvidersDoNotThrow) {
  for (auto provider :
       {oa::ExecutionProvider::CPU, oa::ExecutionProvider::AUTO_GPU,
        oa::ExecutionProvider::NNAPI, oa::ExecutionProvider::CoreML,
        oa::ExecutionProvider::DirectML}) {
    oa::SessionConfig config{.provider = provider};
    EXPECT_NO_THROW(oa::buildSessionOptions(config));
  }
}
