#include <gtest/gtest.h>

#include "src/model-interface/LavaSREnhancer.hpp"

using namespace qvac::ttslib::lavasr;

TEST(LavaSREnhancerTest, ConstructionDoesNotThrow) {
  EXPECT_NO_THROW(
      LavaSREnhancer enhancer("nonexistent_bb.onnx", "nonexistent_sh.onnx"));
}

TEST(LavaSREnhancerTest, NotLoadedByDefault) {
  LavaSREnhancer enhancer("nonexistent_bb.onnx", "nonexistent_sh.onnx");
  EXPECT_FALSE(enhancer.isLoaded());
}

TEST(LavaSREnhancerTest, EnhanceThrowsWhenNotLoaded) {
  LavaSREnhancer enhancer("nonexistent_bb.onnx", "nonexistent_sh.onnx");
  std::vector<float> wav(48000, 0.5f);
  EXPECT_THROW(enhancer.enhance(wav), std::runtime_error);
}

TEST(LavaSREnhancerTest, LoadFailsWithBadPath) {
  LavaSREnhancer enhancer("nonexistent_backbone.onnx",
                          "nonexistent_spec_head.onnx");
  EXPECT_THROW(enhancer.load(), std::exception);
}
