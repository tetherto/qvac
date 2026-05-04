#include <common/common.h>
#include <gtest/gtest.h>

// Test that common_params default constructor sets cont_batching to true
// This verifies llama.cpp continuous batching is enabled by default
TEST(ContinuousBatchingDefault, CommonParamsDefaultContBatchingTrue) {
  common_params params;
  EXPECT_TRUE(params.cont_batching)
      << "common_params.cont_batching should default to true "
         "(llama.cpp continuous batching enabled by default)";
}

