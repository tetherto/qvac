#pragma once

#include <any>
#include <atomic>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/RuntimeStats.hpp>
#include <stable-diffusion.h>

namespace qvac_lib_inference_addon_sd {

// Configuration for an ABot-World interactive walk session. The session is
// standalone (its own DiT + taehv decoder + fixed scene pack); it does not
// share an sd_ctx with the batch txt2img/txt2vid pipeline.
struct WorldSessionConfig {
  std::string ditModelPath; // ABot-World DiT GGUF (F16 or Q8_0)
  std::string taehvPath;    // taew2_2 GGUF (streaming pixel decoder)
  std::string scenePath;    // scene pack safetensors
  std::string backendsDir;  // DL backend modules directory
  std::string backend;      // backend spec ("" = default; "cpu", "cuda", ...)
  // -1 = auto-detect physical cores: the package-wide default (same as
  // SdCtxConfig / EsrganConfig). GPU-backend walks average ~1 busy core, so
  // auto-detect costs nothing there; the CPU backend needs the real pool.
  int nThreads = -1;
  int64_t seed = 42;        // walk noise seed
  int numFramePerBlock = 0; // 0 = model default (3)
  int localAttnSize = 0;    // 0 = engine default (8); latent-frame window
  bool offloadParamsToCpu = false;
  // Frame encoding: 0 = lossless PNG; 1..100 = JPEG at that quality on the
  // standard JPEG scale (higher = better quality / larger frames, 100 =
  // least compression; 85 is a good remote-streaming value). A continuous
  // encoder dial with 0 reserved for PNG, not an enum.
  int frameJpegQuality = 0;
  // Per-layer history KV cache (~3.7x fewer frame-passes per block). The
  // engine validates it against localAttnSize at load and fails fast on a
  // window the compile-time KV ring cannot hold.
  bool kvCache = false;
  bool profile = false; // per-stage timing logs from the native session
};

// Named bits for WorldSessionModel::WalkStepJob::actionMask (WASD move,
// IJKL look). Combine with bitwise OR. Values mirror the JS `ActionFlag`
// export and `KEY_ORDER` in src/world.ts; test_world_session.cpp pins them.
enum class ActionFlag : uint32_t {
  None = 0,
  W = 1U << 0,
  A = 1U << 1,
  S = 1U << 2,
  D = 1U << 3,
  I = 1U << 4,
  J = 1U << 5,
  K = 1U << 6,
  L = 1U << 7,
};

} // namespace qvac_lib_inference_addon_sd

// One generated block per step: the DiT denoises num_frame_per_block latent
// frames under the given keyboard action, taehv decodes them, and each RGB
// frame is delivered to the output callback as a PNG (default) or JPEG
// (frameJpegQuality 1..100).
class WorldSessionModel
    : public qvac_lib_inference_addon_cpp::model::IModel,
      public qvac_lib_inference_addon_cpp::model::IModelCancel {
public:
  explicit WorldSessionModel(
      qvac_lib_inference_addon_sd::WorldSessionConfig config);
  ~WorldSessionModel() override;

  WorldSessionModel(const WorldSessionModel&) = delete;
  WorldSessionModel& operator=(const WorldSessionModel&) = delete;
  WorldSessionModel(WorldSessionModel&&) = delete;
  WorldSessionModel& operator=(WorldSessionModel&&) = delete;

  [[nodiscard]] std::string getName() const final {
    return "WorldSessionModel";
  }

  void load();
  [[nodiscard]] bool isLoaded() const noexcept;

  std::any process(const std::any& input) final;
  void cancel() const final;

  [[nodiscard]] qvac_lib_inference_addon_cpp::RuntimeStats
  runtimeStats() const final;

  struct WalkStepJob {
    // Bitwise OR of qvac_lib_inference_addon_sd::ActionFlag values.
    uint32_t actionMask{0};
    std::function<void(const std::string&)> progressCallback;
    std::function<void(const std::vector<uint8_t>&)> outputCallback;
  };

  // Create a scene pack natively (umT5-XXL prompt encode + Wan2.2 VAE
  // first-frame encode -> scene.safetensors). Standalone: does not require
  // load() and does not touch the walk session; the produced pack is loaded
  // by a session via scenePath. Runs on the model's job queue like any job.
  struct SceneCreateJob {
    std::string prompt;              // encoded verbatim
    std::vector<uint8_t> imageBytes; // first frame, PNG or JPEG
    int width{832};                  // multiples of 32
    int height{480};
    std::string t5Path;  // umT5-XXL GGUF/safetensors
    std::string vaePath; // Wan2.2 VAE GGUF/safetensors
    std::string outputPath;
    std::function<void(const std::string&)> progressCallback;
  };

private:
  std::any processWalkStep(const WalkStepJob& job);
  std::any processSceneCreate(const SceneCreateJob& job);

  qvac_lib_inference_addon_sd::WorldSessionConfig config_;
  sd_abot_session_t* session_{nullptr};
  mutable std::atomic<bool> cancelRequested_{false};
  mutable qvac_lib_inference_addon_cpp::RuntimeStats lastStats_;

  struct CumulativeStats {
    int64_t modelLoadMs{0};
    int64_t totalStepMs{0};
    int64_t totalSteps{0};
    int64_t totalFrames{0};
  };
  CumulativeStats stats_{};
};
