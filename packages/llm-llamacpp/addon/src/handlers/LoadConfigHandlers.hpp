#pragma once

#include <functional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include <common/common.h>

namespace qvac_lib_inference_addon_llama {

// Transforms one recognized load-time key's raw string value into `params`.
using LoadConfigHandlerFn =
    std::function<void(common_params&, const std::string&)>;
using LoadConfigHandlerList =
    std::vector<std::pair<std::string, LoadConfigHandlerFn>>;

// Ordered: hyphen and underscore spellings map to the same handler and are
// applied in listed order, so when both are supplied the later entry wins
// deterministically.
extern const LoadConfigHandlerList LOAD_CONFIG_HANDLERS;

// Run each recognized key's handler and erase it (so it is not forwarded).
// Unrecognized keys are left for llama.cpp's argument parser.
void applyLoadConfigHandlers(
    common_params& params,
    std::unordered_map<std::string, std::string>& configFilemap);

} // namespace qvac_lib_inference_addon_llama
