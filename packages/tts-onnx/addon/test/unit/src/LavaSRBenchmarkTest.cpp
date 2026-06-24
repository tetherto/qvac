#include <gtest/gtest.h>

#include "DspTestHelpers.hpp"
#include "src/model-interface/LavaSRDenoiser.hpp"
#include "src/model-interface/LavaSREnhancer.hpp"
#include "src/model-interface/dsp/Resampler.hpp"

#include <chrono>
#include <filesystem>
#include <iomanip>
#include <iostream>

using namespace qvac::ttslib;
using qvac::ttslib::test::generateSine;

namespace fs = std::filesystem;

namespace {

const std::string LAVASR_DIR = "models/lavasr";

bool lavaSRModelsExist() {
  return fs::exists(LAVASR_DIR + "/enhancer_backbone.onnx") &&
         fs::exists(LAVASR_DIR + "/enhancer_backbone.onnx.data") &&
         fs::exists(LAVASR_DIR + "/enhancer_spec_head.onnx") &&
         fs::exists(LAVASR_DIR + "/enhancer_spec_head.onnx.data") &&
         fs::exists(LAVASR_DIR + "/denoiser_core_legacy_fixed63.onnx");
}

} // namespace

TEST(LavaSRBenchmarkTest, enhancerLatencyByDuration) {
  if (!lavaSRModelsExist()) {
    GTEST_SKIP() << "LavaSR models not found in " << LAVASR_DIR;
  }

  // Warm-up: load sessions once
  auto t0 = std::chrono::high_resolution_clock::now();
  lavasr::LavaSREnhancer enhancer(LAVASR_DIR + "/enhancer_backbone.onnx",
                                  LAVASR_DIR + "/enhancer_spec_head.onnx");
  enhancer.load();
  auto t1 = std::chrono::high_resolution_clock::now();
  double loadMs = std::chrono::duration<double, std::milli>(t1 - t0).count();

  std::vector<double> durations = {1.0, 3.0, 5.0, 10.0};

  std::cout << "\n===== LavaSR Enhancer Benchmark =====" << std::endl;
  std::cout << "Load time: " << std::fixed << std::setprecision(1) << loadMs
            << " ms" << std::endl;
  std::cout << std::setw(12) << "Duration(s)" << std::setw(14) << "Process(ms)"
            << std::setw(10) << "RTF" << std::endl;
  std::cout << std::string(36, '-') << std::endl;

  for (double durSec : durations) {
    int samples48k = static_cast<int>(durSec * 48000);
    auto wav48k = generateSine(440.0f, 48000, samples48k, 0.3f);

    auto start = std::chrono::high_resolution_clock::now();
    auto enhanced = enhancer.enhance(wav48k, 4000.0f);
    auto end = std::chrono::high_resolution_clock::now();

    double processMs =
        std::chrono::duration<double, std::milli>(end - start).count();
    double rtf = processMs / (durSec * 1000.0);

    std::cout << std::setw(12) << std::fixed << std::setprecision(1) << durSec
              << std::setw(14) << std::setprecision(1) << processMs
              << std::setw(10) << std::setprecision(3) << rtf << std::endl;

    EXPECT_FALSE(enhanced.empty());
  }
  std::cout << "=====================================" << std::endl;
}

TEST(LavaSRBenchmarkTest, denoiserLatencyByDuration) {
  if (!lavaSRModelsExist()) {
    GTEST_SKIP() << "LavaSR models not found in " << LAVASR_DIR;
  }

  auto t0 = std::chrono::high_resolution_clock::now();
  lavasr::LavaSRDenoiser denoiser(LAVASR_DIR +
                                  "/denoiser_core_legacy_fixed63.onnx");
  denoiser.load();
  auto t1 = std::chrono::high_resolution_clock::now();
  double loadMs = std::chrono::duration<double, std::milli>(t1 - t0).count();

  std::vector<double> durations = {1.0, 3.0, 5.0, 10.0};

  std::cout << "\n===== LavaSR Denoiser Benchmark =====" << std::endl;
  std::cout << "Load time: " << std::fixed << std::setprecision(1) << loadMs
            << " ms" << std::endl;
  std::cout << std::setw(12) << "Duration(s)" << std::setw(14) << "Process(ms)"
            << std::setw(10) << "RTF" << std::endl;
  std::cout << std::string(36, '-') << std::endl;

  for (double durSec : durations) {
    int samples16k = static_cast<int>(durSec * 16000);
    auto wav16k = generateSine(440.0f, 16000, samples16k, 0.3f);

    auto start = std::chrono::high_resolution_clock::now();
    auto denoised = denoiser.denoise(wav16k);
    auto end = std::chrono::high_resolution_clock::now();

    double processMs =
        std::chrono::duration<double, std::milli>(end - start).count();
    double rtf = processMs / (durSec * 1000.0);

    std::cout << std::setw(12) << std::fixed << std::setprecision(1) << durSec
              << std::setw(14) << std::setprecision(1) << processMs
              << std::setw(10) << std::setprecision(3) << rtf << std::endl;

    EXPECT_FALSE(denoised.empty());
  }
  std::cout << "=====================================" << std::endl;
}

TEST(LavaSRBenchmarkTest, resamplerLatency) {
  std::vector<std::pair<int, int>> ratePairs = {
      {24000, 16000}, {16000, 48000}, {44100, 16000}, {48000, 22050}};

  std::cout << "\n===== Resampler Benchmark (5s audio) =====" << std::endl;
  std::cout << std::setw(18) << "Rate pair" << std::setw(14) << "Process(ms)"
            << std::endl;
  std::cout << std::string(32, '-') << std::endl;

  for (auto [srIn, srOut] : ratePairs) {
    int samples = srIn * 5;
    auto input = generateSine(440.0f, srIn, samples, 0.3f);

    auto start = std::chrono::high_resolution_clock::now();
    auto output = dsp::Resampler::resample(input, srIn, srOut);
    auto end = std::chrono::high_resolution_clock::now();

    double processMs =
        std::chrono::duration<double, std::milli>(end - start).count();

    std::string label = std::to_string(srIn) + "->" + std::to_string(srOut);
    std::cout << std::setw(18) << label << std::setw(14) << std::fixed
              << std::setprecision(1) << processMs << std::endl;

    EXPECT_FALSE(output.empty());
  }
  std::cout << "==========================================" << std::endl;
}
