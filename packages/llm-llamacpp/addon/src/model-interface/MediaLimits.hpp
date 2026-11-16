#pragma once

#include <cstdint>
#include <string>
#include <unordered_map>

#include <llama/mtmd/mtmd-helper.h>

#include "ImagePixelLimit.hpp"

/// Admission limits for prompt media, read from the load config.
struct MediaLimits {
  static constexpr uint64_t DEFAULT_MAX_AUDIO_SECONDS = 600;

  /// image-max-megapixels, in pixels. The image header is checked before the
  /// prompt is processed, and mtmd checks it again when it decodes.
  uint64_t maxImagePixels = image_pixel_limit::DEFAULT_MAX_PIXELS;
  /// audio-max-seconds. mtmd checks it against the length its decoder reads,
  /// before it allocates the samples.
  uint64_t maxAudioSeconds = DEFAULT_MAX_AUDIO_SECONDS;
};

/// Reads and erases image-max-megapixels and audio-max-seconds (or their
/// underscore aliases) from @p config.
/// @throws qvac_errors::StatusError(InvalidArgument) on an invalid value, or
/// when both spellings of one option are set.
MediaLimits
takeMediaLimits(std::unordered_map<std::string, std::string>& config);

/// mtmd-helper's decode options for @p limits. @p audioSampleRate is the
/// projector's (mtmd_get_audio_sample_rate); without audio (< 1) no audio
/// limit is set, since mtmd rejects audio then anyway.
mtmd_helper_init_opt
mediaDecodeOptions(const MediaLimits& limits, int audioSampleRate);
