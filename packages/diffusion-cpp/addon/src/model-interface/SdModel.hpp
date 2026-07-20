#pragma once

#include <any>
#include <atomic>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/RuntimeStats.hpp>
#include <picojson/picojson.h>
#include <stable-diffusion.h>

#include "handlers/SdCtxHandlers.hpp"
#include "handlers/SdGenHandlers.hpp"
#include "handlers/SdVidGenHandlers.hpp"
#include "utils/EsrganUpscaler.hpp"

/**
 * Core stable-diffusion.cpp model wrapper.
 *
 * Supported model families:
 *   SD1.x  -- all-in-one .ckpt / .safetensors via modelPath
 *   SD2.x  -- same as SD1; set prediction="v" in context config
 *   SDXL   -- all-in-one + optional split CLIP-G; set force_sdxl_vae_conv_scale
 * if needed FLUX.2 [klein] -- split: diffusionModelPath + llmPath (Qwen3) +
 * vaeModel
 *   Wan 2.1 / Wan 2.2 -- video: diffusionModelPath + (optional)
 * highNoiseDiffusionModelPath + t5xxlPath (UMT5-XXL) + vaePath
 *
 * Modes dispatched by SdModel::process() based on the top-level JSON
 * "mode" key:
 *   txt2img / img2img       -> generate_image() path
 *   txt2vid / img2vid       -> generate_video() path (Wan)
 *
 * Lifecycle:
 *   1. Construct  -- stores SdCtxConfig, allocates nothing
 *   2. load()     -- calls new_sd_ctx(); weights are read from disk here
 *   3. process()  -- runs the selected mode via generate_image() or
 *                    generate_video(); delivers bytes via outputCallback
 *                    (image PNG or video AVI) and per-frame PNGs via
 *                    frameCallback if supplied.
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

  // -- Generation job input type ---------------------------------------------

  struct GenerationJob {
    std::string paramsJson;
    /** Raw init-image bytes (PNG/JPEG) passed directly from the JS layer
     *  as a Uint8Array, bypassing JSON serialisation. Falls back to the
     *  JSON "init_image_bytes" array when empty (e.g. C++ unit tests).
     *  Mutually exclusive with initImagesBytes -- at most one is non-empty.
     *  For video modes: first frame for img2vid. */
    std::vector<uint8_t> initImageBytes;
    /** FLUX "fusion" mode -- multiple reference images (PNG/JPEG bytes) passed
     *  in as a JS array of Uint8Array. Each blob becomes a separate ref_image
     *  that the FLUX transformer attends to via in-context conditioning.
     *  Addressed in the prompt as @image1, @image2, ...
     *  Only valid for FLUX / FLUX2 models (enforced in SdModel::process()). */
    std::vector<std::vector<uint8_t>> initImagesBytes;
    /** Control frames for Wan VACE-guided video generation (PNG/JPEG bytes
     *  per frame). Empty for unguided txt2vid / img2vid. When supplied,
     *  vaceStrength controls how strongly these frames guide generation. */
    std::vector<std::vector<uint8_t>> controlFramesBytes;
    /** Called each diffusion step: {"step":N,"total":M,"elapsed_ms":T} */
    std::function<void(const std::string&)> progressCallback;
    /** Called once per output image (txt2img / img2img) with PNG bytes,
     *  OR once for the full video (txt2vid / img2vid) with MJPG AVI bytes.
     *  Only one invocation per job for video modes. */
    std::function<void(const std::vector<uint8_t>&)> outputCallback;
    /** Optional per-frame fan-out for video modes. When set, fires once
     *  per decoded frame with PNG-encoded bytes so JS consumers can do
     *  their own muxing / previewing in parallel with the AVI build. */
    std::function<void(
        const std::vector<uint8_t>&, int /*index*/, int /*total*/)>
        frameCallback;
  };

private:
  sd_image_t upscaleImage(const sd_image_t& inputImage, int repeats);

  // Per-mode handlers split from the unified process() entry point. Both
  // run under the progress/abort guard owned by process(); return value is
  // always std::any{} (outputs delivered via job callbacks).
  std::any
  processImage(const GenerationJob& job, const picojson::value& parsed);
  std::any
  processVideo(const GenerationJob& job, const picojson::value& parsed);

  const qvac_lib_inference_addon_sd::SdCtxConfig config_;

  // True when the loaded model is LTX-2 (LTXAV), inferred from the presence of
  // the LTX-only embeddings-connectors input. Drives model-aware per-job
  // validation in processVideo (LTX uses 8*k+1 frames / x32 dims vs Wan's
  // 4*k+1 / x16). Set in load().
  bool isLtxModel_{false};

  std::unique_ptr<sd_ctx_t, decltype(&free_sd_ctx)> sdCtx_;
  qvac_lib_inference_addon_sd::EsrganUpscaler upscaler_;
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
    // Video-specific counters (zero unless a video mode was used)
    int64_t totalVideos{0};
    int64_t totalVideoFrames{0};
  };
  CumulativeStats stats_{};
};
