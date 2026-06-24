#include "SdVidGenHandlers.hpp"

#include <inference-addon-cpp/Errors.hpp>

#include "SdParsers.hpp"

namespace qvac_lib_inference_addon_sd {

using namespace qvac_errors;
using parsers::parseCacheMode;
using parsers::parseCachePreset;
using parsers::parseSampler;
using parsers::parseScheduler;
using parsers::parseVaeTileSize;
using parsers::requireBool;
using parsers::requireInt;
using parsers::requireInt64;
using parsers::requireNum;
using parsers::requirePositiveInt;
using parsers::requireRange;
using parsers::requireStr;

// -----------------------------------------------------------------------------
// Handler map
// -----------------------------------------------------------------------------

const SdVidGenHandlersMap SD_VID_GEN_HANDLERS = {

    // -- Mode -----------------------------------------------------------------

    {"mode",
     [](SdVidGenConfig& c, const picojson::value& v) {
       const auto mode = requireStr(v, "mode");
       if (mode != "txt2vid" && mode != "img2vid")
         throw StatusError(
             general_error::InvalidArgument,
             "mode must be 'txt2vid' or 'img2vid', got: '" + mode + "'");
       c.mode = mode;
     }},

    // -- Prompt ---------------------------------------------------------------

    {"prompt",
     [](SdVidGenConfig& c, const picojson::value& v) {
       c.prompt = requireStr(v, "prompt");
     }},
    {"negative_prompt",
     [](SdVidGenConfig& c, const picojson::value& v) {
       c.negativePrompt = requireStr(v, "negative_prompt");
     }},

    // -- Video dimensions -----------------------------------------------------
    // Wan's spatial compression requires multiples of 16. Enforcing it here
    // (rather than letting the upstream library round) keeps init_image and
    // video dimensions consistent and matches the JS wrapper's validation.

    {"width",
     [](SdVidGenConfig& c, const picojson::value& v) {
       const int w = requireInt(v, "width");
       if (w <= 0 || w % 16 != 0)
         throw StatusError(
             general_error::InvalidArgument,
             "width must be a positive multiple of 16, got: " +
                 std::to_string(w));
       c.width = w;
     }},

    {"height",
     [](SdVidGenConfig& c, const picojson::value& v) {
       const int h = requireInt(v, "height");
       if (h <= 0 || h % 16 != 0)
         throw StatusError(
             general_error::InvalidArgument,
             "height must be a positive multiple of 16, got: " +
                 std::to_string(h));
       c.height = h;
     }},

    // -- Frame count ----------------------------------------------------------
    // Wan latent temporal packing requires n = 4 * k + 1 with k >= 1, so the
    // smallest legal value is 5. 1 is tolerated only if the user wants a
    // single-frame still (some upstream paths accept it); we gate it below 5
    // explicitly to catch accidental single-frame video configs. Common
    // values @ default fps=16: 17 (~1.06s), 33 (~2.06s), 49 (~3.06s),
    // 81 (~5.06s, Wan 1.3B native training length).

    {"video_frames",
     [](SdVidGenConfig& c, const picojson::value& v) {
       const int n = requireInt(v, "video_frames");
       // Mirror the JS-side message in video.js -- both layers list the
       // same valid set up to 81 (Wan 1.3B native cap) so callers see a
       // consistent error regardless of which validator fires first.
       constexpr const char* kFrameRuleHint =
           "video_frames must be an integer >= 5 of the form (4*k + 1). "
           "Valid values: 5, 9, 13, 17, 21, 25, 29, 33, 37, 41, 45, 49, "
           "53, 57, 61, 65, 69, 73, 77, 81 (Wan 1.3B native training "
           "length). Got: ";
       if (n < 5)
         throw StatusError(
             general_error::InvalidArgument,
             std::string(kFrameRuleHint) + std::to_string(n));
       if ((n - 1) % 4 != 0)
         throw StatusError(
             general_error::InvalidArgument,
             std::string(kFrameRuleHint) + std::to_string(n));
       c.videoFrames = n;
     }},

    // -- FPS ------------------------------------------------------------------
    // AVI main header stores microseconds-per-frame, so fps > 0 required.
    // Reject silly-high values (> 120) to catch typos like passing ms.

    {"fps",
     [](SdVidGenConfig& c, const picojson::value& v) {
       const int f = requireInt(v, "fps");
       if (f <= 0 || f > 120)
         throw StatusError(
             general_error::InvalidArgument,
             "fps must be in (0, 120], got: " + std::to_string(f));
       c.fps = f;
     }},

    // -- Reproducibility ------------------------------------------------------

    {"seed",
     [](SdVidGenConfig& c, const picojson::value& v) {
       c.seed = requireInt64(v, "seed");
     }},

    // -- Low-noise expert sample params (single expert for Wan 2.1) ----------

    {"steps",
     [](SdVidGenConfig& c, const picojson::value& v) {
       c.sampleSteps = requirePositiveInt(v, "steps");
     }},

    // Both "sampling_method" and "sampler" are accepted.
    {"sampling_method",
     [](SdVidGenConfig& c, const picojson::value& v) {
       c.sampleMethod = parseSampler(requireStr(v, "sampling_method"));
     }},
    {"sampler",
     [](SdVidGenConfig& c, const picojson::value& v) {
       c.sampleMethod = parseSampler(requireStr(v, "sampler"));
     }},

    {"scheduler",
     [](SdVidGenConfig& c, const picojson::value& v) {
       c.scheduler = parseScheduler(requireStr(v, "scheduler"));
     }},

    {"cfg_scale",
     [](SdVidGenConfig& c, const picojson::value& v) {
       c.cfgScale = static_cast<float>(requireNum(v, "cfg_scale"));
     }},

    // img_cfg_scale -- image-conditioning guidance for img2vid.
    // Mirrors SdGenHandlers' "img_cfg_scale" handler. Sentinel -1 means
    // "use cfgScale (txt_cfg) for img_cfg too", which is what most callers
    // want. Any value >= 0 overrides sample_params.guidance.img_cfg.
    {"img_cfg_scale",
     [](SdVidGenConfig& c, const picojson::value& v) {
       c.imgCfgScale = static_cast<float>(requireNum(v, "img_cfg_scale"));
     }},

    // flow_shift per-job override. 0 = fall through to SdCtxConfig::flowShift
    // (which defaults to infinity / model-embedded). Wan T2V 1.3B sweet spot:
    // 3.0 (see examples/generate-video-wan.js). Higher values (5+) tend to
    // produce visibly "frozen" video.
    {"flow_shift",
     [](SdVidGenConfig& c, const picojson::value& v) {
       c.flowShift = static_cast<float>(requireNum(v, "flow_shift"));
     }},

    // -- High-noise expert sample params (Wan 2.2 only) ----------------------

    {"high_noise_steps",
     [](SdVidGenConfig& c, const picojson::value& v) {
       c.highNoiseSteps = requirePositiveInt(v, "high_noise_steps");
     }},

    {"high_noise_sampler",
     [](SdVidGenConfig& c, const picojson::value& v) {
       c.highNoiseSampleMethod =
           parseSampler(requireStr(v, "high_noise_sampler"));
     }},

    {"high_noise_scheduler",
     [](SdVidGenConfig& c, const picojson::value& v) {
       c.highNoiseScheduler =
           parseScheduler(requireStr(v, "high_noise_scheduler"));
     }},

    {"high_noise_cfg_scale",
     [](SdVidGenConfig& c, const picojson::value& v) {
       c.highNoiseCfgScale =
           static_cast<float>(requireNum(v, "high_noise_cfg_scale"));
     }},

    {"high_noise_flow_shift",
     [](SdVidGenConfig& c, const picojson::value& v) {
       c.highNoiseFlowShift =
           static_cast<float>(requireNum(v, "high_noise_flow_shift"));
     }},

    // moe_boundary in normalized timestep [0, 1].
    {"moe_boundary",
     [](SdVidGenConfig& c, const picojson::value& v) {
       c.moeBoundary = requireRange(v, "moe_boundary", 0.0f, 1.0f);
     }},

    // -- img2vid -------------------------------------------------------------

    {"strength",
     [](SdVidGenConfig& c, const picojson::value& v) {
       c.strength = requireRange(v, "strength", 0.0f, 1.0f);
     }},

    // -- VACE (controlled video) ---------------------------------------------

    {"vace_strength",
     [](SdVidGenConfig& c, const picojson::value& v) {
       c.vaceStrength = requireRange(v, "vace_strength", 0.0f, 1.0f);
     }},

    // -- VAE tiling ----------------------------------------------------------

    {"vae_tiling",
     [](SdVidGenConfig& c, const picojson::value& v) {
       c.vaeTiling = requireBool(v, "vae_tiling");
     }},

    {"vae_tile_size",
     [](SdVidGenConfig& c, const picojson::value& v) {
       auto [w, h] = parseVaeTileSize(v);
       c.vaeTileSizeX = w;
       c.vaeTileSizeY = h;
     }},

    {"vae_tile_overlap",
     [](SdVidGenConfig& c, const picojson::value& v) {
       const float overlap =
           static_cast<float>(requireNum(v, "vae_tile_overlap"));
       if (overlap < 0.0f || overlap >= 1.0f)
         throw StatusError(
             general_error::InvalidArgument,
             "vae_tile_overlap must be in [0, 1), got: " +
                 std::to_string(overlap));
       c.vaeTileOverlap = overlap;
     }},

    // -- Step-caching --------------------------------------------------------

    {"cache_mode",
     [](SdVidGenConfig& c, const picojson::value& v) {
       c.cacheMode = parseCacheMode(requireStr(v, "cache_mode"));
     }},

    {"cache_preset",
     [](SdVidGenConfig& c, const picojson::value& v) {
       auto [mode, threshold] = parseCachePreset(requireStr(v, "cache_preset"));
       c.cacheMode = mode;
       c.cacheThreshold = threshold;
     }},

    {"cache_threshold",
     [](SdVidGenConfig& c, const picojson::value& v) {
       c.cacheThreshold = static_cast<float>(requireNum(v, "cache_threshold"));
     }},
};

// -----------------------------------------------------------------------------

void applySdVidGenHandlers(
    SdVidGenConfig& config, const picojson::object& obj) {
  for (const auto& [key, value] : obj) {
    if (auto it = SD_VID_GEN_HANDLERS.find(key);
        it != SD_VID_GEN_HANDLERS.end()) {
      it->second(config, value);
    }
    // Unknown keys are silently ignored for forward compatibility.
  }
}

} // namespace qvac_lib_inference_addon_sd
