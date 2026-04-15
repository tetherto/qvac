#include "NeuralProcessor.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <fstream>
#include <stdexcept>

#include "addon/BCIErrors.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

namespace qvac_lib_inference_addon_bci {

namespace {
constexpr size_t K_HEADER_BYTES = 8;
constexpr uint32_t K_EMBEDDER_MAGIC = 0x42434945;
} // namespace

NeuralProcessor::NeuralProcessor() = default;

bool NeuralProcessor::loadEmbedderWeights(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  if (!f.is_open()) return false;

  auto readU32 = [&]() -> uint32_t {
    uint32_t v = 0;
    f.read(reinterpret_cast<char*>(&v), sizeof(v));
    return v;
  };
  auto readFloats = [&](size_t count) -> std::vector<float> {
    std::vector<float> data(count);
    f.read(reinterpret_cast<char*>(data.data()),
           static_cast<std::streamsize>(count * sizeof(float)));
    return data;
  };
  auto readInts = [&](size_t count) -> std::vector<int32_t> {
    std::vector<int32_t> data(count);
    f.read(reinterpret_cast<char*>(data.data()),
           static_cast<std::streamsize>(count * sizeof(int32_t)));
    return data;
  };

  if (readU32() != K_EMBEDDER_MAGIC || readU32() != 1) return false;

  weights_.numFeatures = readU32();
  /*embedDim=*/ readU32();
  /*kernelSize1=*/ readU32();
  /*kernelSize2=*/ readU32();
  /*stride2=*/ readU32();
  weights_.numDays = readU32();
  weights_.numMonths = readU32();
  weights_.r = readU32();

  // Skip conv1/conv2 weights (handled by GGML model)
  uint32_t n = readU32(); readFloats(n);
  n = readU32(); readFloats(n);
  n = readU32(); readFloats(n);
  n = readU32(); readFloats(n);

  n = readU32();
  weights_.sessionToDayMap = readInts(n);

  weights_.dayAs.resize(weights_.numDays);
  weights_.dayBs.resize(weights_.numDays);
  weights_.dayBiases.resize(weights_.numDays);
  for (uint32_t i = 0; i < weights_.numDays; ++i) {
    n = readU32(); weights_.dayAs[i] = readFloats(n);
    n = readU32(); weights_.dayBs[i] = readFloats(n);
    n = readU32(); weights_.dayBiases[i] = readFloats(n);
  }

  weights_.monthWeights.resize(weights_.numMonths);
  weights_.monthBiases.resize(weights_.numMonths);
  for (uint32_t i = 0; i < weights_.numMonths; ++i) {
    n = readU32(); weights_.monthWeights[i] = readFloats(n);
    n = readU32(); weights_.monthBiases[i] = readFloats(n);
  }

  weights_.loaded = true;
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
       "Loaded day projection weights: " +
           std::to_string(weights_.numDays) + " days, r=" +
           std::to_string(weights_.r));
  return true;
}

std::vector<float> NeuralProcessor::gaussianSmooth(
    const std::vector<float>& data,
    uint32_t numTimesteps, uint32_t numChannels,
    float kernelStd, int kernelSize) {

  std::vector<float> kernel(kernelSize);
  const int center = kernelSize / 2;
  float sum = 0.0F;
  for (int i = 0; i < kernelSize; ++i) {
    float x = static_cast<float>(i - center);
    kernel[i] = std::exp(-0.5F * (x * x) / (kernelStd * kernelStd));
    sum += kernel[i];
  }
  for (auto& k : kernel) k /= sum;

  int start = 0, end = kernelSize - 1;
  while (start < end && kernel[start] < 0.01F) ++start;
  while (end > start && kernel[end] < 0.01F) --end;
  std::vector<float> trimK(kernel.begin() + start, kernel.begin() + end + 1);
  const int halfK = static_cast<int>(trimK.size()) / 2;

  std::vector<float> result(data.size());
  for (uint32_t c = 0; c < numChannels; ++c) {
    for (uint32_t t = 0; t < numTimesteps; ++t) {
      float val = 0.0F;
      for (int k = 0; k < static_cast<int>(trimK.size()); ++k) {
        int srcT = static_cast<int>(t) + k - halfK;
        if (srcT >= 0 && srcT < static_cast<int>(numTimesteps))
          val += data[srcT * numChannels + c] * trimK[k];
      }
      result[t * numChannels + c] = val;
    }
  }
  return result;
}

std::vector<float> NeuralProcessor::applyDayProjection(
    const std::vector<float>& features,
    uint32_t numTimesteps, uint32_t numChannels, int dayIdx) const {

  if (!weights_.loaded || weights_.r == 0) return features;

  const uint32_t nf = weights_.numFeatures;
  const uint32_t r = weights_.r;
  int di = std::clamp(dayIdx, 0, static_cast<int>(weights_.numDays) - 1);

  const auto& dayA = weights_.dayAs[di];
  const auto& dayB = weights_.dayBs[di];
  const auto& dayBias = weights_.dayBiases[di];

  std::vector<float> dayDelta(nf * nf, 0.0F);
  for (uint32_t i = 0; i < nf; ++i)
    for (uint32_t j = 0; j < nf; ++j) {
      float s = 0.0F;
      for (uint32_t k = 0; k < r; ++k)
        s += dayA[i * r + k] * dayB[k * nf + j];
      dayDelta[i * nf + j] = s;
    }

  int monthIdx = di / 30;
  bool hasMonth = (monthIdx < static_cast<int>(weights_.monthWeights.size()) &&
                   !weights_.monthWeights[monthIdx].empty());

  std::vector<float> W(nf * nf), bias(nf, 0.0F);
  for (uint32_t i = 0; i < nf * nf; ++i) {
    W[i] = dayDelta[i];
    if (hasMonth) W[i] += weights_.monthWeights[monthIdx][i];
  }
  for (uint32_t i = 0; i < nf; ++i) {
    bias[i] = dayBias[i];
    if (hasMonth && i < weights_.monthBiases[monthIdx].size())
      bias[i] += weights_.monthBiases[monthIdx][i];
  }

  // Python: output[t,k] = softsign(sum_d(features[t,d] * W[d,k]) + bias[k])
  // i.e. output = features @ W + bias (right-multiply by W)
  std::vector<float> output(numTimesteps * nf);
  for (uint32_t t = 0; t < numTimesteps; ++t)
    for (uint32_t k = 0; k < nf; ++k) {
      float s = bias[k];
      for (uint32_t d = 0; d < nf; ++d)
        s += features[t * numChannels + d] * W[d * nf + k];
      output[t * nf + k] = s / (1.0F + std::abs(s));
    }

  return output;
}

std::vector<float> NeuralProcessor::processToMel(
    const std::vector<uint8_t>& rawData, int dayIdx) const {

  if (rawData.size() < K_HEADER_BYTES) {
    throw qvac_errors::bci_error::makeStatus(
        qvac_errors::bci_error::Code::InvalidNeuralSignal,
        "Neural signal buffer too small");
  }

  uint32_t numTimesteps = 0, numChannels = 0;
  std::memcpy(&numTimesteps, rawData.data(), sizeof(uint32_t));
  std::memcpy(&numChannels, rawData.data() + sizeof(uint32_t), sizeof(uint32_t));

  size_t expectedBytes = static_cast<size_t>(numTimesteps) * numChannels * sizeof(float);
  if (rawData.size() < K_HEADER_BYTES + expectedBytes) {
    throw qvac_errors::bci_error::makeStatus(
        qvac_errors::bci_error::Code::InvalidNeuralSignal,
        "Neural signal buffer truncated");
  }

  std::vector<float> features(numTimesteps * numChannels);
  std::memcpy(features.data(), rawData.data() + K_HEADER_BYTES, expectedBytes);

  // Passthrough mode: if dayIdx == -1, skip preprocessing and treat
  // the input as pre-computed mel features in frame-major layout.
  if (dayIdx == -1) {
    const int melBins = K_WHISPER_N_MEL;
    const int melFrames = K_WHISPER_MEL_FRAMES;
    std::vector<float> melOutput(melFrames * melBins, 0.0F);
    uint32_t framesToCopy = std::min(numTimesteps, static_cast<uint32_t>(melFrames));
    uint32_t chToCopy = std::min(numChannels, static_cast<uint32_t>(melBins));
    for (uint32_t t = 0; t < framesToCopy; ++t)
      for (uint32_t c = 0; c < chToCopy; ++c)
        melOutput[c * melFrames + t] = features[t * numChannels + c];
    return melOutput;
  }

  // Step 1: Gaussian smoothing (std=2.0, kernel_size=100, matching BrainWhisperer)
  auto smoothed = gaussianSmooth(features, numTimesteps, numChannels, 2.0F, 100);

  // Step 2: Day projection (if available)
  std::vector<float> projected;
  uint32_t projChannels = numChannels;
  if (weights_.loaded && weights_.r > 0) {
    projected = applyDayProjection(smoothed, numTimesteps, numChannels, dayIdx);
    projChannels = weights_.numFeatures;
  } else {
    projected = smoothed;
  }

  // Step 3: Pad to 3000 frames at 512 channels for whisper_set_mel()
  // whisper.cpp stores mel as mel.data[mel_bin * n_len + frame] (mel-major),
  // so we must write in that layout for whisper_set_mel_with_state.
  const int melBins = K_WHISPER_N_MEL;
  const int melFrames = K_WHISPER_MEL_FRAMES;
  std::vector<float> melOutput(melFrames * melBins, 0.0F);

  uint32_t framesToCopy = std::min(numTimesteps, static_cast<uint32_t>(melFrames));
  uint32_t chToCopy = std::min(projChannels, static_cast<uint32_t>(melBins));
  for (uint32_t t = 0; t < framesToCopy; ++t)
    for (uint32_t c = 0; c < chToCopy; ++c)
      melOutput[c * melFrames + t] = projected[t * projChannels + c];

  return melOutput;
}

} // namespace qvac_lib_inference_addon_bci
