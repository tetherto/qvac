/**
 * Unit tests for SdVidGenHandlers (video generation per-job parameter
 * parsing for Wan 2.1 / Wan 2.2).
 *
 * Coverage:
 *   1.  Mode validation (txt2vid / img2vid / unknown)
 *   2.  Prompt handlers (prompt / negative_prompt)
 *   3.  Dimensions (width / height -- multiples of 16)
 *   4.  video_frames (4k+1 rule, minimum 5)
 *   5.  fps (1-120)
 *   6.  Seed
 *   7.  Low-noise expert sample params (steps, sampler, scheduler, cfg_scale,
 *                                       flow_shift)
 *   8.  High-noise expert sample params (high_noise_* family)
 *   9.  moe_boundary (Wan 2.2, [0, 1])
 *  10.  strength (img2vid, [0, 1])
 *  11.  vace_strength (VACE, [0, 1])
 *  12.  VAE tiling (vae_tiling, vae_tile_size as int and "WxH",
 * vae_tile_overlap)
 *  13.  cache_mode / cache_preset / cache_threshold
 *  14.  Defaults match Wan 2.1 T2V 1.3B recommendations
 *  15.  Unknown keys silently ignored
 */

#include <cmath>
#include <cstdlib>
#include <limits>
#include <stdexcept>

#include <gtest/gtest.h>
#include <picojson/picojson.h>
#include <stable-diffusion.h>

#include "handlers/SdVidGenHandlers.hpp"

using namespace qvac_lib_inference_addon_sd;
using namespace qvac_errors;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

namespace {

picojson::object makeObj(const std::string& key, const picojson::value& val) {
  picojson::object obj;
  obj[key] = val;
  return obj;
}

picojson::value str(const std::string& s) { return picojson::value(s); }
picojson::value num(double n) { return picojson::value(n); }
picojson::value boolean(bool b) { return picojson::value(b); }

SdVidGenConfig applyOne(const std::string& key, const picojson::value& val) {
  SdVidGenConfig cfg;
  applySdVidGenHandlers(cfg, makeObj(key, val));
  return cfg;
}

void expectThrows(const std::string& key, const picojson::value& val) {
  SdVidGenConfig cfg;
  EXPECT_THROW(applySdVidGenHandlers(cfg, makeObj(key, val)), StatusError);
}

} // namespace

// -----------------------------------------------------------------------------
// 1. Mode
// -----------------------------------------------------------------------------

TEST(SdVidGenHandlers_Mode, AcceptsTxt2VidAndImg2Vid) {
  EXPECT_EQ(applyOne("mode", str("txt2vid")).mode, "txt2vid");
  EXPECT_EQ(applyOne("mode", str("img2vid")).mode, "img2vid");
}

TEST(SdVidGenHandlers_Mode, RejectsUnknownModeAndImageModes) {
  expectThrows("mode", str("txt2img"));
  expectThrows("mode", str("img2img"));
  expectThrows("mode", str("bogus"));
  expectThrows("mode", str(""));
}

TEST(SdVidGenHandlers_Mode, RejectsNonString) {
  expectThrows("mode", num(0));
  expectThrows("mode", boolean(true));
}

// -----------------------------------------------------------------------------
// 2. Prompt
// -----------------------------------------------------------------------------

TEST(SdVidGenHandlers_Prompt, PromptAndNegativePrompt) {
  EXPECT_EQ(applyOne("prompt", str("a cat")).prompt, "a cat");
  EXPECT_EQ(
      applyOne("negative_prompt", str("bad quality")).negativePrompt,
      "bad quality");
}

TEST(SdVidGenHandlers_Prompt, EmptyPromptAccepted) {
  EXPECT_EQ(applyOne("prompt", str("")).prompt, "");
}

TEST(SdVidGenHandlers_Prompt, NonStringPromptThrows) {
  expectThrows("prompt", num(42));
  expectThrows("negative_prompt", boolean(false));
}

// -----------------------------------------------------------------------------
// 3. Dimensions
// -----------------------------------------------------------------------------

TEST(SdVidGenHandlers_Dimensions, MultiplesOfSixteenAccepted) {
  EXPECT_EQ(applyOne("width", num(832)).width, 832);
  EXPECT_EQ(applyOne("height", num(480)).height, 480);
  EXPECT_EQ(applyOne("width", num(16)).width, 16);
}

TEST(SdVidGenHandlers_Dimensions, NonMultipleOfSixteenRejected) {
  expectThrows("width", num(831));
  expectThrows("height", num(479));
  expectThrows("width", num(1));  // not a multiple of 16
  expectThrows("width", num(8));  // multiple of 8 but not 16
  expectThrows("height", num(24)); // multiple of 8 but not 16
}

TEST(SdVidGenHandlers_Dimensions, ZeroOrNegativeRejected) {
  expectThrows("width", num(0));
  expectThrows("height", num(-8));
}

TEST(SdVidGenHandlers_Dimensions, NonNumberRejected) {
  expectThrows("width", str("832"));
}

// -----------------------------------------------------------------------------
// 3b. Integer-coercion safety (requireInt helper, shared by width, height,
//     video_frames, fps, steps, high_noise_steps). Doubles that aren't
//     exact integers, NaN, infinity, and out-of-range values must all be
//     rejected *before* the static_cast<int> -- otherwise a 8.5 would
//     silently truncate to 8 and an infinity cast is undefined behaviour.
// -----------------------------------------------------------------------------

TEST(SdVidGenHandlers_IntCoercion, RejectsFractionalDoubles) {
  expectThrows("width", num(832.5));
  expectThrows("height", num(480.001));
  expectThrows("video_frames", num(5.5));
  expectThrows("fps", num(16.25));
  expectThrows("steps", num(30.7));
}

TEST(SdVidGenHandlers_IntCoercion, NaNAndInfinityBlockedAtJsonLayer) {
  // picojson::value's double constructor refuses NaN / +inf / -inf at the
  // JSON parser layer (it throws std::overflow_error), so non-finite values
  // can never reach a handler via real JSON input. The std::isfinite() guard
  // in requireInt() is a belt-and-braces check for direct C++ callers that
  // bypass picojson. Document that contract here.
  const double nan = std::nan("");
  const double inf = std::numeric_limits<double>::infinity();
  EXPECT_THROW(picojson::value{nan}, std::overflow_error);
  EXPECT_THROW(picojson::value{inf}, std::overflow_error);
  EXPECT_THROW(picojson::value{-inf}, std::overflow_error);
}

TEST(SdVidGenHandlers_IntCoercion, RejectsValuesOutsideIntRange) {
  // 2^40 -- well beyond INT_MAX (~2.1e9) but representable as a double.
  expectThrows("width", num(1099511627776.0));
  expectThrows("fps", num(-1099511627776.0));
}

TEST(SdVidGenHandlers_IntCoercion, AcceptsIntegerDoubles) {
  // JSON numbers are doubles -- "832" still arrives as 832.0 and must work.
  EXPECT_EQ(applyOne("width", num(832.0)).width, 832);
  EXPECT_EQ(applyOne("video_frames", num(33.0)).videoFrames, 33);
  EXPECT_EQ(applyOne("fps", num(16.0)).fps, 16);
}

// -----------------------------------------------------------------------------
// 4. video_frames (Wan requires n = 4*k + 1, n >= 5)
// -----------------------------------------------------------------------------

TEST(SdVidGenHandlers_VideoFrames, AcceptsValidTemporallyPackedCounts) {
  EXPECT_EQ(applyOne("video_frames", num(5)).videoFrames, 5);
  EXPECT_EQ(applyOne("video_frames", num(9)).videoFrames, 9);
  EXPECT_EQ(applyOne("video_frames", num(13)).videoFrames, 13);
  EXPECT_EQ(applyOne("video_frames", num(33)).videoFrames, 33);
  EXPECT_EQ(applyOne("video_frames", num(81)).videoFrames, 81);
}

TEST(SdVidGenHandlers_VideoFrames, RejectsNonFourKPlusOne) {
  expectThrows("video_frames", num(6));  // 4k + 2
  expectThrows("video_frames", num(7));  // 4k + 3
  expectThrows("video_frames", num(8));  // 4k
  expectThrows("video_frames", num(32)); // 4k
  expectThrows("video_frames", num(34)); // 4k + 2
}

TEST(SdVidGenHandlers_VideoFrames, RejectsBelowMinimum) {
  expectThrows("video_frames", num(1));
  expectThrows("video_frames", num(0));
  expectThrows("video_frames", num(-1));
}

// -----------------------------------------------------------------------------
// 5. fps
// -----------------------------------------------------------------------------

TEST(SdVidGenHandlers_Fps, AcceptsCommonRates) {
  EXPECT_EQ(applyOne("fps", num(16)).fps, 16);
  EXPECT_EQ(applyOne("fps", num(24)).fps, 24);
  EXPECT_EQ(applyOne("fps", num(30)).fps, 30);
  EXPECT_EQ(applyOne("fps", num(60)).fps, 60);
}

TEST(SdVidGenHandlers_Fps, AcceptsBoundaries) {
  EXPECT_EQ(applyOne("fps", num(1)).fps, 1);
  EXPECT_EQ(applyOne("fps", num(120)).fps, 120);
}

TEST(SdVidGenHandlers_Fps, RejectsOutOfRange) {
  expectThrows("fps", num(0));
  expectThrows("fps", num(-1));
  expectThrows("fps", num(121));
  expectThrows("fps", num(1000));
}

// -----------------------------------------------------------------------------
// 6. Seed
// -----------------------------------------------------------------------------

TEST(SdVidGenHandlers_Seed, MinusOneIsRandom) {
  EXPECT_EQ(applyOne("seed", num(-1)).seed, -1);
}

TEST(SdVidGenHandlers_Seed, LargeValuesAccepted) {
  EXPECT_EQ(applyOne("seed", num(12345)).seed, 12345);
  EXPECT_EQ(applyOne("seed", num(1000000)).seed, 1000000);
}

// -----------------------------------------------------------------------------
// 7. Low-noise expert sample params
// -----------------------------------------------------------------------------

TEST(SdVidGenHandlers_Steps, PositiveAccepted) {
  EXPECT_EQ(applyOne("steps", num(20)).sampleSteps, 20);
  EXPECT_EQ(applyOne("steps", num(50)).sampleSteps, 50);
}

TEST(SdVidGenHandlers_Steps, ZeroAndNegativeRejected) {
  expectThrows("steps", num(0));
  expectThrows("steps", num(-5));
}

TEST(SdVidGenHandlers_Sampler, SupportedNamesMap) {
  EXPECT_EQ(
      applyOne("sampler", str("euler")).sampleMethod, EULER_SAMPLE_METHOD);
  EXPECT_EQ(
      applyOne("sampling_method", str("euler_a")).sampleMethod,
      EULER_A_SAMPLE_METHOD);
  EXPECT_EQ(applyOne("sampler", str("heun")).sampleMethod, HEUN_SAMPLE_METHOD);
}

TEST(SdVidGenHandlers_Sampler, UnknownRejected) {
  expectThrows("sampler", str("nonexistent"));
}

TEST(SdVidGenHandlers_Scheduler, SupportedNamesMap) {
  EXPECT_EQ(applyOne("scheduler", str("simple")).scheduler, SIMPLE_SCHEDULER);
  EXPECT_EQ(applyOne("scheduler", str("karras")).scheduler, KARRAS_SCHEDULER);
}

TEST(SdVidGenHandlers_Scheduler, UnknownRejected) {
  expectThrows("scheduler", str("nonexistent"));
}

TEST(SdVidGenHandlers_CfgScale, SetsValue) {
  EXPECT_FLOAT_EQ(applyOne("cfg_scale", num(6.0)).cfgScale, 6.0f);
  EXPECT_FLOAT_EQ(applyOne("cfg_scale", num(7.5)).cfgScale, 7.5f);
}

TEST(SdVidGenHandlers_FlowShift, AcceptsFloats) {
  EXPECT_FLOAT_EQ(applyOne("flow_shift", num(5.0)).flowShift, 5.0f);
  EXPECT_FLOAT_EQ(applyOne("flow_shift", num(8.0)).flowShift, 8.0f);
  // 0 is the sentinel meaning "fall through to SdCtxConfig::flowShift"
  EXPECT_FLOAT_EQ(applyOne("flow_shift", num(0.0)).flowShift, 0.0f);
}

// -----------------------------------------------------------------------------
// 8. High-noise expert sample params (Wan 2.2)
// -----------------------------------------------------------------------------

TEST(SdVidGenHandlers_HighNoiseSteps, PositiveAccepted) {
  EXPECT_EQ(applyOne("high_noise_steps", num(25)).highNoiseSteps, 25);
}

TEST(SdVidGenHandlers_HighNoiseSteps, ZeroOrNegativeRejected) {
  expectThrows("high_noise_steps", num(0));
  expectThrows("high_noise_steps", num(-1));
}

TEST(SdVidGenHandlers_HighNoiseSampler, SupportedNamesMap) {
  EXPECT_EQ(
      applyOne("high_noise_sampler", str("euler")).highNoiseSampleMethod,
      EULER_SAMPLE_METHOD);
  EXPECT_EQ(
      applyOne("high_noise_sampler", str("dpm++2m")).highNoiseSampleMethod,
      DPMPP2M_SAMPLE_METHOD);
}

TEST(SdVidGenHandlers_HighNoiseSampler, UnknownRejected) {
  expectThrows("high_noise_sampler", str("nope"));
}

TEST(SdVidGenHandlers_HighNoiseScheduler, SupportedNamesMap) {
  EXPECT_EQ(
      applyOne("high_noise_scheduler", str("simple")).highNoiseScheduler,
      SIMPLE_SCHEDULER);
  EXPECT_EQ(
      applyOne("high_noise_scheduler", str("karras")).highNoiseScheduler,
      KARRAS_SCHEDULER);
}

TEST(SdVidGenHandlers_HighNoiseCfgScale, SetsValue) {
  EXPECT_FLOAT_EQ(
      applyOne("high_noise_cfg_scale", num(6.5)).highNoiseCfgScale, 6.5f);
}

TEST(SdVidGenHandlers_HighNoiseFlowShift, SetsValue) {
  EXPECT_FLOAT_EQ(
      applyOne("high_noise_flow_shift", num(4.0)).highNoiseFlowShift, 4.0f);
}

// -----------------------------------------------------------------------------
// 9. moe_boundary
// -----------------------------------------------------------------------------

TEST(SdVidGenHandlers_MoeBoundary, AcceptsInRange) {
  EXPECT_FLOAT_EQ(applyOne("moe_boundary", num(0.0)).moeBoundary, 0.0f);
  EXPECT_FLOAT_EQ(applyOne("moe_boundary", num(0.5)).moeBoundary, 0.5f);
  EXPECT_FLOAT_EQ(applyOne("moe_boundary", num(0.875)).moeBoundary, 0.875f);
  EXPECT_FLOAT_EQ(applyOne("moe_boundary", num(1.0)).moeBoundary, 1.0f);
}

TEST(SdVidGenHandlers_MoeBoundary, OutOfRangeRejected) {
  expectThrows("moe_boundary", num(-0.01));
  expectThrows("moe_boundary", num(1.01));
  expectThrows("moe_boundary", num(-1.0));
  expectThrows("moe_boundary", num(2.0));
}

// -----------------------------------------------------------------------------
// 10. Strength
// -----------------------------------------------------------------------------

TEST(SdVidGenHandlers_Strength, AcceptsInRange) {
  EXPECT_FLOAT_EQ(applyOne("strength", num(0.0)).strength, 0.0f);
  EXPECT_FLOAT_EQ(applyOne("strength", num(0.75)).strength, 0.75f);
  EXPECT_FLOAT_EQ(applyOne("strength", num(1.0)).strength, 1.0f);
}

TEST(SdVidGenHandlers_Strength, OutOfRangeRejected) {
  expectThrows("strength", num(-0.1));
  expectThrows("strength", num(1.1));
}

// -----------------------------------------------------------------------------
// 11. VACE strength
// -----------------------------------------------------------------------------

TEST(SdVidGenHandlers_VaceStrength, AcceptsInRange) {
  EXPECT_FLOAT_EQ(applyOne("vace_strength", num(0.0)).vaceStrength, 0.0f);
  EXPECT_FLOAT_EQ(applyOne("vace_strength", num(0.5)).vaceStrength, 0.5f);
  EXPECT_FLOAT_EQ(applyOne("vace_strength", num(1.0)).vaceStrength, 1.0f);
}

TEST(SdVidGenHandlers_VaceStrength, OutOfRangeRejected) {
  expectThrows("vace_strength", num(-0.5));
  expectThrows("vace_strength", num(1.5));
}

// -----------------------------------------------------------------------------
// 12. VAE tiling
// -----------------------------------------------------------------------------

TEST(SdVidGenHandlers_VaeTiling, BooleanToggles) {
  EXPECT_TRUE(applyOne("vae_tiling", boolean(true)).vaeTiling);
  EXPECT_FALSE(applyOne("vae_tiling", boolean(false)).vaeTiling);
}

TEST(SdVidGenHandlers_VaeTiling, NonBooleanRejected) {
  expectThrows("vae_tiling", str("true"));
  expectThrows("vae_tiling", num(1));
}

TEST(SdVidGenHandlers_VaeTileSize, IntegerAppliesToBothAxes) {
  auto cfg = applyOne("vae_tile_size", num(256));
  EXPECT_EQ(cfg.vaeTileSizeX, 256);
  EXPECT_EQ(cfg.vaeTileSizeY, 256);
}

TEST(SdVidGenHandlers_VaeTileSize, WxHStringAcceptedAndSplit) {
  auto cfg = applyOne("vae_tile_size", str("256x128"));
  EXPECT_EQ(cfg.vaeTileSizeX, 256);
  EXPECT_EQ(cfg.vaeTileSizeY, 128);
}

TEST(SdVidGenHandlers_VaeTileSize, InvalidFormatsRejected) {
  expectThrows("vae_tile_size", str("no-x-here"));
  expectThrows("vae_tile_size", str("256xbad"));
  expectThrows("vae_tile_size", boolean(true));
}

// vae_tile_size hardening (C4 follow-up): zero / negative / fractional /
// out-of-int-range values must all throw at the parser layer instead of
// silently coercing to nonsensical tile dims (or hitting UB on the cast).
TEST(SdVidGenHandlers_VaeTileSize, NumericFormRejectsZeroAndNegative) {
  expectThrows("vae_tile_size", num(0));
  expectThrows("vae_tile_size", num(-128));
}

TEST(SdVidGenHandlers_VaeTileSize, NumericFormRejectsFractional) {
  expectThrows("vae_tile_size", num(256.5));
}

TEST(SdVidGenHandlers_VaeTileSize, NumericFormRejectsOutOfIntRange) {
  // 2^40 -- representable as a double, but well past INT_MAX.
  expectThrows("vae_tile_size", num(1099511627776.0));
}

TEST(SdVidGenHandlers_VaeTileSize, StringFormRejectsZeroAndNegativeDims) {
  expectThrows("vae_tile_size", str("0x128"));
  expectThrows("vae_tile_size", str("256x0"));
  expectThrows("vae_tile_size", str("-1x128"));
}

TEST(SdVidGenHandlers_VaeTileOverlap, AcceptsRangeZeroToAlmostOne) {
  EXPECT_FLOAT_EQ(applyOne("vae_tile_overlap", num(0.0)).vaeTileOverlap, 0.0f);
  EXPECT_FLOAT_EQ(applyOne("vae_tile_overlap", num(0.5)).vaeTileOverlap, 0.5f);
  EXPECT_FLOAT_EQ(
      applyOne("vae_tile_overlap", num(0.99)).vaeTileOverlap, 0.99f);
}

TEST(SdVidGenHandlers_VaeTileOverlap, OneOrAboveRejected) {
  expectThrows("vae_tile_overlap", num(1.0));
  expectThrows("vae_tile_overlap", num(1.5));
  expectThrows("vae_tile_overlap", num(-0.1));
}

// -----------------------------------------------------------------------------
// 13. Cache mode / preset / threshold
// -----------------------------------------------------------------------------

TEST(SdVidGenHandlers_CacheMode, SupportedValuesMap) {
  EXPECT_EQ(applyOne("cache_mode", str("")).cacheMode, SD_CACHE_DISABLED);
  EXPECT_EQ(
      applyOne("cache_mode", str("disabled")).cacheMode, SD_CACHE_DISABLED);
  EXPECT_EQ(
      applyOne("cache_mode", str("easycache")).cacheMode, SD_CACHE_EASYCACHE);
  EXPECT_EQ(
      applyOne("cache_mode", str("cache-dit")).cacheMode, SD_CACHE_CACHE_DIT);
}

TEST(SdVidGenHandlers_CacheMode, UnknownRejected) {
  expectThrows("cache_mode", str("nope"));
}

TEST(SdVidGenHandlers_CachePreset, SetsModeAndThreshold) {
  auto slow = applyOne("cache_preset", str("slow"));
  EXPECT_EQ(slow.cacheMode, SD_CACHE_EASYCACHE);
  EXPECT_FLOAT_EQ(slow.cacheThreshold, 0.60f);

  auto ultra = applyOne("cache_preset", str("ultra"));
  EXPECT_EQ(ultra.cacheMode, SD_CACHE_EASYCACHE);
  EXPECT_FLOAT_EQ(ultra.cacheThreshold, 0.15f);
}

TEST(SdVidGenHandlers_CachePreset, UnknownRejected) {
  expectThrows("cache_preset", str("lightning"));
}

TEST(SdVidGenHandlers_CacheThreshold, DirectOverrideAccepted) {
  EXPECT_FLOAT_EQ(applyOne("cache_threshold", num(0.42)).cacheThreshold, 0.42f);
}

// -----------------------------------------------------------------------------
// 14. Defaults match Wan 2.1 T2V 1.3B recommendations
// -----------------------------------------------------------------------------

TEST(SdVidGenHandlers_Defaults, MatchWan21T2vRecommendedConfig) {
  SdVidGenConfig cfg;
  EXPECT_EQ(cfg.mode, "txt2vid");
  // Portrait default (phone-screen friendly); Wan 2.1 T2V 1.3B handles
  // both orientations and the upstream training res is 832x480 landscape.
  EXPECT_EQ(cfg.width, 480);
  EXPECT_EQ(cfg.height, 832);
  EXPECT_EQ(cfg.videoFrames, 33);
  EXPECT_EQ(cfg.fps, 16);
  EXPECT_EQ(cfg.seed, -1);
  EXPECT_EQ(cfg.sampleSteps, 30);
  EXPECT_EQ(cfg.sampleMethod, EULER_SAMPLE_METHOD);
  EXPECT_EQ(cfg.scheduler, SIMPLE_SCHEDULER);
  EXPECT_FLOAT_EQ(cfg.cfgScale, 6.0f);
  EXPECT_FLOAT_EQ(cfg.flowShift, 0.0f);
  EXPECT_FLOAT_EQ(cfg.moeBoundary, 0.875f);
  EXPECT_FLOAT_EQ(cfg.strength, 0.75f);
  EXPECT_FLOAT_EQ(cfg.vaceStrength, 1.0f);
  EXPECT_TRUE(cfg.vaeTiling);
  EXPECT_EQ(cfg.vaeTileSizeX, 512);
  EXPECT_EQ(cfg.vaeTileSizeY, 512);
  EXPECT_FLOAT_EQ(cfg.vaeTileOverlap, 0.5f);
  EXPECT_EQ(cfg.cacheMode, SD_CACHE_DISABLED);
}

// -----------------------------------------------------------------------------
// 15. Unknown keys silently ignored (forward compatibility)
// -----------------------------------------------------------------------------

TEST(SdVidGenHandlers_UnknownKeys, AreSilentlyIgnored) {
  SdVidGenConfig cfg;
  EXPECT_NO_THROW(
      applySdVidGenHandlers(cfg, makeObj("some_future_field", str("value"))));
  // Defaults must be preserved -- handler silently ignored the unknown key.
  EXPECT_EQ(cfg.mode, "txt2vid");
  EXPECT_EQ(cfg.width, 480);
}

// -----------------------------------------------------------------------------
// 16. Multi-key batch -- ensures handler chaining works across families
// -----------------------------------------------------------------------------

TEST(SdVidGenHandlers_Integration, FullWan22PayloadSetsAllExpectedFields) {
  picojson::object obj;
  obj["mode"] = str("txt2vid");
  obj["prompt"] = str("a cat playing with yarn");
  obj["width"] = num(832);
  obj["height"] = num(480);
  obj["video_frames"] = num(33);
  obj["fps"] = num(24);
  obj["seed"] = num(42);
  obj["steps"] = num(30);
  obj["sampler"] = str("euler");
  obj["scheduler"] = str("simple");
  obj["cfg_scale"] = num(6.0);
  obj["flow_shift"] = num(7.0);
  obj["high_noise_steps"] = num(25);
  obj["high_noise_sampler"] = str("dpm++2m");
  obj["high_noise_scheduler"] = str("karras");
  obj["high_noise_cfg_scale"] = num(6.5);
  obj["high_noise_flow_shift"] = num(4.5);
  obj["moe_boundary"] = num(0.85);
  obj["vae_tiling"] = boolean(true);
  obj["vae_tile_size"] = num(256);
  obj["vae_tile_overlap"] = num(0.25);
  obj["cache_preset"] = str("fast");

  SdVidGenConfig cfg;
  ASSERT_NO_THROW(applySdVidGenHandlers(cfg, obj));

  EXPECT_EQ(cfg.mode, "txt2vid");
  EXPECT_EQ(cfg.prompt, "a cat playing with yarn");
  EXPECT_EQ(cfg.videoFrames, 33);
  EXPECT_EQ(cfg.fps, 24);
  EXPECT_EQ(cfg.seed, 42);
  EXPECT_EQ(cfg.sampleSteps, 30);
  EXPECT_EQ(cfg.sampleMethod, EULER_SAMPLE_METHOD);
  EXPECT_EQ(cfg.scheduler, SIMPLE_SCHEDULER);
  EXPECT_FLOAT_EQ(cfg.cfgScale, 6.0f);
  EXPECT_FLOAT_EQ(cfg.flowShift, 7.0f);
  EXPECT_EQ(cfg.highNoiseSteps, 25);
  EXPECT_EQ(cfg.highNoiseSampleMethod, DPMPP2M_SAMPLE_METHOD);
  EXPECT_EQ(cfg.highNoiseScheduler, KARRAS_SCHEDULER);
  EXPECT_FLOAT_EQ(cfg.highNoiseCfgScale, 6.5f);
  EXPECT_FLOAT_EQ(cfg.highNoiseFlowShift, 4.5f);
  EXPECT_FLOAT_EQ(cfg.moeBoundary, 0.85f);
  EXPECT_TRUE(cfg.vaeTiling);
  EXPECT_EQ(cfg.vaeTileSizeX, 256);
  EXPECT_EQ(cfg.vaeTileSizeY, 256);
  EXPECT_FLOAT_EQ(cfg.vaeTileOverlap, 0.25f);
  EXPECT_EQ(cfg.cacheMode, SD_CACHE_EASYCACHE);
  EXPECT_FLOAT_EQ(cfg.cacheThreshold, 0.25f);
}
