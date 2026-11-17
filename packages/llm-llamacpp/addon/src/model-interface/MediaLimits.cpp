#include "MediaLimits.hpp"

#include <charconv>
#include <limits>

#include <inference-addon-cpp/Errors.hpp>

#include "addon/LlmErrors.hpp"

namespace {
qvac_errors::StatusError invalidOption(const std::string& message) {
  return {
      qvac_lib_inference_addon_llama::errors::ADDON_ID,
      qvac_errors::general_error::toString(
          qvac_errors::general_error::InvalidArgument),
      message};
}

uint64_t
takeMaxAudioSeconds(std::unordered_map<std::string, std::string>& config) {
  const auto hyphen = config.find("audio-max-seconds");
  const auto underscore = config.find("audio_max_seconds");
  if (hyphen != config.end() && underscore != config.end()) {
    throw invalidOption(
        "Set only one of audio-max-seconds and audio_max_seconds");
  }
  const auto it = hyphen != config.end() ? hyphen : underscore;
  if (it == config.end()) {
    return MediaLimits::DEFAULT_MAX_AUDIO_SECONDS;
  }

  uint64_t seconds = 0;
  const auto* begin = it->second.data();
  const auto* end = begin + it->second.size();
  const auto result = std::from_chars(begin, end, seconds);
  if (result.ec != std::errc{} || result.ptr != end || seconds == 0) {
    throw invalidOption(
        "audio-max-seconds must be a positive integer, got: " + it->second);
  }
  config.erase(it);
  return seconds;
}
} // namespace

MediaLimits
takeMediaLimits(std::unordered_map<std::string, std::string>& config) {
  MediaLimits limits;
  limits.maxImagePixels = image_pixel_limit::takeMaxPixels(config);
  limits.maxAudioSeconds = takeMaxAudioSeconds(config);
  return limits;
}

mtmd_helper_init_opt
mediaDecodeOptions(const MediaLimits& limits, int audioSampleRate) {
  mtmd_helper_init_opt opt = mtmd_helper_init_opt_default();
  opt.max_image_pixels = limits.maxImagePixels;
  if (audioSampleRate > 0) {
    // The limit counts samples at the model's rate, plus one: miniaudio counts
    // one frame more when the input rate is a multiple of the model's (48 kHz
    // to 16 kHz), so audio exactly at the limit would fail. 0 would mean no
    // limit, so a value past uint64 saturates instead of wrapping.
    const auto rate = static_cast<uint64_t>(audioSampleRate);
    constexpr uint64_t MAX = std::numeric_limits<uint64_t>::max();
    opt.max_audio_frames = limits.maxAudioSeconds > (MAX - 1) / rate
                               ? MAX
                               : limits.maxAudioSeconds * rate + 1;
  }
  return opt;
}
