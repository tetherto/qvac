#include "SdCtxHandlers.hpp"

#include <cstddef>

#include <inference-addon-cpp/Errors.hpp>

#include "utils/LoggingMacros.hpp"

namespace qvac_lib_inference_addon_sd {

using namespace qvac_errors;

// -- Parse helpers
// -------------------------------------------------------------

static bool parseBool(const std::string& val, const std::string& key) {
  if (val == "true" || val == "1") {
    return true;
  }
  if (val == "false" || val == "0") {
    return false;
  }
  throw StatusError(
      general_error::InvalidArgument,
      key + " must be 'true'/'1' or 'false'/'0', got: '" + val + "'");
}

static int parseInt(const std::string& val, const std::string& key) {
  try {
    return std::stoi(val);
  } catch (...) {
    throw StatusError(
        general_error::InvalidArgument,
        key + " must be an integer, got: '" + val + "'");
  }
}

static int parsePositiveInt(const std::string& val, const std::string& key) {
  const int parsed = parseInt(val, key);
  if (parsed <= 0) {
    throw StatusError(
        general_error::InvalidArgument,
        key + " must be a positive integer, got: '" + val + "'");
  }
  return parsed;
}

static int
parseAutoOrPositiveInt(const std::string& value, const std::string& key) {
  int parsed = 0;
  std::size_t parsedChars = 0;
  try {
    parsed = std::stoi(value, &parsedChars);
  } catch (...) {
    throw StatusError(
        general_error::InvalidArgument,
        key + " must be -1 (auto) or a positive integer, got: '" + value + "'");
  }
  if (parsedChars == value.size() && (parsed == -1 || parsed > 0)) {
    return parsed;
  }
  throw StatusError(
      general_error::InvalidArgument,
      key + " must be -1 (auto) or a positive integer, got: '" + value + "'");
}

static float parseFloat(const std::string& val, const std::string& key) {
  try {
    return std::stof(val);
  } catch (...) {
    throw StatusError(
        general_error::InvalidArgument,
        key + " must be a float, got: '" + val + "'");
  }
}

// -- Handler map
// ---------------------------------------------------------------

// NOLINTNEXTLINE(bugprone-throwing-static-initialization)
const SdCtxHandlersMap SD_CTX_HANDLERS = {

    // -- Compute
    // ----------------------------------------------------------------

    {"threads",
     [](SdCtxConfig& cfg, const std::string& val) {
       cfg.nThreads = parseAutoOrPositiveInt(val, "threads");
     }},

    // "fa" is the CLI short-form; "flash_attn" is the long-form -- both
    // accepted.
    {"fa",
     [](SdCtxConfig& cfg, const std::string& val) {
       cfg.flashAttn = parseBool(val, "fa");
     }},
    {"flash_attn",
     [](SdCtxConfig& cfg, const std::string& val) {
       cfg.flashAttn = parseBool(val, "flash_attn");
     }},
    {"diffusion_fa",
     [](SdCtxConfig& cfg, const std::string& val) {
       cfg.diffusionFlashAttn = parseBool(val, "diffusion_fa");
     }},

    // -- Memory management
    // ------------------------------------------------------

    {"mmap",
     [](SdCtxConfig& cfg, const std::string& val) {
       cfg.mmap = parseBool(val, "mmap");
     }},
    {"offload_to_cpu",
     [](SdCtxConfig& cfg, const std::string& val) {
       cfg.offloadToCpu = parseBool(val, "offload_to_cpu");
     }},
    {"device",
     [](SdCtxConfig& cfg, const std::string& val) { cfg.device = val; }},
    {"clip_on_cpu",
     [](SdCtxConfig& cfg, const std::string& val) {
       cfg.keepClipOnCpu = parseBool(val, "clip_on_cpu");
     }},
    {"vae_on_cpu",
     [](SdCtxConfig& cfg, const std::string& val) {
       cfg.keepVaeOnCpu = parseBool(val, "vae_on_cpu");
     }},

    // -- Weight precision
    // -------------------------------------------------------

    {"type",
     [](SdCtxConfig& cfg, const std::string& val) {
       if (val.empty() || val == "auto") {
         cfg.wtype = SD_TYPE_COUNT;
       } else if (val == "f32") {
         cfg.wtype = SD_TYPE_F32;
       } else if (val == "f16") {
         cfg.wtype = SD_TYPE_F16;
       } else if (val == "bf16") {
         cfg.wtype = SD_TYPE_BF16;
       } else if (val == "q4_0") {
         cfg.wtype = SD_TYPE_Q4_0;
       } else if (val == "q4_1") {
         cfg.wtype = SD_TYPE_Q4_1;
       } else if (val == "q4_k") {
         cfg.wtype = SD_TYPE_Q4_K;
       } else if (val == "q5_0") {
         cfg.wtype = SD_TYPE_Q5_0;
       } else if (val == "q5_1") {
         cfg.wtype = SD_TYPE_Q5_1;
       } else if (val == "q5_k") {
         cfg.wtype = SD_TYPE_Q5_K;
       } else if (val == "q6_k") {
         cfg.wtype = SD_TYPE_Q6_K;
       } else if (val == "q8_0") {
         cfg.wtype = SD_TYPE_Q8_0;
       } else if (val == "q2_k") {
         cfg.wtype = SD_TYPE_Q2_K;
       } else if (val == "q3_k") {
         cfg.wtype = SD_TYPE_Q3_K;
       } else {
         throw StatusError(
             general_error::InvalidArgument,
             "type: unknown weight type '" + val + "'");
       }
     }},

    {"tensor_type_rules",
     [](SdCtxConfig& cfg, const std::string& val) {
       cfg.tensorTypeRules = val;
     }},

    // -- Sampling RNG
    // -----------------------------------------------------------

    {"rng",
     [](SdCtxConfig& cfg, const std::string& val) {
       if (val == "cpu") {
         cfg.rngType = CPU_RNG;
       } else if (val == "cuda") {
         cfg.rngType = CUDA_RNG;
       } else if (val == "std_default") {
         cfg.rngType = STD_DEFAULT_RNG;
       } else {
         throw StatusError(
             general_error::InvalidArgument,
             "rng must be 'cpu', 'cuda', or 'std_default', got: '" + val + "'");
       }
     }},

    {"sampler_rng",
     [](SdCtxConfig& cfg, const std::string& val) {
       if (val == "cpu") {
         cfg.samplerRngType = CPU_RNG;
       } else if (val == "cuda") {
         cfg.samplerRngType = CUDA_RNG;
       } else if (val == "std_default") {
         cfg.samplerRngType = STD_DEFAULT_RNG;
       } else {
         throw StatusError(
             general_error::InvalidArgument,
             "sampler_rng must be 'cpu', 'cuda', or 'std_default', got: '" +
                 val + "'");
       }
     }},

    // -- Prediction type
    // --------------------------------------------------------
    // SD2.x  -> "v"           (v-prediction)
    // SD3    -> "flow"        (flow matching)
    // FLUX.2 -> "flux2_flow"  (FLUX.2 flow matching)
    // Leave unset (or "auto") to use PREDICTION_COUNT sentinel for
    // auto-detection.

    {"prediction",
     [](SdCtxConfig& cfg, const std::string& val) {
       if (val.empty() || val == "auto") {
         cfg.prediction = PREDICTION_COUNT; // sentinel: auto-detect
       } else if (val == "eps") {
         cfg.prediction = EPS_PRED;
       } else if (val == "v") {
         cfg.prediction = V_PRED;
       } else if (val == "edm_v") {
         cfg.prediction = EDM_V_PRED;
       } else if (val == "flow") {
         cfg.prediction = FLOW_PRED;
       } else if (val == "flux2_flow") {
         cfg.prediction = FLUX2_FLOW_PRED;
       } else {
         throw StatusError(
             general_error::InvalidArgument,
             "prediction must be one of: eps, v, edm_v, flow, flux2_flow");
       }
     }},

    // -- LoRA apply mode
    // --------------------------------------------------------

    {"lora_apply_mode",
     [](SdCtxConfig& cfg, const std::string& val) {
       if (val == "auto") {
         cfg.loraApplyMode = LORA_APPLY_AUTO;
       } else if (val == "immediately") {
         cfg.loraApplyMode = LORA_APPLY_IMMEDIATELY;
       } else if (val == "at_runtime") {
         cfg.loraApplyMode = LORA_APPLY_AT_RUNTIME;
       } else {
         throw StatusError(
             general_error::InvalidArgument,
             "lora_apply_mode must be 'auto', 'immediately', or 'at_runtime'");
       }
     }},

    // -- Flow matching (FLUX)
    // ---------------------------------------------------

    {"flow_shift",
     [](SdCtxConfig& cfg, const std::string& val) {
       cfg.flowShift = parseFloat(val, "flow_shift");
     }},

    // -- Convolution optimisations
    // ----------------------------------------------

    {"diffusion_conv_direct",
     [](SdCtxConfig& cfg, const std::string& val) {
       cfg.diffusionConvDirect = parseBool(val, "diffusion_conv_direct");
     }},

    {"vae_conv_direct",
     [](SdCtxConfig& cfg, const std::string& val) {
       cfg.vaeConvDirect = parseBool(val, "vae_conv_direct");
     }},

    // -- SDXL compat
    // ------------------------------------------------------------

    {"force_sdxl_vae_conv_scale",
     [](SdCtxConfig& cfg, const std::string& val) {
       cfg.forceSDXLVaeConvScale = parseBool(val, "force_sdxl_vae_conv_scale");
     }},

    // -- Preview callback
    // ------------------------------------------------------------
    // preview_mode maps strings to preview_t enum. Accepts "none", "proj",
    // "tae", "vae". Empty string / "none" disables previews (default).
    // Note: "tae" additionally requires taesdPath to be set at context load.

    {"preview_mode",
     [](SdCtxConfig& c, const std::string& v) {
       if (v.empty() || v == "none")
         c.previewMode = PREVIEW_NONE;
       else if (v == "proj")
         c.previewMode = PREVIEW_PROJ;
       else if (v == "tae")
         c.previewMode = PREVIEW_TAE;
       else if (v == "vae")
         c.previewMode = PREVIEW_VAE;
       else
         throw StatusError(
             general_error::InvalidArgument,
             "preview_mode must be 'none', 'proj', 'tae', or 'vae', got: '" +
                 v + "'");
     }},

    {"preview_interval",
     [](SdCtxConfig& c, const std::string& v) {
       int n = parseInt(v, "preview_interval");
       if (n < 1)
         throw StatusError(
             general_error::InvalidArgument,
             "preview_interval must be >= 1, got: " + std::to_string(n));
       c.previewInterval = n;
     }},

    {"preview_denoised",
     [](SdCtxConfig& c, const std::string& v) {
       c.previewDenoised = parseBool(v, "preview_denoised");
     }},

    {"preview_noisy",
     [](SdCtxConfig& c, const std::string& v) {
       c.previewNoisy = parseBool(v, "preview_noisy");
     }},

    // -- ESRGAN upscaler
    // ------------------------------------------------------------

    {"upscaler_tile_size",
     [](SdCtxConfig& cfg, const std::string& val) {
       cfg.upscalerTileSize = parsePositiveInt(val, "upscaler_tile_size");
     }},

    {"upscaler_direct",
     [](SdCtxConfig& cfg, const std::string& val) {
       cfg.upscalerDirect = parseBool(val, "upscaler_direct");
     }},

    {"upscaler_offload_params_to_cpu",
     [](SdCtxConfig& cfg, const std::string& val) {
       cfg.upscalerOffloadParamsToCpu =
           parseBool(val, "upscaler_offload_params_to_cpu");
     }},

    {"upscaler_threads",
     [](SdCtxConfig& cfg, const std::string& val) {
       cfg.upscalerThreads = parseAutoOrPositiveInt(val, "upscaler_threads");
     }},

    // -- Backend loading
    // ------------------------------------------------------------

    {"backendsDir",
     [](SdCtxConfig& cfg, const std::string& val) { cfg.backendsDir = val; }},

    // -- Logging
    // ----------------------------------------------------------------

    {"verbosity",
     [](SdCtxConfig& /*cfg*/, const std::string& val) {
       std::unordered_map<std::string, std::string> map{{"verbosity", val}};
       logging::setVerbosityLevel(map);
     }},

};

// -----------------------------------------------------------------------------

void applySdCtxHandlers(
    SdCtxConfig& config,
    const std::unordered_map<std::string, std::string>& configMap) {
  for (const auto& [key, value] : configMap) {
    if (auto found = SD_CTX_HANDLERS.find(key);
        found != SD_CTX_HANDLERS.end()) {
      found->second(config, value);
    }
    // Unknown keys are silently ignored for forward compatibility.
  }
}

} // namespace qvac_lib_inference_addon_sd
