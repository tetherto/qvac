#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <vector>

#include "addon/BCIErrors.hpp"

namespace qvac_lib_inference_addon_bci {

inline constexpr std::size_t K_NEURAL_SIGNAL_HEADER_BYTES = 8;

// Length-prefixed neural-signal layout: uint32 timesteps, uint32 channels,
// then timesteps * channels float32 samples. The same untrusted-length class
// as the NMT n_dims overflow: uint32 * uint32 * sizeof(float) can wrap
// size_t before the truncated-buffer check.
inline std::vector<float> readNeuralFeatures(
    const std::vector<uint8_t>& rawData, uint32_t& numTimesteps,
    uint32_t& numChannels) {
  if (rawData.size() < K_NEURAL_SIGNAL_HEADER_BYTES) {
    throw qvac_errors::bci_error::makeStatus(
        qvac_errors::bci_error::Code::InvalidNeuralSignal,
        "Neural signal buffer too small");
  }

  std::memcpy(&numTimesteps, rawData.data(), sizeof(uint32_t));
  std::memcpy(
      &numChannels, rawData.data() + sizeof(uint32_t), sizeof(uint32_t));

  if (numChannels != 0 &&
      numTimesteps > std::numeric_limits<std::size_t>::max() / numChannels) {
    throw qvac_errors::bci_error::makeStatus(
        qvac_errors::bci_error::Code::InvalidNeuralSignal,
        "Neural signal dimensions overflow");
  }
  const std::size_t nFloats =
      static_cast<std::size_t>(numTimesteps) * numChannels;
  if (nFloats > std::numeric_limits<std::size_t>::max() / sizeof(float)) {
    throw qvac_errors::bci_error::makeStatus(
        qvac_errors::bci_error::Code::InvalidNeuralSignal,
        "Neural signal dimensions overflow");
  }
  const std::size_t expectedBytes = nFloats * sizeof(float);
  if (rawData.size() < K_NEURAL_SIGNAL_HEADER_BYTES + expectedBytes) {
    throw qvac_errors::bci_error::makeStatus(
        qvac_errors::bci_error::Code::InvalidNeuralSignal,
        "Neural signal buffer truncated");
  }

  std::vector<float> features(nFloats);
  std::memcpy(
      features.data(), rawData.data() + K_NEURAL_SIGNAL_HEADER_BYTES,
      expectedBytes);
  return features;
}

} // namespace qvac_lib_inference_addon_bci
