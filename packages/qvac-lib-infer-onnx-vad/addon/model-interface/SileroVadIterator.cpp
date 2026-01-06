#include "SileroVadIterator.hpp"

#include <chrono>
#include <vector>
#include <cstring>
#include <iostream>
#include <memory>
#include <string>
#include <cstdio>
#include <cstdarg>
#include <array>
#include <sstream>
#include <iomanip>

// #define __DEBUG_SPEECH_PROB___

namespace qvac_lib_inference_addon_onnx_silerovad {

namespace {
constexpr int kMsPerSecond = 1000;
constexpr unsigned int kMaxSpeechSilenceFactor = 98U;
constexpr float kMicrosecondsPerMillisecondF = 1000.0F;
} // namespace
void VadIterator::handleAboveThreshold(float /*speechProb*/) {
  if (temp_end != 0) {
    temp_end = 0;
    if (next_start < prev_end) {
      next_start = static_cast<int>(current_sample - window_size_samples);
    }
  }

  if (!triggered) {
    triggered = true;
    current_speech.start = static_cast<int>(current_sample - window_size_samples);
  }

  if (first_speech_ts_ < 0.0F) {
    first_speech_ts_ = 1.0F * static_cast<float>(current_speech.start) / static_cast<float>(sample_rate);
  }

  last_silence_start_ts_ = -1.0F;
  last_silence_end_ts_ = -1.0F;
}

void VadIterator::handleExceededMaxSpeech() {
  if (prev_end > 0) {
    current_speech.end = prev_end;
    speeches.push_back(current_speech);
    current_speech = Timestamp();

    // previously reached silence(< neg_thres) and is still not speech(< thres)
    if (next_start < prev_end) {
      triggered = false;
    } else {
      current_speech.start = next_start;
    }

    prev_end = 0;
    next_start = 0;
    temp_end = 0;
  } else {
    current_speech.end = static_cast<int>(current_sample);
    speeches.push_back(current_speech);
    current_speech = Timestamp();
    prev_end = 0;
    next_start = 0;
    temp_end = 0;
    triggered = false;
  }
}

void VadIterator::handleNearThreshold(float speechProb) {
#ifdef __DEBUG_SPEECH_PROB___
  // minus window_size_samples to get precise start time point.
  float speech = current_sample - window_size_samples;
  printf("{%s: %.3f s (%.3f) %08d}\n",
         triggered ? " speeking" : "  silence",
         1.0 * speech / sample_rate,
         speechProb,
         current_sample - window_size_samples);
#endif // __DEBUG_SPEECH_PROB___
}

void VadIterator::handleBelowThreshold(float /*speechProb*/) {
  // minus window_size_samples to get precise start time point.
  auto speech = static_cast<float>(current_sample - window_size_samples - static_cast<unsigned int>(speech_pad_samples)); // NOLINT(hicpp-use-auto,modernize-use-auto)
  float curEnd = 1.0F * speech / static_cast<float>(sample_rate);
  prev_end_ = end_;
  end_ = curEnd;

  if (last_silence_start_ts_ < 0.0F) {
    last_silence_start_ts_ = curEnd;
  }
  last_silence_end_ts_ = curEnd;

#ifdef __DEBUG_SPEECH_PROB___
  printf("{      end: %.3f s (%.3f) %08d}\n",
         curEnd,
         0.0F,
         current_sample - window_size_samples);
  std::cout << "last_end == " << end_ << '\n';
#endif //__DEBUG_SPEECH_PROB___

  if (triggered) {
    if (temp_end == 0) {
      temp_end = current_sample;
    }

    if (current_sample - temp_end > min_silence_samples_at_max_speech) {
      prev_end = static_cast<int>(temp_end);
    }

    // a. silence < min_slience_samples, continue speaking
    if ((current_sample - temp_end) < min_silence_samples) {
      return;
    }
    // b. silence >= min_slience_samples, end speaking
    current_speech.end = static_cast<int>(temp_end);

    if ((current_speech.end - current_speech.start) > min_speech_samples) {
      speeches.push_back(current_speech);
      current_speech = Timestamp();
      prev_end = 0;
      next_start = 0;
      temp_end = 0;
      triggered = false;
    }
  } else {
    // may first windows see end state.
  }
}

Timestamp::Timestamp(int start, int end)
  : start(start)
  , end(end)
{
}

auto Timestamp::operator==(const Timestamp &a) const -> bool {
  return (start == a.start && end == a.end);
}

auto Timestamp::c_str() const -> std::string {
  std::ostringstream oss;
  constexpr int kPadWidth = 8;
  oss << "{start:" << std::setw(kPadWidth) << std::setfill('0') << start
      << ",end:" << std::setw(kPadWidth) << std::setfill('0') << end << "}";
  return oss.str();
}

void VadIterator::init_onnx_model(const std::string &model_path) {
  // Default engine threading and optimization
  session_options.SetIntraOpNumThreads(1);
  session_options.SetInterOpNumThreads(1);
  session_options.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);

  /* On Windows, Ort::Session's ctor takes a std::wstring */
#if defined(WIN32)
  std::wstring path { model_path.begin(), model_path.end() };
#else
  const std::string& path = model_path;
#endif

  session = std::make_shared<Ort::Session>(env, path.c_str(), session_options);
}

void VadIterator::resetStates() {
  // Call reset before each audio start
  std::memset(_h.data(), 0, _h.size() * sizeof(float));
  std::memset(_c.data(), 0, _c.size() * sizeof(float));
  triggered = false;
  temp_end = 0;
  current_sample = 0;

  prev_end = next_start = 0;

  speeches.clear();
  current_speech = Timestamp();

  first_speech_ts_ = -1.0F;
  last_silence_start_ts_ = last_silence_end_ts_ = -1.0F;
}

void VadIterator::predict(std::span<ValueType> data) {
  /* Inference */
  // Create ort tensors
  Ort::Value inputOrt = Ort::Value::CreateTensor<float>(
    memory_info, data.data(), data.size(), input_node_dims.data(), input_node_dims.size());
  Ort::Value srOrt = Ort::Value::CreateTensor<int64_t>(
    memory_info, sr.data(), sr.size(), sr_node_dims.data(), sr_node_dims.size());
  Ort::Value hOrt = Ort::Value::CreateTensor<float>(
    memory_info, _h.data(), _h.size(), hc_node_dims.data(), hc_node_dims.size());
  Ort::Value cOrt = Ort::Value::CreateTensor<float>(
    memory_info, _c.data(), _c.size(), hc_node_dims.data(), hc_node_dims.size());

  // Clear and add inputs
  ort_inputs.clear();
  ort_inputs.emplace_back(std::move(inputOrt));
  ort_inputs.emplace_back(std::move(srOrt));
  ort_inputs.emplace_back(std::move(hOrt));
  ort_inputs.emplace_back(std::move(cOrt));

  // Infer
  ort_outputs = session->Run(
  Ort::RunOptions{nullptr},
  input_node_names.data(), ort_inputs.data(), ort_inputs.size(),
  output_node_names.data(), output_node_names.size());
  
  // Output probability & update h,c recursively
  const float* outputProbPtr = ort_outputs[0].GetTensorMutableData<float>();
  float speechProb = *outputProbPtr;
  auto* hnPtr = ort_outputs[1].GetTensorMutableData<float>();
  std::memcpy(_h.data(), hnPtr, size_hc_ * sizeof(float));
  auto* cnPtr = ort_outputs[2].GetTensorMutableData<float>();
  std::memcpy(_c.data(), cnPtr, size_hc_ * sizeof(float));

  // Push forward sample index
  current_sample += window_size_samples;

  // Reset temp_end when > threshold
  if (speechProb >= threshold) {
#ifdef __DEBUG_SPEECH_PROB___
    // minus window_size_samples to get precise start time point.
    float speech = current_sample - window_size_samples;

    printf("{    start: %.3f s (%.3f) %08d}\n", 1.0 * speech / sample_rate,
            speechProb,
            (int)current_sample - window_size_samples);
#endif //__DEBUG_SPEECH_PROB___

    handleAboveThreshold(speechProb);
    return;
  }

  if (triggered && (static_cast<float>(current_sample - current_speech.start) > max_speech_samples)) {
    handleExceededMaxSpeech();
    return;
  }

  static constexpr float kThresholdEpsilon = 0.15F;
  if ((speechProb >= (threshold - kThresholdEpsilon)) && (speechProb < threshold)) {
    handleNearThreshold(speechProb);
    return;
  }

  // 4) End
  if (speechProb < (threshold - kThresholdEpsilon)) {
    handleBelowThreshold(speechProb);
    return;
  }
}

VadIterator::VadIterator(const std::string &model_path, VadConfig cfg)
  : sample_rate(cfg.sampleRate)
  , sr_per_ms(static_cast<unsigned int>(cfg.sampleRate / kMsPerSecond))
  , threshold(cfg.threshold)
  , min_speech_samples(static_cast<int>(sr_per_ms) * cfg.minSpeechDurationMs)
  , max_speech_samples(static_cast<float>(cfg.sampleRate) * cfg.maxSpeechDurationS
                       - static_cast<float>(cfg.windowFrameSize) * static_cast<float>(sr_per_ms)
                       - static_cast<float>(2 * static_cast<int>(sr_per_ms) * cfg.speechPadMs))
  , speech_pad_samples(static_cast<int>(sr_per_ms) * cfg.speechPadMs)
  , min_silence_samples(sr_per_ms * static_cast<unsigned int>(cfg.minSilenceDurationMs))
  , min_silence_samples_at_max_speech(sr_per_ms * kMaxSpeechSilenceFactor)
{
  init_onnx_model(model_path);

  window_size_samples = sr_per_ms * static_cast<unsigned int>(cfg.windowFrameSize);

  input_node_dims[0] = 1;
  input_node_dims[1] = window_size_samples;

  _h.resize(size_hc_);
  _c.resize(size_hc_);
  sr.resize(1);
  sr[0] = sample_rate;
}

void VadIterator::zeroOutSilences(VadIterator::Input& input_wav) const {
  for (size_t i = 0, j = 0; i < input_wav.size(); ++i) {
    if (j < speeches.size()) {
      if (static_cast<int>(i) < speeches[j].start) {
        input_wav[i] = 0.0F;
      }

      if (static_cast<int>(i) == speeches[j].end) {
        ++j;
      }
    } else {
      input_wav[i] = 0.0F;
    }
  }
}

void VadIterator::reset(){
  totalInputLengthMs = 0.0;
  totalProcessingTimeMs = 0.0;
}


void VadIterator::process(VadIterator::Input& input_wav) {
  resetStates();

  audio_length_samples = static_cast<int>(input_wav.size());

  auto tstart = std::chrono::high_resolution_clock::now();

  for (int j = 0; j < audio_length_samples; j += static_cast<int>(window_size_samples)) {
    if (j + static_cast<int>(window_size_samples) > audio_length_samples) {
      break;
    }

    std::span<ValueType> slice{input_wav.begin() + j, window_size_samples};
    predict(slice);
  }

  if (current_speech.start >= 0) {
    current_speech.end = audio_length_samples - 1;
    speeches.push_back(current_speech);

    /* Reset for next input */
    current_speech = Timestamp();
    prev_end = 0;
    next_start = 0;
    temp_end = 0;
    triggered = false;
  }

  zeroOutSilences(input_wav);

  auto tend = std::chrono::high_resolution_clock::now();

  float inputLengthMs = static_cast<float>(audio_length_samples) / static_cast<float>(sr_per_ms);
  float processingTimeMs = static_cast<float>(std::chrono::duration_cast<std::chrono::microseconds>((tend - tstart)).count()) / kMicrosecondsPerMillisecondF;
  
  totalInputLengthMs += static_cast<double>(inputLengthMs);
  totalProcessingTimeMs += static_cast<double>(processingTimeMs);

  input_wav.push_back(inputLengthMs);
  input_wav.push_back(processingTimeMs);
}

auto VadIterator::runtimeStats() const -> qvac_lib_inference_addon_cpp::RuntimeStats {
  return {
    {"totalInputLengthMs", totalInputLengthMs},
    {"totalProcessingTimeMs", totalProcessingTimeMs}
  };
}

} // namespace qvac_lib_inference_addon_onnx_silerovad
