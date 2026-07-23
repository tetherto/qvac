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

// Day indices are grouped into 30-day months to select the month-level
// correction, matching the BrainWhisperer reference.
constexpr int K_DAYS_PER_MONTH = 30;

float lowRankEntry(
    const std::vector<float>& dayA, const std::vector<float>& dayB, uint32_t i,
    uint32_t j, uint32_t nf, uint32_t r) {
  float sum = 0.0F;
  for (uint32_t k = 0; k < r; ++k) {
    sum += dayA[i * r + k] * dayB[k * nf + j];
  }
  return sum;
}

void buildLowRankRow(
    const std::vector<float>& dayA, const std::vector<float>& dayB, uint32_t i,
    uint32_t nf, uint32_t r, float* outRow) {
  for (uint32_t j = 0; j < nf; ++j) {
    outRow[j] = lowRankEntry(dayA, dayB, i, j, nf, r);
  }
}

void buildLowRankProduct(
    const std::vector<float>& dayA, const std::vector<float>& dayB, uint32_t nf,
    uint32_t r, std::vector<float>& out) {
  for (uint32_t i = 0; i < nf; ++i) {
    buildLowRankRow(dayA, dayB, i, nf, r, &out[static_cast<size_t>(i) * nf]);
  }
}

void addInPlace(
    std::vector<float>& acc, const std::vector<float>& add, size_t count) {
  for (size_t i = 0; i < count; ++i) {
    acc[i] += add[i];
  }
}

void buildProjectionBias(
    std::vector<float>& bias, const std::vector<float>& dayBias,
    const std::vector<float>* monthBias, uint32_t nf) {
  for (uint32_t i = 0; i < nf; ++i) {
    bias[i] = dayBias[i];
    if (monthBias != nullptr && i < monthBias->size()) {
      bias[i] += (*monthBias)[i];
    }
  }
}

void projectTimestepBand(
    std::vector<float>& output, const std::vector<float>& features,
    const std::vector<float>& projectionW,
    const std::vector<float>& projectionBias, uint32_t tBegin, uint32_t tEnd,
    uint32_t numChannels, uint32_t nf) {
  for (uint32_t t = tBegin; t < tEnd; ++t) {
    float* out = &output[static_cast<size_t>(t) * nf];
    const float* feat = &features[static_cast<size_t>(t) * numChannels];
    projectTimestepRow(out, feat, projectionW, projectionBias, nf);
  }
}

void copyMelFrame(
    std::vector<float>& mel, const std::vector<float>& src, uint32_t t,
    uint32_t chToCopy, uint32_t srcChannels, int melFrames) {
  for (uint32_t c = 0; c < chToCopy; ++c) {
    mel[static_cast<size_t>(c) * melFrames + t] =
        src[static_cast<size_t>(t) * srcChannels + c];
  }
}

void copyToMelMajor(
    std::vector<float>& mel, const std::vector<float>& src,
    uint32_t framesToCopy, uint32_t chToCopy, uint32_t srcChannels,
    int melFrames) {
  for (uint32_t t = 0; t < framesToCopy; ++t) {
    copyMelFrame(mel, src, t, chToCopy, srcChannels, melFrames);
  }
}

bool hasExpectedSize(const std::vector<float>& vec, size_t expected) {
  return vec.size() == expected;
}

// Sequential reader over the embedder weights file. Each read checks the
// stream so a truncated/corrupt file surfaces as `failed` instead of silently
// loading zeros and producing garbage at inference time.
struct WeightsReader {
  std::ifstream& in;
  bool failed = false;

  uint32_t u32() {
    uint32_t value = 0;
    in.read(reinterpret_cast<char*>(&value), sizeof(value));
    if (!in)
      failed = true;
    return value;
  }

  std::vector<float> floats(size_t count) {
    std::vector<float> data(count);
    if (count > 0) {
      in.read(
          reinterpret_cast<char*>(data.data()),
          static_cast<std::streamsize>(count * sizeof(float)));
      if (!in)
        failed = true;
    }
    return data;
  }

  std::vector<int32_t> ints(size_t count) {
    std::vector<int32_t> data(count);
    if (count > 0) {
      in.read(
          reinterpret_cast<char*>(data.data()),
          static_cast<std::streamsize>(count * sizeof(int32_t)));
      if (!in)
        failed = true;
    }
    return data;
  }

  std::vector<float> lengthPrefixedFloats() {
    const uint32_t count = u32();
    return floats(count);
  }
};

bool readEmbedderHeader(
    WeightsReader& reader, NeuralProcessor::EmbedderWeights& w) {
  if (reader.u32() != K_EMBEDDER_MAGIC || reader.u32() != 1 || reader.failed) {
    return false;
  }
  w.numFeatures = reader.u32();
  reader.u32(); // embedDim
  reader.u32(); // kernelSize1
  reader.u32(); // kernelSize2
  reader.u32(); // stride2
  w.numDays = reader.u32();
  w.numMonths = reader.u32();
  w.r = reader.u32();
  return !reader.failed;
}

// conv1/conv2 weights live in the file but are consumed by the GGML model.
bool skipConvWeights(WeightsReader& reader) {
  reader.lengthPrefixedFloats();
  reader.lengthPrefixedFloats();
  reader.lengthPrefixedFloats();
  reader.lengthPrefixedFloats();
  return !reader.failed;
}

void readDayWeights(
    WeightsReader& reader, NeuralProcessor::EmbedderWeights& w) {
  w.dayAs.resize(w.numDays);
  w.dayBs.resize(w.numDays);
  w.dayBiases.resize(w.numDays);
  for (uint32_t i = 0; i < w.numDays; ++i) {
    w.dayAs[i] = reader.lengthPrefixedFloats();
    w.dayBs[i] = reader.lengthPrefixedFloats();
    w.dayBiases[i] = reader.lengthPrefixedFloats();
    if (reader.failed)
      return;
  }
}

void readMonthWeights(
    WeightsReader& reader, NeuralProcessor::EmbedderWeights& w) {
  w.monthWeights.resize(w.numMonths);
  w.monthBiases.resize(w.numMonths);
  for (uint32_t i = 0; i < w.numMonths; ++i) {
    w.monthWeights[i] = reader.lengthPrefixedFloats();
    w.monthBiases[i] = reader.lengthPrefixedFloats();
    if (reader.failed)
      return;
  }
}

bool dayWeightsHaveExpectedSizes(const NeuralProcessor::EmbedderWeights& w) {
  const size_t nf = static_cast<size_t>(w.numFeatures);
  const size_t r = static_cast<size_t>(w.r);
  for (uint32_t i = 0; i < w.numDays; ++i) {
    if (!hasExpectedSize(w.dayAs[i], nf * r) ||
        !hasExpectedSize(w.dayBs[i], r * nf) ||
        !hasExpectedSize(w.dayBiases[i], nf)) {
      return false;
    }
  }
  return true;
}

bool monthWeightsHaveExpectedSizes(const NeuralProcessor::EmbedderWeights& w) {
  const size_t nf = static_cast<size_t>(w.numFeatures);
  for (uint32_t i = 0; i < w.numMonths; ++i) {
    if (!hasExpectedSize(w.monthWeights[i], nf * nf) ||
        !hasExpectedSize(w.monthBiases[i], nf)) {
      return false;
    }
  }
  return true;
}

std::vector<float> readNeuralFeatures(
    const std::vector<uint8_t>& rawData, uint32_t& numTimesteps,
    uint32_t& numChannels) {
  if (rawData.size() < K_HEADER_BYTES) {
    throw qvac_errors::bci_error::makeStatus(
        qvac_errors::bci_error::Code::InvalidNeuralSignal,
        "Neural signal buffer too small");
  }

  std::memcpy(&numTimesteps, rawData.data(), sizeof(uint32_t));
  std::memcpy(
      &numChannels, rawData.data() + sizeof(uint32_t), sizeof(uint32_t));

  const size_t expectedBytes =
      static_cast<size_t>(numTimesteps) * numChannels * sizeof(float);
  if (rawData.size() < K_HEADER_BYTES + expectedBytes) {
    throw qvac_errors::bci_error::makeStatus(
        qvac_errors::bci_error::Code::InvalidNeuralSignal,
        "Neural signal buffer truncated");
  }

  std::vector<float> features(static_cast<size_t>(numTimesteps) * numChannels);
  std::memcpy(features.data(), rawData.data() + K_HEADER_BYTES, expectedBytes);
  return features;
}

// whisper.cpp stores mel as data[mel_bin * n_len + frame] (mel-major) and
// expects a fixed K_WHISPER_MEL_FRAMES x K_WHISPER_N_MEL buffer, so the source
// features are padded and written in that layout for whisper_set_mel.
std::vector<float> buildMel(
    const std::vector<float>& src, uint32_t numTimesteps,
    uint32_t srcChannels) {
  const int melBins = NeuralProcessor::K_WHISPER_N_MEL;
  const int melFrames = NeuralProcessor::K_WHISPER_MEL_FRAMES;
  std::vector<float> mel(static_cast<size_t>(melFrames) * melBins, 0.0F);
  const uint32_t framesToCopy =
      std::min(numTimesteps, static_cast<uint32_t>(melFrames));
  const uint32_t chToCopy =
      std::min(srcChannels, static_cast<uint32_t>(melBins));
  copyToMelMajor(mel, src, framesToCopy, chToCopy, srcChannels, melFrames);
  return mel;
}
} // namespace

NeuralProcessor::NeuralProcessor() = default;

bool NeuralProcessor::loadEmbedderWeights(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  if (!f.is_open())
    return false;

  WeightsReader reader{f};
  if (!readEmbedderHeader(reader, weights_))
    return false;
  if (!skipConvWeights(reader))
    return false;

  const uint32_t sessionCount = reader.u32();
  weights_.sessionToDayMap = reader.ints(sessionCount);
  if (reader.failed)
    return false;

  readDayWeights(reader, weights_);
  if (reader.failed)
    return false;

  readMonthWeights(reader, weights_);
  if (reader.failed)
    return false;

  if (!dayWeightsHaveExpectedSizes(weights_) ||
      !monthWeightsHaveExpectedSizes(weights_)) {
    return false;
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

void NeuralProcessor::rebuildDayProjectionCache(
    int dayIndex, uint32_t nf, uint32_t r) const {
  const auto& dayA = weights_.dayAs[dayIndex];
  const auto& dayB = weights_.dayBs[dayIndex];
  const auto& dayBias = weights_.dayBiases[dayIndex];

  cachedProjectionW_.assign(static_cast<size_t>(nf) * nf, 0.0F);
  cachedProjectionBias_.assign(nf, 0.0F);
  buildLowRankProduct(dayA, dayB, nf, r, cachedProjectionW_);

  const int monthIdx = dayIndex / K_DAYS_PER_MONTH;
  const bool hasMonth =
      monthIdx < static_cast<int>(weights_.monthWeights.size()) &&
      !weights_.monthWeights[monthIdx].empty();
  if (hasMonth) {
    addInPlace(
        cachedProjectionW_,
        weights_.monthWeights[monthIdx],
        static_cast<size_t>(nf) * nf);
  }

  const std::vector<float>* monthBias =
      hasMonth ? &weights_.monthBiases[monthIdx] : nullptr;
  buildProjectionBias(cachedProjectionBias_, dayBias, monthBias, nf);

  cachedDayIdx_ = dayIndex;
}

std::vector<float> NeuralProcessor::applyDayProjection(
    const std::vector<float>& features, uint32_t numTimesteps,
    uint32_t numChannels, int dayIdx) const {
  if (!weights_.loaded || weights_.r == 0) return features;

  const uint32_t nf = weights_.numFeatures;
  const uint32_t r = weights_.r;
  const int di = std::clamp(dayIdx, 0, static_cast<int>(weights_.numDays) - 1);

  // Rebuild the dense projection only when the resolved day index changes;
  // materializing W is O(nf*nf*r), so caching keeps same-day batches cheap.
  if (di != cachedDayIdx_ ||
      cachedProjectionW_.size() != static_cast<size_t>(nf) * nf ||
      cachedProjectionBias_.size() != nf) {
    rebuildDayProjectionCache(di, nf, r);
  }

  const auto& projectionW = cachedProjectionW_;
  const auto& projectionBias = cachedProjectionBias_;

  std::vector<float> output(static_cast<size_t>(numTimesteps) * nf);
  forEachTimestepBand(numTimesteps, [&](uint32_t tBegin, uint32_t tEnd) {
    projectTimestepBand(
        output,
        features,
        projectionW,
        projectionBias,
        tBegin,
        tEnd,
        numChannels,
        nf);
  });

  return output;
}

std::vector<float> NeuralProcessor::processToMel(
    const std::vector<uint8_t>& rawData, int dayIdx) const {
  uint32_t numTimesteps = 0;
  uint32_t numChannels = 0;
  std::vector<float> features =
      readNeuralFeatures(rawData, numTimesteps, numChannels);

  // Passthrough mode: treat the input as pre-computed mel features in
  // frame-major layout and skip preprocessing.
  if (dayIdx == K_PASSTHROUGH_DAY_IDX) {
    return buildMel(features, numTimesteps, numChannels);
  }

  const std::vector<float> smoothed = gaussianSmooth(
      features,
      numTimesteps,
      numChannels,
      K_SMOOTH_KERNEL_STD,
      K_SMOOTH_KERNEL_SIZE);

  uint32_t projChannels = numChannels;
  std::vector<float> projected;
  if (weights_.loaded && weights_.r > 0) {
    projected = applyDayProjection(smoothed, numTimesteps, numChannels, dayIdx);
    projChannels = weights_.numFeatures;
  } else {
    projected = smoothed;
  }

  return buildMel(projected, numTimesteps, projChannels);
}

} // namespace qvac_lib_inference_addon_bci
