#pragma once

#include <any>
#include <atomic>
#include <functional>
#include <memory>
#include <streambuf>
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
 *   SD1.x  — all-in-one .ckpt / .safetensors via modelPath
 *   SD2.x  — same as SD1; set prediction="v" in context config
 *   SDXL   — all-in-one + optional split CLIP-G; set force_sdxl_vae_conv_scale
 * if needed FLUX.2 [klein] — split: diffusionModelPath + llmPath (Qwen3) +
 * vaeModel
 *
 * Video generation (txt2vid) is intentionally unsupported.
 *
 * Lifecycle:
 *   1. Construct  — stores SdCtxConfig, allocates nothing
 *   2. load()     — calls new_sd_ctx(); weights are read from disk here
 *   3. process()  — runs txt2img / img2img via generate_image()
 *   4. unload()   — calls free_sd_ctx() and releases all GPU/CPU memory
 *      The destructor calls unload() automatically if the caller forgets.
 */
class SdModel : public qvac_lib_inference_addon_cpp::model::IModel,
                public qvac_lib_inference_addon_cpp::model::IModelAsyncLoad,
                public qvac_lib_inference_addon_cpp::model::IModelCancel {
public:
  SdModel(const SdModel&) = delete;
  SdModel& operator=(const SdModel&) = delete;
  SdModel(SdModel&&) = delete;
  SdModel& operator=(SdModel&&) = delete;

  /**
   * Stores config. Does NOT load weights — call load() for that.
   * @param config  Fully resolved load-time configuration (paths + context
   * options).
   */
  explicit SdModel(qvac_lib_inference_addon_sd::SdCtxConfig config);

  /**
   * Calls unload() — releases the sd_ctx if still alive.
   */
  ~SdModel() override;

  [[nodiscard]] std::string getName() const final { return "SdModel"; }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Load model weights into memory.
   * Builds sd_ctx_params_t from the stored SdCtxConfig and calls new_sd_ctx().
   * Throws qvac_errors::StatusError on failure.
   * No-op if already loaded.
   */
  void load();

  /**
   * Release all model memory (calls free_sd_ctx).
   * Safe to call multiple times. The object can be load()-ed again afterwards.
   */
  void unload();

  /**
   * Returns true if weights are currently loaded (sd_ctx is live).
   */
  [[nodiscard]] bool isLoaded() const noexcept { return sdCtx_ != nullptr; }

  // ── IModelAsyncLoad ────────────────────────────────────────────────────────

  void waitForLoadInitialization() final { load(); }

  void setWeightsForFile(
      const std::string& /*filename*/,
      std::unique_ptr<std::basic_streambuf<char>>&& /*buf*/) final {}

  // ── IModel ─────────────────────────────────────────────────────────────────

  /**
   * Run a generation job.
   * Input must be a SdModel::GenerationJob wrapped in std::any.
   * Throws if the model is not loaded.
   */
  std::any process(const std::any& input) final;

  // ── IModelCancel ───────────────────────────────────────────────────────────

  void cancel() const final;

  /** True if cancel() has been called since the last job started. */
  [[nodiscard]] bool isCancelRequested() const noexcept {
    return cancelRequested_.load();
  }

  [[nodiscard]] qvac_lib_inference_addon_cpp::RuntimeStats
  runtimeStats() const final;

  // ── Log callback ───────────────────────────────────────────────────────────

  static void
  sdLogCallback(sd_log_level_t level, const char* text, void* userData);

  // ── Generation job input type ─────────────────────────────────────────────

  struct GenerationJob {
    std::string paramsJson;
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

  // ── Cumulative stats ──────────────────────────────────────────────────────
  int64_t modelLoadMs_{0};
  int64_t totalGenerationMs_{0};
  int64_t totalWallMs_{0};
  int64_t totalSteps_{0};
  int64_t totalGenerations_{0};
  int64_t totalImages_{0};
  int64_t totalPixels_{0};
};
