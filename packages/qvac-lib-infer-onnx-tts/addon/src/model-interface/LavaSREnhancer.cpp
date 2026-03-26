#include "LavaSREnhancer.hpp"

#include "OrtSessionFactory.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

#include <stdexcept>

using namespace qvac_lib_inference_addon_cpp::logger;

namespace qvac::ttslib::lavasr {

LavaSREnhancer::LavaSREnhancer(const std::string &backbonePath,
                               const std::string &specHeadPath)
    : backbonePath_(backbonePath), specHeadPath_(specHeadPath),
      mel_(CONFIG_SAMPLE_RATE, N_FFT, N_MELS, F_MIN, F_MAX),
      stft_(N_FFT, HOP_LENGTH, N_FFT, false) {}

LavaSREnhancer::~LavaSREnhancer() { unload(); }

void LavaSREnhancer::load() {
  if (backboneSession_ && specHeadSession_) {
    return;
  }

  Ort::SessionOptions options;
  options.SetIntraOpNumThreads(1);
  options.SetInterOpNumThreads(1);
  options.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);

  backboneSession_ = createOrtSession(backbonePath_, options);
  specHeadSession_ = createOrtSession(specHeadPath_, options);

  Ort::AllocatorWithDefaultOptions alloc;
  bbInputName_ = backboneSession_->GetInputNameAllocated(0, alloc).get();
  bbOutputName_ = backboneSession_->GetOutputNameAllocated(0, alloc).get();
  shInputName_ = specHeadSession_->GetInputNameAllocated(0, alloc).get();
  shOutputName1_ = specHeadSession_->GetOutputNameAllocated(0, alloc).get();
  shOutputName2_ = specHeadSession_->GetOutputNameAllocated(1, alloc).get();

  QLOG(Priority::INFO,
       "LavaSR enhancer loaded: " + backbonePath_ + ", " + specHeadPath_);
}

void LavaSREnhancer::unload() {
  backboneSession_.reset();
  specHeadSession_.reset();
  QLOG(Priority::INFO, "LavaSR enhancer unloaded");
}

bool LavaSREnhancer::isLoaded() const {
  return backboneSession_ != nullptr && specHeadSession_ != nullptr;
}

std::vector<float> LavaSREnhancer::enhance(const std::vector<float> &wav48k,
                                           float cutoffHz) {
  if (!isLoaded()) {
    throw std::runtime_error("LavaSR enhancer not loaded");
  }

  // Compute mel spectrogram [nMels][T]
  auto mel = mel_.melSpectrogram(wav48k, HOP_LENGTH);
  const int T = static_cast<int>(mel[0].size());

  // Flatten to [1, nMels, T] for ONNX
  std::vector<float> flatMel(N_MELS * T);
  for (int m = 0; m < N_MELS; m++) {
    for (int t = 0; t < T; t++) {
      flatMel[m * T + t] = mel[m][t];
    }
  }

  Ort::MemoryInfo memInfo =
      Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);

  // Run backbone: [1, 80, T] -> hidden features
  std::vector<int64_t> bbShape = {1, N_MELS, static_cast<int64_t>(T)};
  Ort::Value bbTensor = Ort::Value::CreateTensor<float>(
      memInfo, flatMel.data(), flatMel.size(), bbShape.data(), bbShape.size());
  const char *bbInNames[] = {bbInputName_.c_str()};
  const char *bbOutNames[] = {bbOutputName_.c_str()};

  auto bbOutTensors = backboneSession_->Run(Ort::RunOptions{nullptr}, bbInNames,
                                            &bbTensor, 1, bbOutNames, 1);

  // Run spec head: hidden -> real [F, T] + imag [F, T]
  const char *shInNames[] = {shInputName_.c_str()};
  const char *shOutNames[] = {shOutputName1_.c_str(), shOutputName2_.c_str()};

  auto shOutTensors = specHeadSession_->Run(Ort::RunOptions{nullptr}, shInNames,
                                            &bbOutTensors[0], 1, shOutNames, 2);

  float *realPtr = shOutTensors[0].GetTensorMutableData<float>();
  float *imagPtr = shOutTensors[1].GetTensorMutableData<float>();
  const int F = N_FFT / 2 + 1;

  // Reconstruct spectrogram from [F, T] layout (transposed)
  dsp::Spectrogram spec(T, std::vector<std::complex<float>>(F));
  for (int t = 0; t < T; t++) {
    for (int f = 0; f < F; f++) {
      spec[t][f] = {realPtr[f * T + t], imagPtr[f * T + t]};
    }
  }

  // ISTFT to predicted waveform
  auto enhanced = stft_.istft(spec, static_cast<int>(wav48k.size()));

  // FastLR merge: blend enhanced spectrum with original
  return dsp::FastLRMerge::merge(enhanced, wav48k, 48000,
                                 static_cast<int>(cutoffHz));
}

} // namespace qvac::ttslib::lavasr
