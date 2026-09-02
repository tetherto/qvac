#include "WorldSessionModel.hpp"

#include <chrono>
#include <functional>
#include <memory>
#include <utility>

#include <inference-addon-cpp/Errors.hpp>
#include <picojson/picojson.h>

#include "utils/BackendLoader.hpp"
#include "utils/EsrganUpscaler.hpp" // sdLogCallback
#include "utils/ImageCodec.hpp"
#include "utils/LoggingMacros.hpp"
#include "utils/SdErrors.hpp"

using namespace qvac_lib_inference_addon_cpp;
using namespace qvac_errors;

WorldSessionModel::WorldSessionModel(
    qvac_lib_inference_addon_sd::WorldSessionConfig config)
    : config_(std::move(config)) {
  sd_set_log_callback(qvac_lib_inference_addon_sd::sdLogCallback, nullptr);
}

WorldSessionModel::~WorldSessionModel() {
  if (session_ != nullptr) {
    sd_abot_session_free(session_);
    session_ = nullptr;
  }
}

bool WorldSessionModel::isLoaded() const noexcept {
  return session_ != nullptr;
}

void WorldSessionModel::load() {
  if (isLoaded()) {
    return;
  }
  if (config_.ditModelPath.empty() || config_.taehvPath.empty() ||
      config_.scenePath.empty()) {
    throw StatusError(
        general_error::InvalidArgument,
        "world session requires ditModelPath, taehvPath and scenePath");
  }

  const auto tLoadStart = std::chrono::steady_clock::now();
  qvac_lib_inference_addon_sd::loadBackendModulesOnce(config_.backendsDir);

  sd_abot_session_params_t params;
  sd_abot_session_params_init(&params);
  params.dit_model_path = config_.ditModelPath.c_str();
  params.taehv_path = config_.taehvPath.c_str();
  params.scene_path = config_.scenePath.c_str();
  params.backend = config_.backend.c_str();
  params.n_threads = config_.nThreads;
  params.seed = config_.seed;
  params.num_frame_per_block = config_.numFramePerBlock;
  params.local_attn_size = config_.localAttnSize;
  params.offload_params_to_cpu = config_.offloadParamsToCpu;
  params.kv_cache = config_.kvCache;
  params.profile = config_.profile;

  session_ = sd_abot_session_new(&params);
  if (session_ == nullptr) {
    throw StatusError(
        general_error::InternalError,
        "failed to create ABot-World walk session (check model/scene paths, "
        "the kvCache/localAttnSize combination, and native logs)");
  }

  stats_.modelLoadMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                           std::chrono::steady_clock::now() - tLoadStart)
                           .count();
}

std::any WorldSessionModel::process(const std::any& input) {
  // Scene creation is standalone (loads its own encoders, no session needed).
  if (const auto* sceneJob = std::any_cast<SceneCreateJob>(&input)) {
    return processSceneCreate(*sceneJob);
  }
  if (!isLoaded()) {
    throw StatusError(
        general_error::InternalError,
        "WorldSessionModel::process() called before load()");
  }
  return processWalkStep(std::any_cast<const WalkStepJob&>(input));
}

std::any WorldSessionModel::processSceneCreate(const SceneCreateJob& job) {
  // Deliberately no cancelRequested_ handling here: sd_abot_scene_create()
  // exposes no abort hook, so the umT5 + VAE encode is uninterruptible and
  // pretending otherwise (resetting/reading the flag) would imply a
  // capability this path does not have. cancel() granularity is documented
  // in docs/abot-world.md; the walk path resets the flag itself.
  const auto t0 = std::chrono::steady_clock::now();

  sd_image_t decoded = image_codec::decodeImage(job.imageBytes);
  std::unique_ptr<uint8_t, image_codec::FreeDeleter> decodedData(decoded.data);
  if (decoded.data == nullptr) {
    throw StatusError(
        general_error::InvalidArgument,
        "scene image could not be decoded; expected PNG or JPEG bytes");
  }

  qvac_lib_inference_addon_sd::loadBackendModulesOnce(config_.backendsDir);

  sd_abot_scene_params_t params;
  sd_abot_scene_params_init(&params);
  params.t5_path = job.t5Path.c_str();
  params.vae_path = job.vaePath.c_str();
  params.prompt = job.prompt.c_str();
  params.init_image = decoded;
  params.width = job.width;
  params.height = job.height;
  params.output_path = job.outputPath.c_str();
  params.backend = config_.backend.c_str();
  params.n_threads = config_.nThreads;
  params.offload_params_to_cpu = config_.offloadParamsToCpu;

  if (!sd_abot_scene_create(&params)) {
    throw StatusError(
        general_error::InternalError,
        "ABot-World scene creation failed (see native logs)");
  }

  const int64_t sceneMs =
      static_cast<int64_t>(std::chrono::duration<double, std::milli>(
                               std::chrono::steady_clock::now() - t0)
                               .count());
  if (job.progressCallback) {
    picojson::object progress;
    progress["scene"] = picojson::value(job.outputPath);
    progress["elapsed_ms"] = picojson::value(static_cast<double>(sceneMs));
    job.progressCallback(picojson::value(progress).serialize());
  }

  lastStats_.clear();
  lastStats_.emplace_back("sceneCreateMs", sceneMs);
  lastStats_.emplace_back("width", static_cast<int64_t>(job.width));
  lastStats_.emplace_back("height", static_cast<int64_t>(job.height));
  return std::any{};
}

std::any WorldSessionModel::processWalkStep(const WalkStepJob& job) {
  cancelRequested_.store(false);

  const auto stepStart = std::chrono::steady_clock::now();

  int numFrames = 0;
  sd_image_t* frames =
      sd_abot_session_step(session_, job.actionMask, &numFrames);
  if (frames == nullptr) {
    throw StatusError(
        general_error::InternalError,
        "ABot-World walk step failed (see native logs)");
  }
  // RAII: the encoders can throw bad_alloc and the output callback can throw
  // from the queue, so every exit below must release the decoded block (same
  // idiom as the scene path's FreeDeleter).
  auto framesGuard =
      std::unique_ptr<sd_image_t, std::function<void(sd_image_t*)>>(
          frames, [numFrames](sd_image_t* ptr) {
            sd_abot_session_frames_free(ptr, numFrames);
          });

  const auto stepEnd = std::chrono::steady_clock::now();
  const int64_t stepMs = static_cast<int64_t>(
      std::chrono::duration<double, std::milli>(stepEnd - stepStart).count());

  int delivered = 0;
  int64_t width = 0;
  int64_t height = 0;
  for (int i = 0; i < numFrames; i++) {
    if (cancelRequested_.load()) {
      break;
    }
    width = frames[i].width;
    height = frames[i].height;
    if (job.outputCallback) {
      const int jpegQuality = config_.frameJpegQuality;
      auto encoded = jpegQuality > 0
                         ? image_codec::encodeToJpeg(frames[i], jpegQuality)
                         : image_codec::encodeToPng(frames[i]);
      if (encoded.empty()) {
        throw StatusError(
            general_error::InternalError, "failed to encode walk frame");
      }
      job.outputCallback(encoded);
      delivered++;
    }
  }

  // A cancelled step must reject like the package's four other cancellation
  // sites (typed Diffusion/Cancelled) - resolving with a silently truncated
  // frame stream would hide a permanent gap in the walk: the DiT already
  // committed this block to the session history, undelivered frames are gone.
  if (cancelRequested_.load()) {
    throw qvac_lib_inference_addon_sd::errors::makeCancelledError();
  }

  stats_.totalStepMs += stepMs;
  stats_.totalSteps++;
  stats_.totalFrames += delivered;

  if (job.progressCallback) {
    picojson::object progress;
    progress["step"] = picojson::value(static_cast<double>(stats_.totalSteps));
    progress["frames"] = picojson::value(static_cast<double>(delivered));
    progress["elapsed_ms"] = picojson::value(static_cast<double>(stepMs));
    job.progressCallback(picojson::value(progress).serialize());
  }

  lastStats_.clear();
  lastStats_.emplace_back("modelLoadMs", stats_.modelLoadMs);
  lastStats_.emplace_back("stepMs", stepMs);
  lastStats_.emplace_back("totalStepMs", stats_.totalStepMs);
  lastStats_.emplace_back("totalSteps", stats_.totalSteps);
  lastStats_.emplace_back("totalFrames", stats_.totalFrames);
  lastStats_.emplace_back("frames", static_cast<int64_t>(delivered));
  lastStats_.emplace_back("width", width);
  lastStats_.emplace_back("height", height);
  lastStats_.emplace_back("actionMask", static_cast<int64_t>(job.actionMask));

  return std::any{};
}

void WorldSessionModel::cancel() const { cancelRequested_.store(true); }

qvac_lib_inference_addon_cpp::RuntimeStats
WorldSessionModel::runtimeStats() const {
  return lastStats_;
}
