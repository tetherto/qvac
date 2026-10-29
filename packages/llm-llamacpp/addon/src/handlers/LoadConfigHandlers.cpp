#include "handlers/LoadConfigHandlers.hpp"

#include <algorithm>
#include <cctype>

#include <common/arg.h>
#include <inference-addon-cpp/Errors.hpp>

#include "addon/LlmErrors.hpp"
#include "handlers/LlmParsers.hpp"

namespace qvac_lib_inference_addon_llama {

static void
handleReasoningBudget(common_params& params, const std::string& value) {
  params.reasoning_budget = parsers::parseReasoningBudgetConfig(value);
}

static void handleImageTileMode(common_params& params, const std::string& raw) {
  std::string val = raw;
  std::transform(val.begin(), val.end(), val.begin(), ::tolower);
  if (val == "0" || val == "batched") {
    params.image_tile_mode = COMMON_IMAGE_TILE_MODE_BATCHED;
  } else if (val == "1" || val == "sequential") {
    params.image_tile_mode = COMMON_IMAGE_TILE_MODE_SEQUENTIAL;
  } else if (val == "2" || val == "disabled") {
    params.image_tile_mode = COMMON_IMAGE_TILE_MODE_DISABLED;
  } else {
    throw qvac_errors::StatusError(
        errors::ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        string_format(
            "image-tile-mode must be 0/batched, 1/sequential, or "
            "2/disabled, got: %s",
            raw.c_str()));
  }
}

// Selects the idefics3-style no-upscale preprocessing rule. Tri-state on the
// fabric side, but the config map can only say "the caller set something", so
// this handler only ever writes 0 or 1; leaving the key out keeps fabric's -1
// model default. Needed because the VisionPsy base and Flash mmprojs declare
// identical vision hparams, so without it a Flash model silently runs base
// preprocessing.
static void
handleImageNoUpscale(common_params& params, const std::string& raw) {
  std::string val = raw;
  std::transform(val.begin(), val.end(), val.begin(), ::tolower);
  if (val == "1" || val == "on" || val == "true") {
    params.image_no_upscale = 1;
  } else if (val == "0" || val == "off" || val == "false") {
    params.image_no_upscale = 0;
  } else {
    throw qvac_errors::StatusError(
        errors::ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        string_format(
            "image-no-upscale must be 0/off/false or 1/on/true, got: %s",
            raw.c_str()));
  }
}

// Drops the projector's audio encoder while keeping its vision encoder. The
// addon already defaults this to true (see normalizeLoadForFit), so the
// useful case here is an explicit "off", which loads the audio tower back.
static void handleMmprojNoAudio(common_params& params, const std::string& raw) {
  std::string val = raw;
  std::transform(val.begin(), val.end(), val.begin(), ::tolower);
  if (val == "1" || val == "on" || val == "true") {
    params.mmproj_no_audio = true;
  } else if (val == "0" || val == "off" || val == "false") {
    params.mmproj_no_audio = false;
  } else {
    throw qvac_errors::StatusError(
        errors::ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        string_format(
            "mmproj-no-audio must be 0/off/false or 1/on/true, got: %s",
            raw.c_str()));
  }
}

static void
handleImageMaxTokens(common_params& params, const std::string& raw) {
  try {
    params.image_max_tokens = std::stoi(raw);
  } catch (...) {
    throw qvac_errors::StatusError(
        errors::ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        string_format(
            "image-max-tokens must be an integer, got: %s", raw.c_str()));
  }
}

static void
handleImageMinTokens(common_params& params, const std::string& raw) {
  try {
    params.image_min_tokens = std::stoi(raw);
  } catch (...) {
    throw qvac_errors::StatusError(
        errors::ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        string_format(
            "image-min-tokens must be an integer, got: %s", raw.c_str()));
  }
}

// `--kv-unified` is registered for llama.cpp's server/perplexity examples, not
// LLAMA_EXAMPLE_COMMON, so the generic parser would reject it here. Consume the
// key directly and write the same `common_params` field the flag would.
static void handleKvUnified(common_params& params, const std::string& raw) {
  if (common_arg_utils::is_truthy(raw)) {
    params.kv_unified = true;
  } else if (common_arg_utils::is_falsey(raw)) {
    params.kv_unified = false;
  } else {
    throw qvac_errors::StatusError(
        errors::ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        string_format(
            "kv-unified must be on/off/true/false/1/0, got: %s", raw.c_str()));
  }
}

static void handleNoKvUnified(common_params& params, const std::string& raw) {
  (void)raw;
  params.kv_unified = false;
}

static void
handleKvUnifiedPerSlot(common_params& params, const std::string& raw) {
  int value = 0;
  try {
    value = std::stoi(raw);
  } catch (...) {
    throw qvac_errors::StatusError(
        errors::ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        string_format(
            "kv-unified-per-slot must be an integer, got: %s", raw.c_str()));
  }
  if (value < 0) {
    throw qvac_errors::StatusError(
        errors::ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        string_format(
            "kv-unified-per-slot must be >= 0, got: %s", raw.c_str()));
  }
  params.kv_unified_per_slot = value;
}

const LoadConfigHandlerList LOAD_CONFIG_HANDLERS = {
    {"reasoning-budget", handleReasoningBudget},
    {"reasoning_budget", handleReasoningBudget},
    {"image-tile-mode", handleImageTileMode},
    {"image_tile_mode", handleImageTileMode},
    {"image-max-tokens", handleImageMaxTokens},
    {"image_max_tokens", handleImageMaxTokens},
    {"image-min-tokens", handleImageMinTokens},
    {"image_min_tokens", handleImageMinTokens},
    {"image-no-upscale", handleImageNoUpscale},
    {"image_no_upscale", handleImageNoUpscale},
    {"mmproj-no-audio", handleMmprojNoAudio},
    {"mmproj_no_audio", handleMmprojNoAudio},
    {"kv-unified", handleKvUnified},
    {"kv_unified", handleKvUnified},
    {"no-kv-unified", handleNoKvUnified},
    {"no_kv_unified", handleNoKvUnified},
    {"kv-unified-per-slot", handleKvUnifiedPerSlot},
    {"kv_unified_per_slot", handleKvUnifiedPerSlot},
};

void applyLoadConfigHandlers(
    common_params& params,
    std::unordered_map<std::string, std::string>& configFilemap) {
  for (const auto& [key, handler] : LOAD_CONFIG_HANDLERS) {
    if (auto it = configFilemap.find(key); it != configFilemap.end()) {
      handler(params, it->second);
      configFilemap.erase(it);
    }
  }
}

} // namespace qvac_lib_inference_addon_llama
