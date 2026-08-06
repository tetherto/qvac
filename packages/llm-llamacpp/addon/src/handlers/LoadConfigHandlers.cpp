#include "handlers/LoadConfigHandlers.hpp"

#include <algorithm>
#include <cctype>

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

const LoadConfigHandlerList LOAD_CONFIG_HANDLERS = {
    {"reasoning-budget", handleReasoningBudget},
    {"reasoning_budget", handleReasoningBudget},
    {"image-tile-mode", handleImageTileMode},
    {"image_tile_mode", handleImageTileMode},
    {"image-max-tokens", handleImageMaxTokens},
    {"image_max_tokens", handleImageMaxTokens},
    {"image-min-tokens", handleImageMinTokens},
    {"image_min_tokens", handleImageMinTokens},
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
