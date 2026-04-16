#include <gtest/gtest.h>

#include "src/model-interface/LavaSRDenoiser.hpp"

using namespace qvac::ttslib::lavasr;

TEST(LavaSRDenoiserTest, ConstructionDoesNotThrow) {
  EXPECT_NO_THROW(LavaSRDenoiser denoiser("nonexistent.onnx"));
}

TEST(LavaSRDenoiserTest, NotLoadedByDefault) {
  LavaSRDenoiser denoiser("nonexistent.onnx");
  EXPECT_FALSE(denoiser.isLoaded());
}

TEST(LavaSRDenoiserTest, DenoiseThrowsWhenNotLoaded) {
  LavaSRDenoiser denoiser("nonexistent.onnx");
  std::vector<float> wav(16000, 0.5f);
  EXPECT_THROW(denoiser.denoise(wav), std::runtime_error);
}

TEST(LavaSRDenoiserTest, LoadFailsWithBadPath) {
  LavaSRDenoiser denoiser("nonexistent_model.onnx");
  EXPECT_THROW(denoiser.load(), std::exception);
}
