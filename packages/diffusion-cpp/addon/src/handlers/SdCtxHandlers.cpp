#include "SdCtxHandlers.hpp"

#include <qvac-lib-inference-addon-cpp/Errors.hpp>

#include "utils/LoggingMacros.hpp"

namespace qvac_lib_inference_addon_sd {

using namespace qvac_errors;

// -- Parse helpers
// -------------------------------------------------------------

static bool parseBool(const std::string& v, const std::string& key) {
  if (v == "true" || v == "1")
    return true;
  if (v == "false" || v == "0")
    return false;
  throw StatusError(
      general_error::InvalidArgument,
      key + " must be 'true'/'1' or 'false'/'0', got: '" + v + "'");
}

static int parseInt(const std::string& v, const std::string& key) {
  try {
    return std::stoi(v);
  } catch (...) {
    throw StatusError(
        general_error::InvalidArgument,
        key + " must be an integer, got: '" + v + "'");
  }
}

static float parseFloat(const std::string& v, const std::string& key) {
  try {
    return std::stof(v);
  } catch (...) {
    throw StatusError(
        general_error::InvalidArgument,
        key + " must be a float, got: '" + v + "'");
  }
}

// -- Handler map
// ---------------------------------------------------------------

const SdCtxHandlersMap SD_CTX_HANDLERS = {

    // -- Compute
    // ----------------------------------------------------------------

    {"threads",
     [](SdCtxConfig& c, const std::string& v) {
       c.nThreads = parseInt(v, "threads");
     }},

    // "fa" is the CLI short-form; "flash_attn" is the long-form -- both
    // accepted.
    {"fa",
     [](SdCtxConfig& c, const std::string& v) {
       c.flashAttn = parseBool(v, "fa");
     }},
    {"flash_attn",
     [](SdCtxConfig& c, const std::string& v) {
       c.flashAttn = parseBool(v, "flash_attn");
     }},
    {"diffusion_fa",
     [](SdCtxConfig& c, const std::string& v) {
       c.diffusionFlashAttn = parseBool(v, "diffusion_fa");
     }},

    // -- Memory management
    // ------------------------------------------------------

    {"mmap",
     [](SdCtxConfig& c, const std::string& v) {
       c.mmap = parseBool(v, "mmap");
     }},
    {"offload_to_cpu",
     [](SdCtxConfig& c, const std::string& v) {
       c.offloadToCpu = parseBool(v, "offload_to_cpu");
     }},
    {"device", [](SdCtxConfig& c, const std::string& v) { c.device = v; }},
    {"clip_on_cpu",
     [](SdCtxConfig& c, const std::string& v) {
       c.keepClipOnCpu = parseBool(v, "clip_on_cpu");
     }},
    {"vae_on_cpu",
     [](SdCtxConfig& c, const std::string& v) {
       c.keepVaeOnCpu = parseBool(v, "vae_on_cpu");
     }},

    // -- Weight precision
    // -------------------------------------------------------

    {"type",
     [](SdCtxConfig& c, const std::string& v) {
       if (v.empty() || v == "auto")
         c.wtype = SD_TYPE_COUNT;
       else if (v == "f32")
         c.wtype = SD_TYPE_F32;
       else if (v == "f16")
         c.wtype = SD_TYPE_F16;
       else if (v == "bf16")
         c.wtype = SD_TYPE_BF16;
       else if (v == "q4_0")
         c.wtype = SD_TYPE_Q4_0;
       else if (v == "q4_1")
         c.wtype = SD_TYPE_Q4_1;
       else if (v == "q4_k")
         c.wtype = SD_TYPE_Q4_K;
       else if (v == "q5_0")
         c.wtype = SD_TYPE_Q5_0;
       else if (v == "q5_1")
         c.wtype = SD_TYPE_Q5_1;
       else if (v == "q5_k")
         c.wtype = SD_TYPE_Q5_K;
       else if (v == "q6_k")
         c.wtype = SD_TYPE_Q6_K;
       else if (v == "q8_0")
         c.wtype = SD_TYPE_Q8_0;
       else if (v == "q2_k")
         c.wtype = SD_TYPE_Q2_K;
       else if (v == "q3_k")
         c.wtype = SD_TYPE_Q3_K;
       else
         throw StatusError(
             general_error::InvalidArgument,
             "type: unknown weight type '" + v + "'");
     }},

    {"tensor_type_rules",
     [](SdCtxConfig& c, const std::string& v) { c.tensorTypeRules = v; }},

    // -- Sampling RNG
    // -----------------------------------------------------------

    {"rng",
     [](SdCtxConfig& c, const std::string& v) {
       if (v == "cpu")
         c.rngType = CPU_RNG;
       else if (v == "cuda")
         c.rngType = CUDA_RNG;
       else if (v == "std_default")
         c.rngType = STD_DEFAULT_RNG;
       else
         throw StatusError(
             general_error::InvalidArgument,
             "rng must be 'cpu', 'cuda', or 'std_default', got: '" + v + "'");
     }},

    {"sampler_rng",
     [](SdCtxConfig& c, const std::string& v) {
       if (v == "cpu")
         c.samplerRngType = CPU_RNG;
       else if (v == "cuda")
         c.samplerRngType = CUDA_RNG;
       else if (v == "std_default")
         c.samplerRngType = STD_DEFAULT_RNG;
       else
         throw StatusError(
             general_error::InvalidArgument,
             "sampler_rng must be 'cpu', 'cuda', or 'std_default', got: '" + v +
                 "'");
     }},

    // -- Prediction type
    // --------------------------------------------------------
    // SD1.x  -> "eps"         (epsilon prediction)
    // SD2.x  -> "v"           (v-prediction)
    // SD3    -> "flow"        (flow matching)
    // FLUX.2 -> "flux2_flow"  (FLUX.2 flow matching)
    // Leave unset (or "auto") to use PREDICTION_COUNT sentinel for
    // auto-detection.

    {"prediction",
     [](SdCtxConfig& c, const std::string& v) {
       if (v.empty() || v == "auto")
         c.prediction = PREDICTION_COUNT; // sentinel: auto-detect
       else if (v == "eps")
         c.prediction = EPS_PRED;
       else if (v == "v")
         c.prediction = V_PRED;
       else if (v == "edm_v")
         c.prediction = EDM_V_PRED;
       else if (v == "flow")
         c.prediction = FLOW_PRED;
       else if (v == "flux_flow")
         c.prediction = FLUX_FLOW_PRED;
       else if (v == "flux2_flow")
         c.prediction = FLUX2_FLOW_PRED;
       else
         throw StatusError(
             general_error::InvalidArgument,
             "prediction must be one of: eps, v, edm_v, flow, flux_flow, "
             "flux2_flow");
     }},

    // -- LoRA apply mode
    // --------------------------------------------------------

    {"lora_apply_mode",
     [](SdCtxConfig& c, const std::string& v) {
       if (v == "auto")
         c.loraApplyMode = LORA_APPLY_AUTO;
       else if (v == "immediately")
         c.loraApplyMode = LORA_APPLY_IMMEDIATELY;
       else if (v == "at_runtime")
         c.loraApplyMode = LORA_APPLY_AT_RUNTIME;
       else
         throw StatusError(
             general_error::InvalidArgument,
             "lora_apply_mode must be 'auto', 'immediately', or 'at_runtime'");
     }},

    // -- Flow matching (FLUX)
    // ---------------------------------------------------

    {"flow_shift",
     [](SdCtxConfig& c, const std::string& v) {
       c.flowShift = parseFloat(v, "flow_shift");
     }},

    // -- Convolution optimisations
    // ----------------------------------------------

    {"diffusion_conv_direct",
     [](SdCtxConfig& c, const std::string& v) {
       c.diffusionConvDirect = parseBool(v, "diffusion_conv_direct");
     }},

    {"vae_conv_direct",
     [](SdCtxConfig& c, const std::string& v) {
       c.vaeConvDirect = parseBool(v, "vae_conv_direct");
     }},

    // -- SDXL compat
    // ------------------------------------------------------------

    {"force_sdxl_vae_conv_scale",
     [](SdCtxConfig& c, const std::string& v) {
       c.forceSDXLVaeConvScale = parseBool(v, "force_sdxl_vae_conv_scale");
     }},

    // -- Backend loading
    // ------------------------------------------------------------

    {"backendsDir",
     [](SdCtxConfig& c, const std::string& v) { c.backendsDir = v; }},

    // -- Logging
    // ----------------------------------------------------------------

    {"verbosity",
     [](SdCtxConfig& /*c*/, const std::string& v) {
       std::unordered_map<std::string, std::string> m{{"verbosity", v}};
       logging::setVerbosityLevel(m);
     }},

};

// -----------------------------------------------------------------------------

void applySdCtxHandlers(
    SdCtxConfig& config,
    const std::unordered_map<std::string, std::string>& configMap) {
  for (const auto& [key, value] : configMap) {
    if (auto it = SD_CTX_HANDLERS.find(key); it != SD_CTX_HANDLERS.end()) {
      it->second(config, value);
    }
    // Unknown keys are silently ignored for forward compatibility.
  }
}

} // namespace qvac_lib_inference_addon_sd
