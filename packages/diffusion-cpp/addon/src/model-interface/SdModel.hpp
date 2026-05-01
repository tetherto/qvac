#pragma once

#include <any>
#include <atomic>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include <qvac-lib-inference-addon-cpp/ModelInterfaces.hpp>
#include <qvac-lib-inference-addon-cpp/RuntimeStats.hpp>
#include <stable-diffusion.h>

#include "handlers/SdCtxHandlers.hpp"
#include "handlers/SdGenHandlers.hpp"

/**
 * Core stable-diffusion.cpp model wrapper.
 *
 * Supported model families:
 *   SD1.x  -- all-in-one .ckpt / .safetensors via modelPath
 *   SD2.x  -- same as SD1; set prediction="v" in context config
 *   SDXL   -- all-in-one + optional split CLIP-G; set force_sdxl_vae_conv_scale
 * if needed FLUX.2 [klein] -- split: diffusionModelPath + llmPath (Qwen3) +
 * vaeModel
 *
 * Video generation (txt2vid) is intentionally unsupported.
 *
 * Lifecycle:
 *   1. Construct  -- stores SdCtxConfig, allocates nothing
 *   2. load()     -- calls new_sd_ctx(); weights are read from disk here
 *   3. process()  -- runs txt2img / img2img via generate_image()
 *   4. Destroy    -- destructor calls free_sd_ctx() and releases all GPU/CPU
 *                   memory; to unload simply let the object go out of scope
 */
class SdModel : public qvac_lib_inference_addon_cpp::model::IModel,
                public qvac_lib_inference_addon_cpp::model::IModelCancel {
public:
  SdModel(const SdModel&) = delete;
  SdModel& operator=(const SdModel&) = delete;
  SdModel(SdModel&&) = delete;
  SdModel& operator=(SdModel&&) = delete;

  /**
   * Stores config. Does NOT load weights -- call load() for that.
   * @param config  Fully resolved load-time configuration (paths + context
   * options).
   */
  explicit SdModel(qvac_lib_inference_addon_sd::SdCtxConfig config);

  /**
   * Releases the sd_ctx and all associated GPU/CPU memory.
   */
  ~SdModel() override;

  [[nodiscard]] std::string getName() const final { return "SdModel"; }

  // -- Lifecycle --------------------------------------------------------------

  /**
   * Load model weights into memory.
   * Builds sd_ctx_params_t from the stored SdCtxConfig and calls new_sd_ctx().
   * Throws qvac_errors::StatusError on failure.
   * No-op if already loaded.
   */
  void load();

  /**
   * Returns true if weights are currently loaded (sd_ctx is live).
   */
  [[nodiscard]] bool isLoaded() const noexcept { return sdCtx_ != nullptr; }

  // -- IModel -----------------------------------------------------------------

  /**
   * Run a generation job.
   * Input must be a SdModel::GenerationJob wrapped in std::any.
   * Throws if the model is not loaded.
   */
  std::any process(const std::any& input) final;

  // -- IModelCancel -----------------------------------------------------------

  void cancel() const final;

  /** True if cancel() has been called since the last job started. */
  [[nodiscard]] bool isCancelRequested() const noexcept {
    return cancelRequested_.load();
  }

  [[nodiscard]] qvac_lib_inference_addon_cpp::RuntimeStats
  runtimeStats() const final;

  // -- Log callback -----------------------------------------------------------

  static void
  sdLogCallback(sd_log_level_t level, const char* text, void* userData);

  // -- Generation job input type ---------------------------------------------

  struct GenerationJob {
    std::string paramsJson;
    /** Raw init-image bytes (PNG/JPEG) passed directly from the JS layer
     *  as a Uint8Array, bypassing JSON serialisation. Falls back to the
     *  JSON "init_image_bytes" array when empty (e.g. C++ unit tests).
     *  Mutually exclusive with initImagesBytes -- at most one is non-empty. */
    std::vector<uint8_t> initImageBytes;
    /** FLUX "fusion" mode -- multiple reference images (PNG/JPEG bytes) passed
     *  in as a JS array of Uint8Array. Each blob becomes a separate ref_image
     *  that the FLUX transformer attends to via in-context conditioning.
     *  Addressed in the prompt as @image1, @image2, ...
     *  Only valid for FLUX / FLUX2 models (enforced in SdModel::process()). */
    std::vector<std::vector<uint8_t>> initImagesBytes;
    /** Called each diffusion step: {"step":N,"total":M,"elapsed_ms":T} */
    std::function<void(const std::string&)> progressCallback;
    /** Called once per output image with PNG-encoded bytes */
    std::function<void(const std::vector<uint8_t>&)> outputCallback;
  };

private:
  static std::vector<uint8_t> encodeToPng(const sd_image_t& img);
  static sd_image_t decodePng(const std::vector<uint8_t>& pngBytes);

  const qvac_lib_inference_addon_sd::SdCtxConfig config_;

  std::unique_ptr<sd_ctx_t, decltype(&free_sd_ctx)> sdCtx_;
  mutable std::atomic<bool> cancelRequested_{false};
  mutable qvac_lib_inference_addon_cpp::RuntimeStats lastStats_{};

  // -- Cumulative stats ------------------------------------------------------
  struct CumulativeStats {
    int64_t modelLoadMs{0};
    int64_t totalGenerationMs{0};
    int64_t totalWallMs{0};
    int64_t totalSteps{0};
    int64_t totalGenerations{0};
    int64_t totalImages{0};
    int64_t totalPixels{0};
  };
  CumulativeStats stats_{};
};
