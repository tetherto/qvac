#include "NeuralProcessor.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <fstream>
#include <stdexcept>
#include <thread>
#include <vector>

#include "addon/BCIErrors.hpp"
#include "inference-addon-cpp/Logger.hpp"

namespace qvac_lib_inference_addon_bci {

namespace {
constexpr size_t K_HEADER_BYTES = 8;
constexpr uint32_t K_EMBEDDER_MAGIC = 0x42434945;

constexpr uint32_t K_MIN_PARALLEL_TIMESTEPS = 64;
constexpr unsigned K_MAX_PREPROC_THREADS = 8;

unsigned resolveTimestepWorkerCount(uint32_t numTimesteps) {
  const unsigned hardware = std::thread::hardware_concurrency();
  const unsigned capped =
      (hardware == 0) ? 1U : std::min(hardware, K_MAX_PREPROC_THREADS);
  if (capped <= 1 || numTimesteps < K_MIN_PARALLEL_TIMESTEPS) {
    return 1U;
  }
  return std::min<unsigned>(capped, numTimesteps);
}

template <typename Body>
void spawnTimestepWorkers(
    uint32_t numTimesteps, uint32_t chunk, unsigned numThreads,
    const Body& body) {
  std::vector<std::thread> workers;
  workers.reserve(numThreads - 1);
  for (unsigned t = 1; t < numThreads; ++t) {
    const uint32_t begin = std::min(numTimesteps, t * chunk);
    const uint32_t end = std::min(numTimesteps, begin + chunk);
    if (begin >= end) {
      break;
    }
    workers.emplace_back([&body, begin, end]() { body(begin, end); });
  }
  body(0U, std::min(numTimesteps, chunk));
  for (auto& worker : workers) {
    worker.join();
  }
}

template <typename Body>
void forEachTimestepBand(uint32_t numTimesteps, const Body& body) {
  const unsigned numThreads = resolveTimestepWorkerCount(numTimesteps);
  if (numThreads <= 1) {
    body(0U, numTimesteps);
    return;
  }
  const uint32_t chunk = (numTimesteps + numThreads - 1) / numThreads;
  spawnTimestepWorkers(numTimesteps, chunk, numThreads, body);
}

void addScaledRow(float* out, const float* src, float scale, uint32_t count) {
  for (uint32_t i = 0; i < count; ++i) {
    out[i] += src[i] * scale;
  }
}

void copyRow(float* out, const float* src, uint32_t count) {
  for (uint32_t i = 0; i < count; ++i) {
    out[i] = src[i];
  }
}

void applySoftsignRow(float* out, uint32_t count) {
  for (uint32_t i = 0; i < count; ++i) {
    const float value = out[i];
    out[i] = value / (1.0F + std::abs(value));
  }
}

void projectTimestepRow(
    float* out, const float* features, const std::vector<float>& projectionW,
    const std::vector<float>& projectionBias, uint32_t nf) {
  copyRow(out, projectionBias.data(), nf);
  for (uint32_t d = 0; d < nf; ++d) {
    const float* weightRow = &projectionW[static_cast<size_t>(d) * nf];
    addScaledRow(out, weightRow, features[d], nf);
  }
  applySoftsignRow(out, nf);
}

void smoothTimestepRow(
    float* out, const std::vector<float>& data, uint32_t numTimesteps,
    uint32_t numChannels, const std::vector<float>& kernel, int halfK,
    uint32_t t) {
  const int kernelTaps = static_cast<int>(kernel.size());
  for (int k = 0; k < kernelTaps; ++k) {
    const int srcT = static_cast<int>(t) + k - halfK;
    if (srcT < 0 || srcT >= static_cast<int>(numTimesteps)) {
      continue;
    }
    const float* src = &data[static_cast<size_t>(srcT) * numChannels];
    addScaledRow(out, src, kernel[k], numChannels);
  }
}

// Kernel-trim threshold used by gaussianSmooth: values below this are
// considered numerically negligible and trimmed from the ends of the kernel
// so the convolution loop touches fewer source timesteps. Matches the
// BrainWhisperer Python reference.
constexpr float K_KERNEL_TRIM_THRESHOLD = 0.01F;

// Default Gaussian smoothing parameters matching the BrainWhisperer Python
// notebook. These are the σ and kernel width used for temporal smoothing of
// the raw neural signal before day-projection and mel padding.
constexpr float K_SMOOTH_KERNEL_STD = 2.0F;
constexpr int K_SMOOTH_KERNEL_SIZE = 100;

bool hasExpectedSize(const std::vector<float>& vec, size_t expected) {
  return vec.size() == expected;
}
} // namespace

NeuralProcessor::NeuralProcessor() = default;

bool NeuralProcessor::loadEmbedderWeights(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  if (!f.is_open()) return false;

  // A truncated/corrupt embedder file would otherwise silently load as
  // zeros and produce garbage output at inference time. Check f.good()
  // after every read and bail out cleanly so the caller reports the file
  // as missing / invalid instead of the model emitting nonsense.
  bool readFailed = false;

  auto readU32 = [&]() -> uint32_t {
    uint32_t v = 0;
    f.read(reinterpret_cast<char*>(&v), sizeof(v));
    if (!f) readFailed = true;
    return v;
  };
  auto readFloats = [&](size_t count) -> std::vector<float> {
    std::vector<float> data(count);
    if (count > 0) {
      f.read(reinterpret_cast<char*>(data.data()),
             static_cast<std::streamsize>(count * sizeof(float)));
      if (!f) readFailed = true;
    }
    return data;
  };
  auto readInts = [&](size_t count) -> std::vector<int32_t> {
    std::vector<int32_t> data(count);
    if (count > 0) {
      f.read(reinterpret_cast<char*>(data.data()),
             static_cast<std::streamsize>(count * sizeof(int32_t)));
      if (!f) readFailed = true;
    }
    return data;
  };

  if (readU32() != K_EMBEDDER_MAGIC || readU32() != 1 || readFailed) {
    return false;
  }

  weights_.numFeatures = readU32();
  /*embedDim=*/ readU32();
  /*kernelSize1=*/ readU32();
  /*kernelSize2=*/ readU32();
  /*stride2=*/ readU32();
  weights_.numDays = readU32();
  weights_.numMonths = readU32();
  weights_.r = readU32();
  if (readFailed) return false;

  // Skip conv1/conv2 weights (handled by GGML model)
  uint32_t n = readU32(); readFloats(n);
  n = readU32(); readFloats(n);
  n = readU32(); readFloats(n);
  n = readU32(); readFloats(n);
  if (readFailed) return false;

  n = readU32();
  weights_.sessionToDayMap = readInts(n);
  if (readFailed) return false;

  weights_.dayAs.resize(weights_.numDays);
  weights_.dayBs.resize(weights_.numDays);
  weights_.dayBiases.resize(weights_.numDays);
  for (uint32_t i = 0; i < weights_.numDays; ++i) {
    n = readU32(); weights_.dayAs[i] = readFloats(n);
    n = readU32(); weights_.dayBs[i] = readFloats(n);
    n = readU32(); weights_.dayBiases[i] = readFloats(n);
    if (readFailed) return false;
  }

  weights_.monthWeights.resize(weights_.numMonths);
  weights_.monthBiases.resize(weights_.numMonths);
  for (uint32_t i = 0; i < weights_.numMonths; ++i) {
    n = readU32(); weights_.monthWeights[i] = readFloats(n);
    n = readU32(); weights_.monthBiases[i] = readFloats(n);
    if (readFailed) return false;
  }

  const size_t nf = static_cast<size_t>(weights_.numFeatures);
  const size_t r = static_cast<size_t>(weights_.r);
  const size_t expectedDayA = nf * r;
  const size_t expectedDayB = r * nf;
  const size_t expectedDayBias = nf;
  const size_t expectedMonthW = nf * nf;

  for (uint32_t i = 0; i < weights_.numDays; ++i) {
    if (!hasExpectedSize(weights_.dayAs[i], expectedDayA) ||
        !hasExpectedSize(weights_.dayBs[i], expectedDayB) ||
        !hasExpectedSize(weights_.dayBiases[i], expectedDayBias)) {
      return false;
    }
  }

  for (uint32_t i = 0; i < weights_.numMonths; ++i) {
    if (!hasExpectedSize(weights_.monthWeights[i], expectedMonthW) ||
        !hasExpectedSize(weights_.monthBiases[i], expectedDayBias)) {
      return false;
    }
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
  while (start < end && kernel[start] < K_KERNEL_TRIM_THRESHOLD) ++start;
  while (end > start && kernel[end] < K_KERNEL_TRIM_THRESHOLD) --end;
  std::vector<float> trimK(kernel.begin() + start, kernel.begin() + end + 1);
  const int halfK = static_cast<int>(trimK.size()) / 2;

  std::vector<float> result(data.size(), 0.0F);
  for (uint32_t t = 0; t < numTimesteps; ++t) {
    float* out = &result[static_cast<size_t>(t) * numChannels];
    smoothTimestepRow(out, data, numTimesteps, numChannels, trimK, halfK, t);
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

  // Rebuild the dense projection only when the resolved day index changes.
  // Materializing dayDelta + W costs O(nf*nf*r) + O(nf*nf); for nf=512,r=8
  // that is ~2M + 0.25M multiplies per recompute.
  if (di != cachedDayIdx_ ||
      cachedProjectionW_.size() != static_cast<size_t>(nf) * nf ||
      cachedProjectionBias_.size() != nf) {
    const auto& dayA = weights_.dayAs[di];
    const auto& dayB = weights_.dayBs[di];
    const auto& dayBias = weights_.dayBiases[di];

    cachedProjectionW_.assign(static_cast<size_t>(nf) * nf, 0.0F);
    cachedProjectionBias_.assign(nf, 0.0F);

    for (uint32_t i = 0; i < nf; ++i) {
      for (uint32_t j = 0; j < nf; ++j) {
        float s = 0.0F;
        for (uint32_t k = 0; k < r; ++k) {
          s += dayA[i * r + k] * dayB[k * nf + j];
        }
        cachedProjectionW_[i * nf + j] = s;
      }
    }

    int monthIdx = di / 30;
    bool hasMonth =
        (monthIdx < static_cast<int>(weights_.monthWeights.size()) &&
         !weights_.monthWeights[monthIdx].empty());
    if (hasMonth) {
      const auto& mw = weights_.monthWeights[monthIdx];
      for (uint32_t i = 0; i < nf * nf; ++i) {
        cachedProjectionW_[i] += mw[i];
      }
    }

    for (uint32_t i = 0; i < nf; ++i) {
      cachedProjectionBias_[i] = dayBias[i];
      if (hasMonth && i < weights_.monthBiases[monthIdx].size()) {
        cachedProjectionBias_[i] += weights_.monthBiases[monthIdx][i];
      }
    }

    cachedDayIdx_ = di;
  }

  const auto& projectionW = cachedProjectionW_;
  const auto& projectionBias = cachedProjectionBias_;

  std::vector<float> output(static_cast<size_t>(numTimesteps) * nf);
  forEachTimestepBand(numTimesteps, [&](uint32_t tBegin, uint32_t tEnd) {
    for (uint32_t t = tBegin; t < tEnd; ++t) {
      float* out = &output[static_cast<size_t>(t) * nf];
      const float* feat = &features[static_cast<size_t>(t) * numChannels];
      projectTimestepRow(out, feat, projectionW, projectionBias, nf);
    }
  });

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

  auto smoothed = gaussianSmooth(
      features, numTimesteps, numChannels,
      K_SMOOTH_KERNEL_STD, K_SMOOTH_KERNEL_SIZE);

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
