#include "model-interface/pocket/PocketModel.hpp"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <stdexcept>
#include "addon/TTSErrors.hpp"
#include "inference-addon-cpp/Errors.hpp"

namespace qvac::ttsggml::pocket {
namespace {
using qvac_errors::StatusError;
using qvac_errors::createTTSError;
using qvac_errors::tts_error::TTSErrorCode;
namespace general_error = qvac_errors::general_error;
struct BusyGuard {
  std::atomic_bool& flag;
  explicit BusyGuard(std::atomic_bool& f) : flag(f) {
    bool expected = false;
    if (!flag.compare_exchange_strong(expected, true))
      throw StatusError(general_error::InvalidArgument, "PocketModel: operation already in progress");
  }
  ~BusyGuard() { flag.store(false); }
};
std::shared_ptr<tts_cpp::pocket::Engine> makeEngine(const PocketConfig& cfg) {
  try { return std::make_shared<tts_cpp::pocket::Engine>(cfg.options); }
  catch (const std::exception& e) {
    throw createTTSError(TTSErrorCode::InitializationFailed, std::string("PocketModel::load: ") + e.what());
  }
}
}
PocketModel::PocketModel(PocketConfig config)
    : cfg_(std::move(config)), sampleRate_(cfg_.options.output_sample_rate) {
  const auto& o = cfg_.options;
  if (o.flow_lm_path.empty() || o.mimi_path.empty() || o.frontend_path.empty() ||
      o.voice_path.empty() == o.reference_audio_path.empty())
    throw StatusError(general_error::InvalidArgument,
        "Pocket requires FlowLM, Mimi, frontend, and exactly one prepared voice or reference WAV");
  if (sampleRate_ < 8000 || sampleRate_ > 192000)
    throw StatusError(general_error::InvalidArgument, "outputSampleRate must be 8000..192000");
}
void PocketModel::load() {
  BusyGuard guard(busy_);
  { std::lock_guard lock(mutex_); if (engine_) return; }
  auto engine = makeEngine(cfg_);
  std::lock_guard lock(mutex_); engine_ = std::move(engine);
}
void PocketModel::unload() {
  BusyGuard guard(busy_);
  std::lock_guard lock(mutex_); engine_.reset();
}
void PocketModel::reload(PocketConfig config) {
  BusyGuard guard(busy_);
  // Native output handlers capture the sample rate at creation. JS reload
  // recreates the instance when changing this value.
  if (config.options.output_sample_rate != sampleRate_)
    throw StatusError(general_error::InvalidArgument, "recreate PocketModel to change outputSampleRate");
  auto engine = makeEngine(config); // retain the previous usable model on failure
  std::lock_guard lock(mutex_); cfg_ = std::move(config); engine_ = std::move(engine);
}
bool PocketModel::isLoaded() const {
  std::lock_guard lock(mutex_); return bool(engine_);
}
void PocketModel::cancel() const {
  cancelEpoch_.fetch_add(1);
  std::shared_ptr<tts_cpp::pocket::Engine> engine;
  { std::lock_guard lock(mutex_); engine = engine_; }
  if (engine) engine->cancel();
}
std::any PocketModel::process(const std::any& input) {
  const auto* request = std::any_cast<AnyInput>(&input);
  if (!request) throw StatusError(general_error::InvalidArgument, "PocketModel requires AnyInput");
  BusyGuard guard(busy_);
  const auto epoch = cancelEpoch_.load();
  std::shared_ptr<tts_cpp::pocket::Engine> engine;
  { std::lock_guard lock(mutex_); engine = engine_; stats_.clear(); }
  if (!engine) throw createTTSError(TTSErrorCode::InitializationFailed, "PocketModel is not loaded");
  Output output; int index = 0; int64_t samples = 0;
  double firstAudioMs = 0;
  const auto begin = std::chrono::steady_clock::now();
  const auto elapsed = [&] { return std::chrono::duration<double>(std::chrono::steady_clock::now()-begin).count(); };
  try {
    const auto result = engine->synthesize_stream(request->text, [&](const float* pcm, size_t n, int rate) {
      if (cancelEpoch_.load() != epoch) return false;
      if (rate != sampleRate_) throw std::runtime_error("unexpected native output sample rate");
      Output chunk(n);
      for (size_t i = 0; i < n; ++i) {
        if (!std::isfinite(pcm[i])) throw std::runtime_error("non-finite audio sample");
        chunk[i] = static_cast<int16_t>(std::lround(std::clamp(pcm[i], -1.0f, 1.0f)*32767.0f));
      }
      if (!samples) firstAudioMs = elapsed()*1000;
      samples += n;
      if (request->chunkCallback) request->chunkCallback(std::move(chunk), index++, false);
      else output.insert(output.end(), chunk.begin(), chunk.end());
      return cancelEpoch_.load() == epoch;
    });
    if (result.cancelled || cancelEpoch_.load() != epoch) throw std::runtime_error("synthesis cancelled");
    if (request->chunkCallback) request->chunkCallback({}, index, true);
  } catch (const std::exception& e) {
    throw createTTSError(TTSErrorCode::SynthesisFailed, std::string("pocket.synthesize: ") + e.what());
  }
  const double seconds = elapsed(), duration = double(samples)/sampleRate_;
  {
    std::lock_guard lock(mutex_);
    stats_.emplace_back("totalTime", seconds);
    stats_.emplace_back("firstAudioMs", firstAudioMs);
    stats_.emplace_back("audioDurationMs", duration*1000);
    stats_.emplace_back("totalSamples", samples);
    stats_.emplace_back("realTimeFactor", duration > 0 ? seconds/duration : 0.0);
    stats_.emplace_back("tokensPerSecond", seconds > 0 ? request->text.size()/seconds : 0.0);
    stats_.emplace_back("backendDevice", int64_t(0));
    stats_.emplace_back("backendId", int64_t(0));
    stats_.emplace_back("gpuUnsupported", int64_t(0));
  }
  return request->chunkCallback ? std::any{} : std::any(std::move(output));
}
qvac_lib_inference_addon_cpp::RuntimeStats PocketModel::runtimeStats() const {
  std::lock_guard lock(mutex_); return stats_;
}
}
