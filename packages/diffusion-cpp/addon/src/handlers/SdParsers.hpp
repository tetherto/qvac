#pragma once

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
double requireNum(const picojson::value &v, const std::string &key);

/** Require a JSON value is a string and return its contents. */
std::string requireStr(const picojson::value &v, const std::string &key);

/** Require a JSON value is a boolean and return it. */
bool requireBool(const picojson::value &v, const std::string &key);

/**
 * Convert a JSON number to a finite C++ `float`. Rejects NaN and infinity
 * (which would otherwise silently coerce -- `static_cast<float>(NaN)` is
 * still NaN, `(inf)` is still inf, and downstream range checks like
 * `f < 0.0f` are FALSE for NaN, so a missing isfinite() check lets NaN
 * sneak past every guard).
 *
 * Use this anywhere a JSON number must land in a `float`.
 */
float requireFiniteFloat(const picojson::value &v, const std::string &key);

/**
 * Convert a JSON number to a C++ `int` with full safety checks:
 *   - rejects NaN and infinity
 *   - rejects non-integer doubles (e.g. 8.5)
 *   - rejects values outside [INT_MIN, INT_MAX] (casting a double outside
 *     this range to int is undefined behaviour)
 */
int requireInt(const picojson::value &v, const std::string &key);

/**
 * Like requireInt() but for `int64_t`. Range is [INT64_MIN, INT64_MAX].
 * Note that double's mantissa is 53 bits, so values above ~2^53 cannot be
 * represented exactly and the range check is the best we can offer here.
 */
int64_t requireInt64(const picojson::value &v, const std::string &key);

/** requireInt() + `> 0` check, with a friendly error pointing at `key`. */
int requirePositiveInt(const picojson::value &v, const std::string &key);

/**
 * Convert a JSON number to a finite float and assert it lies in [lo, hi].
 * The finite guard runs before the range check (NaN compares false against
 * every bound and would otherwise sneak through).
 */
float requireFiniteFloatInRange(const picojson::value &v,
                                const std::string &key, float lo, float hi);

/**
 * Parse a sampler name (e.g. "euler", "dpm++2m") into a sample_method_t.
 * Wan 2.1 / 2.2 use "euler" by default.
 */
sample_method_t parseSampler(const std::string &name);

/**
 * Parse a scheduler name (e.g. "karras", "simple") into a scheduler_t.
 * Wan 2.1 / 2.2 use "simple" by default.
 */
scheduler_t parseScheduler(const std::string &name);

/**
 * Parse a cache_mode string into sd_cache_mode_t. Accepts "", "disabled",
 * "easycache", "ucache", "dbcache", "taylorseer", "cache-dit".
 */
sd_cache_mode_t parseCacheMode(const std::string &name);

/**
 * Parse vae_tile_size: either an integer (applied to both axes) or a "WxH"
 * string. Returns (tile_size_x, tile_size_y).
 */
std::pair<int, int> parseVaeTileSize(const picojson::value &v);

/**
 * Parse a cache_preset shorthand ("slow" | "medium" | "fast" | "ultra") into
 * a pair of (mode, threshold). Throws on unknown preset.
 */
std::pair<sd_cache_mode_t, float> parseCachePreset(const std::string &preset);

} // namespace qvac_lib_inference_addon_sd::parsers
