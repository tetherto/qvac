#include "model-interface/SileroVadIterator.hpp"

#include <algorithm>
#include <cstdint>
#include <fstream>
#include <ios>
#include <iostream>
#include <stdexcept>
#include <vector>

#include <gtest/gtest.h>

namespace qvac_lib_inference_addon_onnx_silerovad {

std::vector<float> read_float_audio_file(const char *file_path) {
  std::ifstream file(file_path, std::ios::binary | std::ios::ate);
  if (!file.is_open()) {
    throw std::runtime_error("failed to open file");
  }

  std::streamsize size = file.tellg();
  if (size % sizeof(float) != 0) {
    throw std::runtime_error("incorrect file size");
  }

  file.seekg(0, std::ios::beg);

  std::vector<char> buffer(size);
  if (!file.read(buffer.data(), size)) {
    throw std::runtime_error("failed to read file");
  }

  const size_t audio_size = size / sizeof(float);
  std::vector<float> audio(audio_size);
  for (int i = 0; i < audio_size; i++) {
    audio[i] = *reinterpret_cast<float *>(&buffer + i * sizeof(float));
  }

  return audio;
}

TEST(VadIterator, Process) {
  VadIterator iterator("model/silerovad.onnx");

  std::vector<float> sample = read_float_audio_file("example/sample.bin");
  // Make a copy of `sample` for comparison.
  std::vector<float> original{sample};

  // Process `sample` in-place.
  iterator.process(sample);

  // Every element of `sample` is either the same as the corresponding element
  // of `original`, or is changed to 0 if no speech is detected in that segment.
  EXPECT_TRUE(
      std::equal(sample.begin(), sample.end(), original.begin(),
                 [](float s, float o) -> bool { return s == o || s == 0; }));
}

} // namespace qvac_lib_inference_addon_onnx_silerovad
