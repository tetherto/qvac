#pragma once

#include <functional>
#include <limits>
#include <string>
#include <unordered_map>

#include <qvac-lib-inference-addon-cpp/Errors.hpp>
#include <stable-diffusion.h>

namespace qvac_lib_inference_addon_sd {

/**
 * All load-time configuration for the stable-diffusion context.
 *
 * Populated in two steps inside AddonJs::createInstance:
 *   1. Paths set directly from JS args (path, clipLPath, llmPath, …)
 *   2. Config options resolved via applySdCtxHandlers(config, configMap)
 *
 * Consumed once in SdModel::load() where new_sd_ctx() is called.
 *
 * Supported models:
 *   SD1.x        — uses modelPath (all-in-one .ckpt / .safetensors / GGUF)
 *   SD2.x        — same as SD1, add prediction="v" to the config
 *   SDXL         — uses modelPath (all-in-one GGUF); set
 * force_sdxl_vae_conv_scale if needed SD3 Medium   — all-in-one GGUF via
 * modelPath (CLIP-L, CLIP-G, T5-XXL baked in) OR split layout:
 * diffusionModelPath + clipLPath + clipGPath + t5XxlPath FLUX.2 [klein] — uses
 * diffusionModelPath + llmPath (Qwen3) + vaePath
 */
struct SdCtxConfig {
  // ── Model file paths ───────────────────────────────────────────────────────
  // All paths are absolute; empty string = not used.

  std::string modelPath; // model_path            — SD1.x/SD2.x/SDXL/SD3
                         // all-in-one checkpoint
  std::string diffusionModelPath; // diffusion_model_path  — FLUX.2 [klein] or
                                  // SD3 pure diffusion GGUF
  std::string clipLPath; // clip_l_path           — CLIP-L text encoder (SD3
                         // split / SDXL)
  std::string clipGPath; // clip_g_path           — CLIP-G text encoder (SD3
                         // split / SDXL)
  std::string
      t5XxlPath; // t5xxl_path            — T5-XXL text encoder (SD3 split)
  std::string
      llmPath; // llm_path              — LLM text encoder (FLUX.2 → Qwen3)
  std::string vaePath; // vae_path              — standalone VAE decoder weights
  std::string taesdPath; // taesd_path            — Tiny AutoEncoder (optional
                         // fast preview)

  // ── Compute ───────────────────────────────────────────────────────────────
  int nThreads = -1; // n_threads:            -1 = auto-detect physical cores
  bool flashAttn = false; // flash_attn:           full-model flash attention
  bool diffusionFlashAttn =
      false; // diffusion_flash_attn: flash attention on diffusion only

  // ── Memory management ─────────────────────────────────────────────────────
  bool mmap = false;         // enable_mmap:           memory-map the GGUF file
  bool offloadToCpu = false; // offload_params_to_cpu: keep weights in RAM, load
                             // per-layer to GPU
  std::string device = "gpu"; // "cpu" or "gpu" — selects compute backend
  bool keepClipOnCpu =
      false; // keep_clip_on_cpu:      keep CLIP encoder in CPU RAM
  bool keepVaeOnCpu =
      false; // keep_vae_on_cpu:       keep VAE decoder in CPU RAM

  // ── Precision ─────────────────────────────────────────────────────────────
  sd_type_t wtype =
      SD_TYPE_COUNT; // global weight type override; COUNT = auto (use GGUF)
  std::string tensorTypeRules; // per-tensor rules e.g. "^vae.=f16,model.=q8_0"

  // ── Sampling RNG (Random Number Generator) ────────────────────────────────
  // CUDA_RNG = philox RNG (default in sd_ctx_params_init; not GPU-specific
  // despite the name) RNG_TYPE_COUNT = auto for sampler RNG
  rng_type_t rngType = CUDA_RNG;              // rng_type
  rng_type_t samplerRngType = RNG_TYPE_COUNT; // sampler_rng_type

  // ── Prediction type ───────────────────────────────────────────────────────
  // PREDICTION_COUNT = auto-detect from model GGUF metadata (recommended).
  // Override if the GGUF lacks metadata (community conversions often do):
  //   EPS_PRED        → SD1.x
  //   V_PRED          → SD2.x
  //   FLOW_PRED       → SD3 (flow matching)
  //   FLUX2_FLOW_PRED → FLUX.2 [klein]
  prediction_t prediction = PREDICTION_COUNT; // auto

  // ── LoRA (Low-Rank Adaptation) apply mode ─────────────────────────────────
  lora_apply_mode_t loraApplyMode = LORA_APPLY_AUTO;

  // ── Flow matching (FLUX, SD3) ─────────────────────────────────────────────
  // INFINITY = use the model's embedded flow_shift value (recommended).
  // Override only to tune noise-schedule quality.
  float flowShift = std::numeric_limits<float>::infinity();

  // ── Convolution kernel options ────────────────────────────────────────────
  bool diffusionConvDirect = false; // ggml_conv2d_direct in diffusion model
  bool vaeConvDirect = false;       // ggml_conv2d_direct in VAE

  // ── Tiling convolutions (produces seamlessly tileable images) ─────────────
  bool circularX = false; // circular RoPE wrap on X-axis (width)
  bool circularY = false; // circular RoPE wrap on Y-axis (height)

  // ── SDXL compatibility ────────────────────────────────────────────────────
  bool forceSDXLVaeConvScale = false; // force SDXL VAE conv scale (compat fix)

  // ── Internal ──────────────────────────────────────────────────────────────
  // Upstream defaults to true, which frees model weight buffers after each
  // generate_image_internal() call. The addon reuses a single sd_ctx across
  // multiple generations, so freeing params after the first run causes a
  // use-after-free SIGSEGV on the second run (including cancel-then-rerun).
  bool freeParamsImmediately = false;
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handler function for a single configMap key.
 * Receives the config struct (by ref) and the raw string value from JS.
 * Throws qvac_errors::StatusError on invalid input.
 */
using SdCtxHandlerFn = std::function<void(SdCtxConfig&, const std::string&)>;
using SdCtxHandlersMap = std::unordered_map<std::string, SdCtxHandlerFn>;

/** All supported load-time config keys and their handlers. */
extern const SdCtxHandlersMap SD_CTX_HANDLERS;

/**
 * Apply SD_CTX_HANDLERS to configMap, writing results into config.
 * Unknown keys are silently ignored (forward compatibility).
 */
void applySdCtxHandlers(
    SdCtxConfig& config,
    const std::unordered_map<std::string, std::string>& configMap);

} // namespace qvac_lib_inference_addon_sd
