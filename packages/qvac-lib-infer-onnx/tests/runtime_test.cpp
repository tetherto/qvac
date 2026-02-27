#include <gtest/gtest.h>

#include "qvac-onnx/OnnxRuntime.hpp"

namespace oa = onnx_addon;

TEST(OnnxRuntimeTest, SingletonReturnsSameInstance) {
  auto& inst1 = oa::OnnxRuntime::instance();
  auto& inst2 = oa::OnnxRuntime::instance();
  EXPECT_EQ(&inst1, &inst2);
}

TEST(OnnxRuntimeTest, EnvReturnsSameReference) {
  auto& env1 = oa::OnnxRuntime::instance().env();
  auto& env2 = oa::OnnxRuntime::instance().env();
  EXPECT_EQ(&env1, &env2);
}

TEST(OnnxRuntimeTest, EnvIsNotNull) {
  auto& env = oa::OnnxRuntime::instance().env();
  // Ort::Env is valid if we can query available providers through it
  // (there's no direct "isValid" on Env, but GetAvailableProviders uses the
  // global ORT API which requires a valid environment to be initialized)
  auto providers = Ort::GetAvailableProviders();
  EXPECT_FALSE(providers.empty());
  // CPUExecutionProvider is always available
  EXPECT_NE(std::find(providers.begin(), providers.end(),
                       "CPUExecutionProvider"),
             providers.end());
}
