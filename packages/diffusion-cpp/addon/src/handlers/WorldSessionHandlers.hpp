#pragma once

#include <functional>
#include <string>
#include <unordered_map>

#include "model-interface/WorldSessionModel.hpp"

namespace qvac_lib_inference_addon_sd {

/**
 * Handler function for a single ABot-World config key.
 * Receives the config struct (by ref) and the raw string value from JS
 * (addon.ts stringifies every config value before it crosses the boundary).
 * Throws qvac_errors::StatusError on invalid input — the same validated
 * contract SD_CTX_HANDLERS gives every other model in this package, so
 * e.g. `kvCache: 1` parses as true instead of silently keeping the default.
 */
using WorldSessionHandlerFn =
    std::function<void(WorldSessionConfig&, const std::string&)>;
using WorldSessionHandlersMap =
    std::unordered_map<std::string, WorldSessionHandlerFn>;

/** All supported walk-session config keys and their handlers. */
extern const WorldSessionHandlersMap WORLD_SESSION_HANDLERS;

/**
 * Apply WORLD_SESSION_HANDLERS to configMap, writing results into config.
 * Unknown keys are silently ignored (forward compatibility, same as
 * applySdCtxHandlers).
 */
void applyWorldSessionHandlers(
    WorldSessionConfig& config,
    const std::unordered_map<std::string, std::string>& configMap);

} // namespace qvac_lib_inference_addon_sd
