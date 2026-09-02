#include "WorldSessionHandlers.hpp"

#include <cstddef>
#include <cstdint>

#include <inference-addon-cpp/Errors.hpp>

namespace qvac_lib_inference_addon_sd {

using namespace qvac_errors;

// -- Parse helpers ------------------------------------------------------------
// Deliberately file-local copies of the SdCtxHandlers.cpp helpers (which are
// static there): duplicating three small functions keeps this change from
// touching the batch pipeline. A follow-up can hoist them into a shared
// handlers/ParseHelpers.hpp.

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
  std::size_t parsedChars = 0;
  int parsed = 0;
  try {
    parsed = std::stoi(v, &parsedChars);
  } catch (...) {
    throw StatusError(
        general_error::InvalidArgument,
        key + " must be an integer, got: '" + v + "'");
  }
  if (parsedChars != v.size()) {
    throw StatusError(
        general_error::InvalidArgument,
        key + " must be an integer, got: '" + v + "'");
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

static int parseIntInRange(
    const std::string& v, const std::string& key, int min, int max) {
  const int parsed = parseInt(v, key);
  if (parsed < min || parsed > max) {
    throw StatusError(
        general_error::InvalidArgument,
        key + " must be in [" + std::to_string(min) + ", " +
            std::to_string(max) + "], got: '" + v + "'");
  }
  return parsed;
}

static int64_t parseInt64(const std::string& v, const std::string& key) {
  std::size_t parsedChars = 0;
  int64_t parsed = 0;
  try {
    parsed = std::stoll(v, &parsedChars);
  } catch (...) {
    throw StatusError(
        general_error::InvalidArgument,
        key + " must be an integer, got: '" + v + "'");
  }
  if (parsedChars != v.size()) {
    throw StatusError(
        general_error::InvalidArgument,
        key + " must be an integer, got: '" + v + "'");
  }
  return parsed;
}

// -- Handler map
// ---------------------------------------------------------------

const WorldSessionHandlersMap WORLD_SESSION_HANDLERS = {

    {"backendsDir",
     [](WorldSessionConfig& c, const std::string& v) { c.backendsDir = v; }},
    {"backend",
     [](WorldSessionConfig& c, const std::string& v) { c.backend = v; }},

    {"threads",
     [](WorldSessionConfig& c, const std::string& v) {
       c.nThreads = parseAutoOrPositiveInt(v, "threads");
     }},
    {"seed",
     [](WorldSessionConfig& c, const std::string& v) {
       c.seed = parseInt64(v, "seed");
     }},

    // 0 = model/engine default for both block-shape knobs.
    {"numFramePerBlock",
     [](WorldSessionConfig& c, const std::string& v) {
       c.numFramePerBlock = parseIntInRange(v, "numFramePerBlock", 0, 1 << 10);
     }},
    {"localAttnSize",
     [](WorldSessionConfig& c, const std::string& v) {
       c.localAttnSize = parseIntInRange(v, "localAttnSize", 0, 1 << 10);
     }},

    {"offloadParamsToCpu",
     [](WorldSessionConfig& c, const std::string& v) {
       c.offloadParamsToCpu = parseBool(v, "offloadParamsToCpu");
     }},
    // 0 = lossless PNG frames; 1..100 = JPEG quality.
    {"frameJpegQuality",
     [](WorldSessionConfig& c, const std::string& v) {
       c.frameJpegQuality = parseIntInRange(v, "frameJpegQuality", 0, 100);
     }},
    {"kvCache",
     [](WorldSessionConfig& c, const std::string& v) {
       c.kvCache = parseBool(v, "kvCache");
     }},
    {"profile",
     [](WorldSessionConfig& c, const std::string& v) {
       c.profile = parseBool(v, "profile");
     }},
};

void applyWorldSessionHandlers(
    WorldSessionConfig& config,
    const std::unordered_map<std::string, std::string>& configMap) {
  for (const auto& [key, value] : configMap) {
    if (auto it = WORLD_SESSION_HANDLERS.find(key);
        it != WORLD_SESSION_HANDLERS.end()) {
      it->second(config, value);
    }
    // Unknown keys are silently ignored for forward compatibility.
  }
}

} // namespace qvac_lib_inference_addon_sd
