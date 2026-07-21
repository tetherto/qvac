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
  int nThreads = -1;        // -1 = auto-detect physical cores
  int64_t seed = 42;        // walk noise seed
  int numFramePerBlock = 0; // 0 = model default (3)
  int localAttnSize = 0;    // 0 = config default; latent-frame window
  bool offloadParamsToCpu = false;
};

} // namespace qvac_lib_inference_addon_sd

// One generated block per step: the DiT denoises num_frame_per_block latent
// frames under the given keyboard action, taehv decodes them, and each RGB
// frame is delivered to the output callback as a PNG.
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
    uint32_t actionMask{0}; // bit 0..7 = W,A,S,D,I,J,K,L held
    std::function<void(const std::string&)> progressCallback;
    std::function<void(const std::vector<uint8_t>&)> outputCallback;
  };

private:
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
