#include "model-interface/moss/MossTranscribeModel.hpp"

#include <cctype>
#include <charconv>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <utility>

#include <parakeet/moss_transcribe.h>

#include "addon/AsrErrors.hpp"
#include "inference-addon-cpp/Errors.hpp"
#include "model-interface/ModuleBackendsDir.hpp"

namespace qvac::asrggml::moss {

namespace {

namespace fs = std::filesystem;
namespace general_error = qvac_errors::general_error;
using errors::parakeet::Code;
using errors::parakeet::makeStatus;

constexpr int BACKEND_CPU = 0;
constexpr int BACKEND_METAL = 1;
constexpr int BACKEND_CUDA = 2;
constexpr int BACKEND_VULKAN = 3;
constexpr int BACKEND_OPENCL = 4;
constexpr int BACKEND_OTHER = 99;
constexpr int DEVICE_CPU = 0;
constexpr int DEVICE_GPU = 1;
constexpr double MS_PER_SECOND = 1000.0;
constexpr char SPEAKER_PREFIX = 'S';

void throwInvalidConfig(const std::string& message) {
  throw qvac_errors::StatusError(general_error::InvalidArgument, message);
}

bool startsWith(const std::string& text, const char* prefix) {
  return text.rfind(prefix, 0) == 0;
}

int backendIdFromName(const std::string& name) {
  if (name == "CPU")
    return BACKEND_CPU;
  if (startsWith(name, "Metal") || startsWith(name, "MTL"))
    return BACKEND_METAL;
  if (startsWith(name, "CUDA"))
    return BACKEND_CUDA;
  if (startsWith(name, "Vulkan"))
    return BACKEND_VULKAN;
  if (startsWith(name, "OpenCL"))
    return BACKEND_OPENCL;
  return BACKEND_OTHER;
}

bool allDigits(const std::string& text) {
  for (const char ch : text) {
    if (std::isdigit(static_cast<unsigned char>(ch)) == 0)
      return false;
  }
  return !text.empty();
}

int speakerNumberOf(const std::string& digits) {
  int number = 0;
  const auto [end, error] =
      std::from_chars(digits.data(), digits.data() + digits.size(), number);
  if (error != std::errc() || end != digits.data() + digits.size())
    return 0;
  return number;
}

parakeet::Transcript
transcriptOf(const ::parakeet::moss::TranscriptSegment& segment, size_t index) {
  parakeet::Transcript transcript(segment.text);
  transcript.start = static_cast<float>(segment.start_s);
  transcript.end = static_cast<float>(segment.end_s);
  transcript.id = index;
  transcript.speaker = segment.speaker;
  transcript.speakerId = MossTranscribeModel::speakerIdOf(segment.speaker);
  return transcript;
}

} // namespace

MossTranscribeModel::MossTranscribeModel(MossTranscribeConfig config)
    : cfg_(std::move(config)) {
  validateConfig(cfg_);
}

MossTranscribeModel::~MossTranscribeModel() noexcept = default;

void MossTranscribeModel::validateConfig(const MossTranscribeConfig& cfg) {
  if (cfg.modelPath.empty())
    throwInvalidConfig("modelPath is required for the moss-transcribe engine");
  if (!fs::exists(cfg.modelPath))
    throwInvalidConfig("moss-transcribe model not found: " + cfg.modelPath);
  if (cfg.maxThreads < 0)
    throwInvalidConfig("maxThreads must be >= 0 (0 = engine default)");
}

::parakeet::moss::TranscribeOptions
MossTranscribeModel::toEngineOptions(const MossTranscribeConfig& cfg) {
  ::parakeet::moss::TranscribeOptions options;
  options.model_path = cfg.modelPath;
  if (cfg.maxThreads > 0)
    options.n_threads = cfg.maxThreads;
  options.use_gpu = cfg.useGPU;
  options.backends_dir = resolveBackendsDir(cfg.backendsDir).string();
  return options;
}

::parakeet::moss::TranscribeRequest
MossTranscribeModel::toEngineRequest(const MossTranscribeRequest& request) {
  ::parakeet::moss::TranscribeRequest engineRequest;
  engineRequest.prompt = request.prompt;
  engineRequest.hotwords = request.hotwords;
  engineRequest.max_new_tokens = request.maxNewTokens;
  return engineRequest;
}

int MossTranscribeModel::speakerIdOf(const std::string& label) {
  if (label.size() < 2 || label.front() != SPEAKER_PREFIX)
    return -1;
  const std::string digits = label.substr(1);
  if (!allDigits(digits))
    return -1;
  return speakerNumberOf(digits) - 1;
}

MossTranscribeModel::Output MossTranscribeModel::toTranscripts(
    const ::parakeet::moss::TranscribeResult& result) {
  Output transcripts;
  transcripts.reserve(result.segments.size());
  for (size_t i = 0; i < result.segments.size(); ++i) {
    transcripts.push_back(transcriptOf(result.segments[i], i));
  }
  return transcripts;
}

void MossTranscribeModel::load() {
  std::lock_guard lk(engineMu_);
  if (engine_)
    return;
  try {
    engine_ = std::make_shared<::parakeet::moss::TranscribeEngine>(
        toEngineOptions(cfg_));
  } catch (const std::exception& e) {
    engine_.reset();
    throw makeStatus(
        Code::SessionInitFailed,
        std::string("MossTranscribeModel::load: ") + e.what());
  }
  backendName_ = engine_->backend_name();
  backendId_ = backendIdFromName(backendName_);
  backendDevice_ = backendId_ == BACKEND_CPU ? DEVICE_CPU : DEVICE_GPU;
}

void MossTranscribeModel::unload() {
  std::lock_guard lk(engineMu_);
  engine_.reset();
}

void MossTranscribeModel::cancel() const {
  cancelRequested_.store(true, std::memory_order_relaxed);
  std::shared_ptr<::parakeet::moss::TranscribeEngine> engine;
  {
    std::lock_guard lk(engineMu_);
    engine = engine_;
  }
  if (engine)
    engine->cancel();
}

std::shared_ptr<::parakeet::moss::TranscribeEngine>
MossTranscribeModel::snapshot() const {
  std::lock_guard lk(engineMu_);
  if (!engine_) {
    throw makeStatus(
        Code::ModelNotReady, "MossTranscribeModel: engine not loaded");
  }
  return engine_;
}

void MossTranscribeModel::requireCompleted(
    const ::parakeet::moss::TranscribeResult& result) const {
  if (!result.cancelled && !cancelRequested_.load(std::memory_order_relaxed))
    return;
  throw makeStatus(Code::InferenceFailed, "transcription cancelled");
}

::parakeet::moss::TranscribeResult MossTranscribeModel::runEngine(
    ::parakeet::moss::TranscribeEngine& engine, const AnyInput& input) const {
  try {
    return engine.transcribe(
        input.samples.data(),
        input.samples.size(),
        MOSS_TRANSCRIBE_SAMPLE_RATE,
        toEngineRequest(input.request),
        [this](int, int) {
          return !cancelRequested_.load(std::memory_order_relaxed);
        });
  } catch (const std::exception& e) {
    throw makeStatus(
        Code::InferenceFailed, std::string("moss.transcribe: ") + e.what());
  }
}

void MossTranscribeModel::recordStats(
    double seconds, size_t samples,
    const ::parakeet::moss::TranscribeResult& result) {
  totalTime_ = seconds;
  audioDurationMs_ = static_cast<double>(samples) * MS_PER_SECOND /
                     MOSS_TRANSCRIBE_SAMPLE_RATE;
  realTimeFactor_ = audioDurationMs_ > 0.0
                        ? (totalTime_ * MS_PER_SECOND) / audioDurationMs_
                        : 0.0;
  segments_ = static_cast<int64_t>(result.segments.size());
  audioTokens_ = result.audio_tokens;
  promptTokens_ = result.prompt_tokens;
  generatedTokens_ = result.generated_tokens;
  encodeMs_ = result.encode_ms;
  prefillMs_ = result.prefill_ms;
  decodeMs_ = result.decode_ms;
}

MossTranscribeModel::Output
MossTranscribeModel::transcribe(const AnyInput& input) {
  const auto engine = snapshot();
  const auto t0 = std::chrono::steady_clock::now();
  const auto result = runEngine(*engine, input);
  const auto t1 = std::chrono::steady_clock::now();
  requireCompleted(result);
  recordStats(
      std::chrono::duration<double>(t1 - t0).count(),
      input.samples.size(),
      result);
  return toTranscripts(result);
}

const MossTranscribeModel::AnyInput&
MossTranscribeModel::requireAnyInput(const std::any& input) {
  const auto* anyInput = std::any_cast<AnyInput>(&input);
  if (!anyInput) {
    throw qvac_errors::StatusError(
        general_error::InvalidArgument,
        "MossTranscribeModel::process: input must be AnyInput");
  }
  return *anyInput;
}

void MossTranscribeModel::claimJob() {
  bool expected = false;
  if (jobInProgress_.compare_exchange_strong(
          expected, true, std::memory_order_acq_rel))
    return;
  throw qvac_errors::StatusError(
      general_error::InternalError,
      "MossTranscribeModel::process: job already in progress");
}

std::any MossTranscribeModel::process(const std::any& input) {
  const AnyInput& anyInput = requireAnyInput(input);
  claimJob();
  struct InProgressGuard {
    std::atomic_bool& flag;
    ~InProgressGuard() { flag.store(false, std::memory_order_release); }
  } guard{jobInProgress_};

  cancelRequested_.store(false, std::memory_order_relaxed);
  return std::any(transcribe(anyInput));
}

qvac_lib_inference_addon_cpp::RuntimeStats
MossTranscribeModel::runtimeStats() const {
  qvac_lib_inference_addon_cpp::RuntimeStats stats;
  stats.emplace_back("totalTime", totalTime_);
  stats.emplace_back("realTimeFactor", realTimeFactor_);
  stats.emplace_back("audioDurationMs", audioDurationMs_);
  stats.emplace_back("segments", segments_);
  stats.emplace_back("audioTokens", audioTokens_);
  stats.emplace_back("promptTokens", promptTokens_);
  stats.emplace_back("generatedTokens", generatedTokens_);
  stats.emplace_back("encodeMs", encodeMs_);
  stats.emplace_back("prefillMs", prefillMs_);
  stats.emplace_back("decodeMs", decodeMs_);
  stats.emplace_back("backendDevice", static_cast<int64_t>(backendDevice_));
  stats.emplace_back("backendId", static_cast<int64_t>(backendId_));
  return stats;
}

} // namespace qvac::asrggml::moss
