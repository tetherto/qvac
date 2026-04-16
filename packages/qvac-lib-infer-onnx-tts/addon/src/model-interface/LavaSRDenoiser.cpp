#include "LavaSRDenoiser.hpp"

#include "OrtSessionFactory.hpp"
#include "dsp/DspConstants.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>

using namespace qvac_lib_inference_addon_cpp::logger;

namespace qvac::ttslib::lavasr {

namespace {

const int N_FFT = 512;
const int HOP_LEN = 256;
const int WIN_LEN = 512;
const int FREQ_BINS = N_FFT / 2 + 1; // 257

} // namespace

LavaSRDenoiser::LavaSRDenoiser(const std::string &modelPath)
    : modelPath_(modelPath), stft_(N_FFT, HOP_LEN, WIN_LEN, true) {
  buildChunkWeights();
}

LavaSRDenoiser::~LavaSRDenoiser() { unload(); }

void LavaSRDenoiser::buildChunkWeights() {
  chunkWeight_.resize(CHUNK_FRAMES);
  for (int i = 0; i < CHUNK_FRAMES; i++) {
    float w = 0.5f * (1.0f - std::cos(2.0f * static_cast<float>(dsp::PI) * i /
                                      (CHUNK_FRAMES - 1)));
    chunkWeight_[i] = std::max(w * w, 1e-4f);
  }
}

void LavaSRDenoiser::load() {
  if (session_) {
    return;
  }

  Ort::SessionOptions options;
  options.SetIntraOpNumThreads(1);
  options.SetInterOpNumThreads(1);
  // Denoiser model requires disabled ORT graph optimizations to avoid
  // incorrect results from op fusion on the fixed-length chunk architecture.
  options.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_DISABLE_ALL);

  session_ = createOrtSession(modelPath_, options);

  Ort::AllocatorWithDefaultOptions alloc;
  inputName_ = session_->GetInputNameAllocated(0, alloc).get();
  outputName_ = session_->GetOutputNameAllocated(0, alloc).get();

  QLOG(Priority::INFO, "LavaSR denoiser loaded: " + modelPath_);
}

void LavaSRDenoiser::unload() {
  session_.reset();
  QLOG(Priority::INFO, "LavaSR denoiser unloaded");
}

bool LavaSRDenoiser::isLoaded() const { return session_ != nullptr; }

std::vector<float> LavaSRDenoiser::denoise(const std::vector<float> &wav16k) {
  if (!session_) {
    throw std::runtime_error("LavaSR denoiser not loaded");
  }

  auto spec = stft_.stft(wav16k);
  const int T = static_cast<int>(spec.size());

  // Flatten spectrogram into [2, T, F] layout: real then imaginary
  std::vector<float> flatSpec(2 * T * FREQ_BINS);
  for (int t = 0; t < T; t++) {
    for (int f = 0; f < FREQ_BINS; f++) {
      flatSpec[0 * T * FREQ_BINS + t * FREQ_BINS + f] = spec[t][f].real();
      flatSpec[1 * T * FREQ_BINS + t * FREQ_BINS + f] = spec[t][f].imag();
    }
  }

  const int L = CHUNK_FRAMES;
  const int H = CHUNK_HOP_FRAMES;
  Ort::MemoryInfo memInfo =
      Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);

  if (T <= L) {
    // Short signal: single chunk, zero-padded
    std::vector<float> chunk(2 * L * FREQ_BINS, 0.0f);
    for (int c = 0; c < 2; c++) {
      for (int t = 0; t < T; t++) {
        for (int f = 0; f < FREQ_BINS; f++) {
          chunk[c * L * FREQ_BINS + t * FREQ_BINS + f] =
              flatSpec[c * T * FREQ_BINS + t * FREQ_BINS + f];
        }
      }
    }

    std::vector<int64_t> shape = {1, 2, L, FREQ_BINS};
    Ort::Value inTensor = Ort::Value::CreateTensor<float>(
        memInfo, chunk.data(), chunk.size(), shape.data(), shape.size());
    const char *inNames[] = {inputName_.c_str()};
    const char *outNames[] = {outputName_.c_str()};

    auto outTensors = session_->Run(Ort::RunOptions{nullptr}, inNames,
                                    &inTensor, 1, outNames, 1);
    float *outPtr = outTensors[0].GetTensorMutableData<float>();

    for (int c = 0; c < 2; c++) {
      for (int t = 0; t < T; t++) {
        for (int f = 0; f < FREQ_BINS; f++) {
          flatSpec[c * T * FREQ_BINS + t * FREQ_BINS + f] =
              outPtr[c * L * FREQ_BINS + t * FREQ_BINS + f];
        }
      }
    }
  } else {
    // Long signal: chunked overlap-add with squared Hann weights
    std::vector<int> starts;
    for (int s = 0; s <= T - L; s += H) {
      starts.push_back(s);
    }
    if (starts.back() != T - L) {
      starts.push_back(T - L);
    }

    std::vector<float> acc(2 * T * FREQ_BINS, 0.0f);
    std::vector<float> wacc(T, 0.0f);
    std::vector<float> chunk(2 * L * FREQ_BINS);
    std::vector<int64_t> shape = {1, 2, L, FREQ_BINS};

    for (int start : starts) {
      std::fill(chunk.begin(), chunk.end(), 0.0f);
      for (int c = 0; c < 2; c++) {
        for (int t = 0; t < L; t++) {
          for (int f = 0; f < FREQ_BINS; f++) {
            chunk[c * L * FREQ_BINS + t * FREQ_BINS + f] =
                flatSpec[c * T * FREQ_BINS + (start + t) * FREQ_BINS + f];
          }
        }
      }
      Ort::Value inTensor = Ort::Value::CreateTensor<float>(
          memInfo, chunk.data(), chunk.size(), shape.data(), shape.size());
      const char *inNames[] = {inputName_.c_str()};
      const char *outNames[] = {outputName_.c_str()};

      auto outTensors = session_->Run(Ort::RunOptions{nullptr}, inNames,
                                      &inTensor, 1, outNames, 1);
      float *outPtr = outTensors[0].GetTensorMutableData<float>();

      for (int c = 0; c < 2; c++) {
        for (int t = 0; t < L; t++) {
          for (int f = 0; f < FREQ_BINS; f++) {
            acc[c * T * FREQ_BINS + (start + t) * FREQ_BINS + f] +=
                outPtr[c * L * FREQ_BINS + t * FREQ_BINS + f] * chunkWeight_[t];
          }
        }
      }
      for (int t = 0; t < L; t++) {
        wacc[start + t] += chunkWeight_[t];
      }
    }

    for (int c = 0; c < 2; c++) {
      for (int t = 0; t < T; t++) {
        const float w = std::max(wacc[t], 1e-6f);
        for (int f = 0; f < FREQ_BINS; f++) {
          flatSpec[c * T * FREQ_BINS + t * FREQ_BINS + f] =
              acc[c * T * FREQ_BINS + t * FREQ_BINS + f] / w;
        }
      }
    }
  }

  // Reconstruct spectrogram from flat layout
  dsp::Spectrogram specEnh(T, std::vector<std::complex<float>>(FREQ_BINS));
  for (int t = 0; t < T; t++) {
    for (int f = 0; f < FREQ_BINS; f++) {
      specEnh[t][f] = {flatSpec[0 * T * FREQ_BINS + t * FREQ_BINS + f],
                       flatSpec[1 * T * FREQ_BINS + t * FREQ_BINS + f]};
    }
  }

  return stft_.istft(specEnh, static_cast<int>(wav16k.size()));
}

} // namespace qvac::ttslib::lavasr
