#include "model-interface/moss/MossSpeechModel.hpp"

#include <chrono>
#include <cstdint>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include <tts-cpp/moss/speech.h>

#include "addon/TTSErrors.hpp"
#include "inference-addon-cpp/Errors.hpp"
#include "model-interface/BackendUtils.hpp"
#include "model-interface/PcmConversion.hpp"

namespace qvac::ttsggml::moss {

namespace {

using qvac_errors::createTTSError;
using qvac_errors::StatusError;
using qvac_errors::tts_error::TTSErrorCode;
namespace general_error = qvac_errors::general_error;

constexpr int CPU_BACKEND_ID = 0;
constexpr double MS_PER_SECOND = 1000.0;

void requireFile(
    const std::string& path, const char* option, const char* what) {
  if (path.empty()) {
    throw StatusError(
        general_error::InvalidArgument, std::string(option) + " is required");
  }
  if (!std::filesystem::exists(path)) {
    throw createTTSError(
        TTSErrorCode::ModelFileNotFound,
        std::string("moss speech ") + what + " not found: " + path);
  }
}

void validateThreads(const MossSpeechConfig& cfg) {
  if (cfg.threads.has_value() && *cfg.threads < 0) {
    throw StatusError(
        general_error::InvalidArgument,
        "threads must be >= 0 (0 = engine default)");
  }
}

void validateGpuIntent(const MossSpeechConfig& cfg) {
  if (!cfg.useGpu.has_value() || !cfg.nGpuLayers.has_value())
    return;
  const bool wantsGpuFlag = *cfg.useGpu;
  const int layers = *cfg.nGpuLayers;
  if (wantsGpuFlag == (layers != 0))
    return;
  throw StatusError(
      general_error::InvalidArgument,
      std::string("MossSpeechModel: useGPU=") +
          (wantsGpuFlag ? "true" : "false") +
          " conflicts with nGpuLayers=" + std::to_string(layers) +
          ". Either drop one of the two, or make them agree "
          "(useGPU:true + nGpuLayers!=0, or useGPU:false + nGpuLayers=0).");
}

bool wantsGpu(const MossSpeechConfig& cfg) {
  return cfg.nGpuLayers.has_value() ? *cfg.nGpuLayers != 0
                                    : cfg.useGpu.value_or(false);
}

tts_cpp::moss::SpeechRole roleOf(const std::string& role) {
  if (role == "system")
    return tts_cpp::moss::SpeechRole::System;
  if (role == "assistant")
    return tts_cpp::moss::SpeechRole::Assistant;
  if (role == "user")
    return tts_cpp::moss::SpeechRole::User;
  throw StatusError(
      general_error::InvalidArgument,
      "moss-speech message role must be 'system', 'user' or 'assistant' "
      "(got '" +
          role + "')");
}

tts_cpp::moss::SpeechMessage messageOf(const MossSpeechTurn& turn) {
  tts_cpp::moss::SpeechMessage message;
  message.role = roleOf(turn.role);
  message.text = turn.text;
  message.audio = turn.audio.pcm;
  message.sample_rate = turn.audio.sampleRate;
  return message;
}

std::vector<tts_cpp::moss::SpeechMessage>
messagesOf(const std::vector<MossSpeechTurn>& turns) {
  std::vector<tts_cpp::moss::SpeechMessage> messages;
  messages.reserve(turns.size());
  for (const auto& turn : turns) {
    messages.push_back(messageOf(turn));
  }
  return messages;
}

void applySampling(
    tts_cpp::moss::SpeechRequest& request, const MossSpeechCall& call) {
  request.greedy = call.greedy;
  if (call.temperature.has_value())
    request.temperature = *call.temperature;
  if (call.topP.has_value())
    request.top_p = *call.topP;
  if (call.topK.has_value())
    request.top_k = *call.topK;
}

void applyLimits(
    tts_cpp::moss::SpeechRequest& request, const MossSpeechCall& call) {
  request.text_reply = call.textReply;
  if (call.maxReplySeconds.has_value())
    request.max_reply_seconds = *call.maxReplySeconds;
  if (call.maxNewTokens.has_value())
    request.max_new_tokens = *call.maxNewTokens;
}

} // namespace

MossSpeechModel::MossSpeechModel(MossSpeechConfig config)
    : cfg_(std::move(config)) {
  validateConfig(cfg_);
}

MossSpeechModel::~MossSpeechModel() noexcept = default;

void MossSpeechModel::validateConfig(const MossSpeechConfig& cfg) {
  requireFile(cfg.modelPath, "mossSpeechModelPath", "model");
  requireFile(cfg.codecPath, "mossSpeechCodecPath", "codec");
  validateThreads(cfg);
  validateGpuIntent(cfg);
}

tts_cpp::moss::SpeechOptions
MossSpeechModel::toEngineOptions(const MossSpeechConfig& cfg) {
  tts_cpp::moss::SpeechOptions opts;
  opts.model_path = cfg.modelPath;
  opts.codec_path = cfg.codecPath;
  if (cfg.threads.value_or(0) > 0)
    opts.n_threads = *cfg.threads;
  opts.backends_dir = resolveBackendsDir(cfg.backendsDir).string();
  opts.use_gpu = wantsGpu(cfg);
  return opts;
}

tts_cpp::moss::SpeechRequest MossSpeechModel::toRequest(
    const MossSpeechConfig& cfg, const MossSpeechCall& call) {
  tts_cpp::moss::SpeechRequest request;
  request.messages = messagesOf(call.messages);
  request.voice = call.voice.pcm;
  request.voice_sample_rate = call.voice.sampleRate;
  applySampling(request, call);
  applyLimits(request, call);
  if (cfg.seed.has_value())
    request.seed = static_cast<uint32_t>(*cfg.seed);
  return request;
}

void MossSpeechModel::reloadWith(MossSpeechConfig config) {
  validateConfig(config);
  std::lock_guard lk(engineMu_);
  cfg_ = std::move(config);
  unloadLocked();
  loadLocked();
}

void MossSpeechModel::load() {
  std::lock_guard lk(engineMu_);
  loadLocked();
}

void MossSpeechModel::unload() {
  std::lock_guard lk(engineMu_);
  unloadLocked();
}

void MossSpeechModel::loadLocked() {
  if (engine_)
    return;
  try {
    engine_ =
        std::make_shared<tts_cpp::moss::SpeechEngine>(toEngineOptions(cfg_));
  } catch (const std::exception& e) {
    engine_.reset();
    throw createTTSError(
        TTSErrorCode::InitializationFailed,
        std::string("MossSpeechModel::load: ") + e.what());
  }
  backendName_ = engine_->backend_name();
  backendId_ = backendIdFromName(backendName_);
  backendDevice_ =
      backendId_ == CPU_BACKEND_ID ? kBackendDeviceCpu : kBackendDeviceGpu;
  gpuUnsupported_ = wantsGpu(cfg_) && backendDevice_ == kBackendDeviceCpu;
}

void MossSpeechModel::unloadLocked() { engine_.reset(); }

void MossSpeechModel::cancel() const {
  cancelRequested_.store(true, std::memory_order_relaxed);
  std::shared_ptr<tts_cpp::moss::SpeechEngine> e;
  {
    std::lock_guard lk(engineMu_);
    e = engine_;
  }
  if (e)
    e->cancel();
}

void MossSpeechModel::recordStats(
    double seconds, const tts_cpp::moss::SpeechResult& result) {
  totalTime_ = seconds;
  totalSamples_ = static_cast<int64_t>(result.pcm.size());
  audioDurationMs_ = static_cast<double>(totalSamples_) * MS_PER_SECOND /
                     MOSS_SPEECH_NATIVE_SAMPLE_RATE;
  realTimeFactor_ = audioDurationMs_ > 0.0
                        ? (totalTime_ * MS_PER_SECOND) / audioDurationMs_
                        : 0.0;
  promptTokens_ = result.prompt_tokens;
  generatedTokens_ = result.generated_tokens;
  replyTokens_ = result.reply_tokens;
  truncated_ = result.truncated;
  encodeMs_ = result.encode_ms;
  prefillMs_ = result.prefill_ms;
  generateMs_ = result.generate_ms;
  decodeMs_ = result.decode_ms;
}

std::shared_ptr<tts_cpp::moss::SpeechEngine> MossSpeechModel::snapshot() const {
  std::lock_guard lk(engineMu_);
  if (!engine_) {
    throw createTTSError(
        TTSErrorCode::InitializationFailed,
        "MossSpeechModel::respond: engine not loaded");
  }
  return engine_;
}

void MossSpeechModel::requireNotCancelled() const {
  if (!cancelRequested_.load(std::memory_order_relaxed))
    return;
  throw createTTSError(
      TTSErrorCode::SynthesisFailed, "response cancelled before it started");
}

void MossSpeechModel::requireCompleted(
    const tts_cpp::moss::SpeechResult& result) const {
  if (!result.cancelled && !cancelRequested_.load(std::memory_order_relaxed))
    return;
  throw createTTSError(TTSErrorCode::SynthesisFailed, "response cancelled");
}

tts_cpp::moss::SpeechResult MossSpeechModel::runEngine(
    tts_cpp::moss::SpeechEngine& engine, const MossSpeechCall& call) const {
  try {
    return engine.respond(toRequest(config(), call), [this](int, int) {
      return !cancelRequested_.load(std::memory_order_relaxed);
    });
  } catch (const std::exception& e) {
    throw createTTSError(
        TTSErrorCode::SynthesisFailed, std::string("moss.speech: ") + e.what());
  }
}

MossSpeechModel::Output MossSpeechModel::respond(const MossSpeechCall& call) {
  const auto engine = snapshot();
  requireNotCancelled();
  const auto t0 = std::chrono::steady_clock::now();
  auto result = runEngine(*engine, call);
  const auto t1 = std::chrono::steady_clock::now();
  requireCompleted(result);
  recordStats(std::chrono::duration<double>(t1 - t0).count(), result);
  return Output{pcmFloatToInt16(result.pcm), std::move(result.text)};
}

const MossSpeechModel::AnyInput&
MossSpeechModel::requireAnyInput(const std::any& input) {
  const auto* anyInput = std::any_cast<AnyInput>(&input);
  if (!anyInput) {
    throw StatusError(
        general_error::InvalidArgument,
        "MossSpeechModel::process: input must be AnyInput");
  }
  return *anyInput;
}

void MossSpeechModel::claimJob() {
  bool expected = false;
  if (jobInProgress_.compare_exchange_strong(
          expected, true, std::memory_order_acq_rel))
    return;
  throw StatusError(
      general_error::InternalError,
      "MossSpeechModel::process: job already in progress");
}

std::any MossSpeechModel::process(const std::any& input) {
  const AnyInput& anyInput = requireAnyInput(input);
  claimJob();
  struct InProgressGuard {
    std::atomic_bool& flag;
    ~InProgressGuard() { flag.store(false, std::memory_order_release); }
  } guard{jobInProgress_};

  cancelRequested_.store(false, std::memory_order_relaxed);
  return std::any(respond(anyInput.call));
}

qvac_lib_inference_addon_cpp::RuntimeStats
MossSpeechModel::runtimeStats() const {
  qvac_lib_inference_addon_cpp::RuntimeStats stats;
  stats.emplace_back("totalTime", totalTime_);
  stats.emplace_back("realTimeFactor", realTimeFactor_);
  stats.emplace_back("audioDurationMs", audioDurationMs_);
  stats.emplace_back("totalSamples", totalSamples_);
  stats.emplace_back("promptTokens", promptTokens_);
  stats.emplace_back("generatedTokens", generatedTokens_);
  stats.emplace_back("replyTokens", replyTokens_);
  stats.emplace_back("truncated", static_cast<int64_t>(truncated_));
  stats.emplace_back("encodeMs", encodeMs_);
  stats.emplace_back("prefillMs", prefillMs_);
  stats.emplace_back("generateMs", generateMs_);
  stats.emplace_back("decodeMs", decodeMs_);
  stats.emplace_back("backendDevice", static_cast<int64_t>(backendDevice_));
  stats.emplace_back("backendId", static_cast<int64_t>(backendId_));
  stats.emplace_back("gpuUnsupported", static_cast<int64_t>(gpuUnsupported_));
  return stats;
}

} // namespace qvac::ttsggml::moss
