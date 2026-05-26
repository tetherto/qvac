#pragma once

#include <cstdint>
#include <string>
#include <utility>

#include <picojson/picojson.h>
#include <stable-diffusion.h>

namespace qvac_lib_inference_addon_sd::parsers {

// -----------------------------------------------------------------------------
// Shared per-job JSON helpers used by both SdGenHandlers (image) and
// SdVidGenHandlers (video).
//
// Each function throws qvac_errors::StatusError with a descriptive message on
// invalid input; callers don't need to construct error strings.
// -----------------------------------------------------------------------------

/** Require a JSON value is a number and return it as double. */
double requireNum(const picojson::value& v, const std::string& key);

/** Require a JSON value is a string and return its contents. */
std::string requireStr(const picojson::value& v, const std::string& key);

/** Require a JSON value is a boolean and return it. */
bool requireBool(const picojson::value& v, const std::string& key);

/**
 * Require a JSON number safely castable to a signed 32-bit int.
 *
 * Rejects:
 *   - NaN / infinity (`!std::isfinite`)
 *   - non-integer doubles (e.g. `8.5`)
 *   - values outside `[INT_MIN, INT_MAX]` (casting such doubles to `int`
 *     is undefined behaviour, not just a wrap)
 *
 * Use this for any handler that lands a JSON number in a C++ `int` slot
 * (width, height, steps, batch_count, clip_skip, ...).
 */
int requireInt(const picojson::value& v, const std::string& key);

/** As `requireInt`, but additionally requires `n > 0`. */
int requirePositiveInt(const picojson::value& v, const std::string& key);

/**
 * Require a JSON number safely castable to int64_t. Used for `seed`, where
 * the JS layer can submit values larger than `INT_MAX`. JSON numbers are IEEE
 * 754 doubles, so the precise representable integer range is
 * `[-(2^53), 2^53]` -- we reject above/below that explicitly.
 */
int64_t requireInt64(const picojson::value& v, const std::string& key);

/**
 * Require a JSON number in `[lo, hi]` and return it as `float`. Used for
 * any bounded-range parameter (strength, overlap, moe_boundary, ...).
 */
float requireRange(
    const picojson::value& v, const std::string& key, float lo, float hi);

/**
 * Parse a sampler name (e.g. "euler", "dpm++2m") into a sample_method_t.
 * Wan 2.1 / 2.2 use "euler" by default.
 */
sample_method_t parseSampler(const std::string& name);

/**
 * Parse a scheduler name (e.g. "karras", "simple") into a scheduler_t.
 * Wan 2.1 / 2.2 use "simple" by default.
 */
scheduler_t parseScheduler(const std::string& name);

/**
 * Parse a cache_mode string into sd_cache_mode_t. Accepts "", "disabled",
 * "easycache", "ucache", "dbcache", "taylorseer", "cache-dit".
 */
sd_cache_mode_t parseCacheMode(const std::string& name);

/**
 * Parse vae_tile_size: either an integer (applied to both axes) or a "WxH"
 * string. Returns (tile_size_x, tile_size_y).
 */
std::pair<int, int> parseVaeTileSize(const picojson::value& v);

/**
 * Parse a cache_preset shorthand ("slow" | "medium" | "fast" | "ultra") into
 * a pair of (mode, threshold). Throws on unknown preset.
 */
std::pair<sd_cache_mode_t, float> parseCachePreset(const std::string& preset);

} // namespace qvac_lib_inference_addon_sd::parsers
