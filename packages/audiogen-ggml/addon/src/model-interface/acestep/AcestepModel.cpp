#include "model-interface/acestep/AcestepModel.hpp"

#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <utility>

#include "audiogen-cpp/acestep/engine.h"

namespace qvac::audiogenggml::acestep {

namespace {
int16_t f32ToI16(float x) {
  float v = x * 32767.0F;
  if (v > 32767.0F) v = 32767.0F;
  if (v < -32768.0F) v = -32768.0F;
  return static_cast<int16_t>(v);
}

constexpr int64_t BACKEND_DEVICE_CPU = 0;
constexpr int64_t BACKEND_DEVICE_GPU = 1;

// Mirrors tts-ggml's BackendUtils.hpp mapping so the codes the two addons
// report cannot drift apart. Metal registers as "MTL" on newer ggml.
int64_t backendIdFromName(const std::string& name) {
  if (name == "CPU")
    return 0;
  if (name.rfind("Metal", 0) == 0 || name.rfind("MTL", 0) == 0)
    return 1;
  if (name.rfind("CUDA", 0) == 0)
    return 2;
  if (name.rfind("Vulkan", 0) == 0)
    return 3;
  if (name.rfind("OpenCL", 0) == 0)
    return 4;
  return 99;
}

int64_t backendDeviceFromName(const std::string& name) {
  return name == "CPU" ? BACKEND_DEVICE_CPU : BACKEND_DEVICE_GPU;
}
}  // namespace

AcestepModel::AcestepModel(AcestepConfig config) : cfg_(std::move(config)) {
  validateConfig(cfg_);
}

AcestepModel::~AcestepModel() noexcept {
  try {
    std::lock_guard lk(engineMu_);
    unloadLocked();
  } catch (...) {
  }
}

void AcestepModel::validateConfig(const AcestepConfig& cfg) {
  const bool hasDir = !cfg.modelDir.empty();
  const bool hasExplicit = !cfg.lmModelPath.empty() && !cfg.ditModelPath.empty() &&
                           !cfg.textEncModelPath.empty() && !cfg.vaeModelPath.empty();
  if (!hasDir && !hasExplicit) {
    throw std::invalid_argument(
        "AcestepModel: set `modelDir` or all four explicit stage GGUF paths "
        "(textEnc/lm/dit/vae)");
  }
}

void AcestepModel::load() {
  std::lock_guard lk(engineMu_);
  loadLocked();
}

void AcestepModel::loadLocked() {
  if (engine_) return;

  tts_cpp::acestep::EngineOptions opts;
  opts.models_dir = cfg_.modelDir;
  opts.text_enc_model_path = cfg_.textEncModelPath;
  opts.lm_model_path = cfg_.lmModelPath;
  opts.dit_model_path = cfg_.ditModelPath;
  opts.vae_model_path = cfg_.vaeModelPath;
  opts.n_threads = cfg_.threads;
  // useGpu gates offloading: when off, no layers go to the GPU regardless of
  // nGpuLayers. JS supplies both values (no C++ default).
  opts.n_gpu_layers = cfg_.useGpu ? cfg_.nGpuLayers : 0;
  if (const char * vb = std::getenv("AUDIOGEN_VERBOSE")) {
    opts.verbose = (vb[0] == '1' || vb[0] == 't' || vb[0] == 'T' || vb[0] == 'y' || vb[0] == 'Y');
  }

  // Compose the backends-scan directory from the host-provided prebuilds root
  // plus the cmake-bare per-target subdir (BACKENDS_SUBDIR, e.g.
  // `android-arm64/qvac__audiogen-ggml`) so the engine dlopens the ggml backend
  // modules staged next to the `.bare` -- required on arm64, where the CPU
  // backend ships as per-microarch MODULE .so files (GGML_BACKEND_DL). Mirrors
  // qvac/packages/tts-ggml's ChatterboxModel.cpp. Empty `backendsDir` -> leave
  // `opts.backends_dir` empty so the engine relies on ggml's built-in search
  // path (fine for static desktop / Apple builds).
  if (!cfg_.backendsDir.empty()) {
    std::filesystem::path backendsDirPath(cfg_.backendsDir);
#ifdef BACKENDS_SUBDIR
    backendsDirPath = (backendsDirPath / std::filesystem::path(BACKENDS_SUBDIR))
                          .lexically_normal();
#endif
    opts.backends_dir = backendsDirPath.string();
  }

  engine_ = tts_cpp::acestep::Engine::create(opts);
  if (!engine_) {
    throw std::runtime_error("AcestepModel: failed to create acestep engine");
  }
  sampleRate_ = engine_->sample_rate();
  backendName_ = engine_->backend_name();
}

void AcestepModel::unload() {
  std::lock_guard lk(engineMu_);
  unloadLocked();
}

void AcestepModel::unloadLocked() { engine_.reset(); }

void AcestepModel::reload() {
  std::lock_guard lk(engineMu_);
  unloadLocked();
  loadLocked();
}

void AcestepModel::cancel() const {
  cancelRequested_.store(true);
  std::lock_guard lk(engineMu_);
  if (engine_) engine_->cancel();
}

std::any AcestepModel::process(const std::any& input) {
  const auto& in = std::any_cast<const AnyInput&>(input);
  return std::any(generate(in));
}

AcestepModel::Output AcestepModel::generate(const AnyInput& in) {
  cancelRequested_.store(false);
  jobInProgress_.store(true);
  const auto t0 = std::chrono::steady_clock::now();

  std::shared_ptr<tts_cpp::acestep::Engine> engine;
  {
    std::lock_guard lk(engineMu_);
    if (!engine_) loadLocked();
    engine = engine_;
  }

  tts_cpp::acestep::GenerateParams params;
  params.caption = in.caption;
  params.lyrics = in.lyrics;
  params.vocal_language = in.vocalLanguage;
  params.seed = in.seed;
  params.bpm = in.bpm;
  params.keyscale = in.keyscale;
  params.timesignature = in.timesignature;
  // Pass duration straight through: >0 caps the track to that many seconds,
  // 0 (the default) lets LM Phase-1 decide the full song length.
  params.duration = in.duration;
  // 0 = auto: the engine resolves steps/shift from the DiT model type
  // (turbo -> 8 / shift 3.0, base/sft -> 50 / shift 1.0). Forcing 8/3.0 here
  // would make a base/sft model render with turbo settings and sound wrong.
  params.inference_steps = cfg_.inferenceSteps;
  params.shift = cfg_.shift;

  auto progress = [this](const std::string& stage, int step, int total) -> bool {
    if (progressSink_) progressSink_(AcestepProgress{stage, step, total});
    return !cancelRequested_.load();
  };

  tts_cpp::acestep::GenerateResult result = engine->generate(params, progress);

  // Peak-normalise before the int16 quantisation, exactly like the music CLI's
  // wav_write (gain = 0.9 / peak). The Oobleck VAE routinely outputs float
  // samples slightly outside [-1, 1]; converting those straight to int16 hard-
  // clips at full scale and produces the harsh, distorted "horrible" audio the
  // addon path had (vs. the clean CLI output). Normalising to -0.9 dBFS keeps
  // headroom and removes the clipping. Single-shot output, so a 2-pass over the
  // full track is trivial.
  //
  // Always normalise non-silent output to a fixed -0.9 dBFS peak
  // (gain = 0.9 / peak whenever peak > kMinNormPeak): this removes clipping and
  // gives every track consistent headroom vs. the raw engine output. A
  // silent/near-silent result (peak below the threshold) is left untouched:
  // seeding the peak at ~0 and dividing would turn low-level noise into a
  // ~-0.9 dBFS blast. kMinNormPeak ~= -60 dBFS.
  constexpr float kMinNormPeak = 1e-3F;
  float peak = 0.0F;
  for (float s : result.pcm) peak = std::fmax(peak, std::fabs(s));
  const float gain = peak > kMinNormPeak ? 0.9F / peak : 1.0F;

  Output pcm;
  pcm.reserve(result.pcm.size());
  for (float s : result.pcm)
    pcm.push_back(f32ToI16(s * gain));

  const auto t1 = std::chrono::steady_clock::now();
  totalTime_ = std::chrono::duration<double, std::milli>(t1 - t0).count();
  totalSamples_ = static_cast<int64_t>(pcm.size());
  sampleRate_ = result.sample_rate;
  channels_ = result.channels;
  audioDurationMs_ =
      (sampleRate_ > 0 && channels_ > 0)
          ? (static_cast<double>(totalSamples_) / channels_ / sampleRate_) * 1000.0
          : 0.0;
  realTimeFactor_ = audioDurationMs_ > 0.0 ? totalTime_ / audioDurationMs_ : 0.0;

  jobInProgress_.store(false);
  return pcm;
}

qvac_lib_inference_addon_cpp::RuntimeStats AcestepModel::runtimeStats() const {
  // RuntimeStats is a key/value list (vector<pair<string, variant<double,
  // int64_t>>>) in inference-addon-cpp; mirror tts-ggml's shape.
  qvac_lib_inference_addon_cpp::RuntimeStats stats;
  stats.emplace_back("totalTimeMs", totalTime_);
  stats.emplace_back("realTimeFactor", realTimeFactor_);
  stats.emplace_back("audioDurationMs", audioDurationMs_);
  // The *resolved* backend, so a useGPU request that silently fell back to the
  // CPU is visible to callers (gpu-smoke.test.js asserts on these).
  stats.emplace_back("backendDevice", backendDeviceFromName(backendName_));
  stats.emplace_back("backendId", backendIdFromName(backendName_));
  return stats;
}

}  // namespace qvac::audiogenggml::acestep
