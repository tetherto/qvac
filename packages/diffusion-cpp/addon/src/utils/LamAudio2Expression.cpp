#include "LamAudio2Expression.hpp"

#include <algorithm>
#include <utility>

#include <inference-addon-cpp/Errors.hpp>
#include <stable-diffusion.h>

#include "SdErrors.hpp"

using namespace qvac_errors;

namespace qvac_lib_inference_addon_sd {

namespace {

bool deviceStringToUseGpu(const std::string& device) {
  if (device == "cpu")
    return false;
  if (device == "gpu")
    return true;
  throw StatusError(
      general_error::InvalidArgument,
      "LAM audio2expression device must be 'cpu' or 'gpu', got: '" + device +
          "'");
}

} // namespace

LamAudio2Expression::LamAudio2Expression(LamAudio2ExpressionConfig config)
    : config_(std::move(config)), ctx_(nullptr, &lam_a2e_free),
      currentIdentityIndex_(config_.identityIndex) {}

LamAudio2Expression::~LamAudio2Expression() = default;

bool LamAudio2Expression::isLoaded() const noexcept {
  std::lock_guard<std::mutex> lock(mutex_);
  return ctx_ != nullptr;
}

void LamAudio2Expression::load() {
  std::lock_guard<std::mutex> lock(mutex_);
  ensureContextLocked(config_.identityIndex);
}

int LamAudio2Expression::actualBackendDevice() const {
  std::lock_guard<std::mutex> lock(mutex_);
  if (ctx_ == nullptr) {
    return -1;
  }
  return useGpuActive_ ? 1 : 0;
}

int LamAudio2Expression::resolveThreads() const {
  if (config_.nThreads == 0 || config_.nThreads < -1) {
    throw StatusError(
        general_error::InvalidArgument,
        "nThreads must be -1 (auto) or a positive integer");
  }

  int threads =
      config_.nThreads > 0 ? config_.nThreads : sd_get_num_physical_cores();
  if (threads <= 0) {
    throw StatusError(
        general_error::InternalError,
        "Failed to auto-detect thread count for LAM audio2expression; set "
        "nThreads to a positive integer");
  }
  return threads;
}

lam_a2e_context*
LamAudio2Expression::ensureContextLocked(int32_t identityIndex) {
  if (config_.modelPath.empty()) {
    throw StatusError(
        general_error::InvalidArgument,
        "LAM audio2expression requires files.model to be provided");
  }

  if (ctx_ != nullptr && currentIdentityIndex_ == identityIndex) {
    return ctx_.get();
  }

  const bool useGpu = deviceStringToUseGpu(config_.device);

  lam_a2e_params params{};
  params.model_path = config_.modelPath.c_str();
  params.identity_index = identityIndex;
  params.n_threads = resolveThreads();
  params.use_gpu = useGpu;

  lam_a2e_context* raw = lam_a2e_create(&params);
  if (raw == nullptr) {
    throw StatusError(
        general_error::InternalError,
        "Failed to create LAM audio2expression context from files.model: " +
            config_.modelPath);
  }

  ctx_.reset(raw);
  currentIdentityIndex_ = identityIndex;
  useGpuActive_ = useGpu;
  return ctx_.get();
}

std::vector<LamA2eFrame> LamAudio2Expression::processPcmF32(
    const std::vector<float>& pcm, int32_t sampleRate,
    std::optional<int32_t> identityIndexOverride) {
  if (sampleRate != 16000) {
    throw StatusError(
        general_error::InvalidArgument,
        "LAM audio2expression requires sampleRate == 16000, got: " +
            std::to_string(sampleRate));
  }
  if (pcm.empty()) {
    throw StatusError(
        general_error::InvalidArgument,
        "LAM audio2expression requires a non-empty PCM buffer");
  }

  std::lock_guard<std::mutex> lock(mutex_);

  const int32_t identityIndex =
      identityIndexOverride.value_or(config_.identityIndex);
  lam_a2e_context* ctx = ensureContextLocked(identityIndex);

  lam_a2e_frame* rawFrames = nullptr;
  int32_t frameCount = 0;
  const lam_a2e_status status = lam_a2e_process_pcm_f32(
      ctx, pcm.data(), static_cast<int64_t>(pcm.size()), sampleRate,
      &rawFrames, &frameCount);

  if (status != LAM_A2E_STATUS_OK) {
    const char* lastError = lam_a2e_get_last_error(ctx);
    throw StatusError(
        general_error::InternalError,
        std::string("LAM audio2expression inference failed: ") +
            (lastError != nullptr ? lastError : "unknown error"));
  }

  std::unique_ptr<lam_a2e_frame, decltype(&lam_a2e_free_frames)> framesGuard(
      rawFrames, &lam_a2e_free_frames);

  std::vector<LamA2eFrame> frames;
  frames.reserve(static_cast<size_t>(frameCount));
  for (int32_t i = 0; i < frameCount; ++i) {
    LamA2eFrame frame{};
    frame.timestampUs = rawFrames[i].timestamp_us;
    std::copy(
        std::begin(rawFrames[i].arkit_52), std::end(rawFrames[i].arkit_52),
        frame.arkit52.begin());
    frames.push_back(frame);
  }

  return frames;
}

} // namespace qvac_lib_inference_addon_sd
