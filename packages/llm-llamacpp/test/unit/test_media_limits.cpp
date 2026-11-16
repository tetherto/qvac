#include <cstdint>
#include <limits>
#include <string>
#include <unordered_map>

#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>

#include "model-interface/MediaLimits.hpp"

namespace {
using Config = std::unordered_map<std::string, std::string>;
} // namespace

TEST(MediaLimits, DefaultsWhenUnset) {
  Config config{{"device", "gpu"}};
  const MediaLimits limits = takeMediaLimits(config);
  EXPECT_EQ(limits.maxImagePixels, image_pixel_limit::DEFAULT_MAX_PIXELS);
  EXPECT_EQ(limits.maxAudioSeconds, MediaLimits::DEFAULT_MAX_AUDIO_SECONDS);
  EXPECT_EQ(config, (Config{{"device", "gpu"}}));
}

TEST(MediaLimits, ReadsAndErasesBothSpellings) {
  Config hyphen{{"audio-max-seconds", "30"}, {"image-max-megapixels", "8"}};
  const MediaLimits limits = takeMediaLimits(hyphen);
  EXPECT_EQ(limits.maxAudioSeconds, 30U);
  EXPECT_EQ(limits.maxImagePixels, 8'000'000U);
  EXPECT_TRUE(hyphen.empty());

  Config underscore{{"audio_max_seconds", "45"}};
  EXPECT_EQ(takeMediaLimits(underscore).maxAudioSeconds, 45U);
  EXPECT_TRUE(underscore.empty());
}

TEST(MediaLimits, RejectsInvalidAudioSeconds) {
  for (const std::string value : {"0", "-1", "1.5", "ten", ""}) {
    Config config{{"audio-max-seconds", value}};
    EXPECT_THROW(takeMediaLimits(config), qvac_errors::StatusError) << value;
  }
  Config duplicate{{"audio-max-seconds", "30"}, {"audio_max_seconds", "30"}};
  EXPECT_THROW(takeMediaLimits(duplicate), qvac_errors::StatusError);
}

TEST(MediaLimits, DecodeOptionsCountAudioAtTheModelRate) {
  const MediaLimits limits{.maxImagePixels = 8'000'000, .maxAudioSeconds = 30};
  const mtmd_helper_init_opt opt = mediaDecodeOptions(limits, 16000);
  EXPECT_EQ(opt.max_image_pixels, 8'000'000U);
  EXPECT_EQ(opt.max_audio_frames, 30U * 16000U);
}

TEST(MediaLimits, DecodeOptionsWithoutAnAudioEncoder) {
  const mtmd_helper_init_opt opt = mediaDecodeOptions(MediaLimits{}, -1);
  EXPECT_EQ(opt.max_audio_frames, 0U);
  EXPECT_EQ(opt.max_image_pixels, image_pixel_limit::DEFAULT_MAX_PIXELS);
}

TEST(MediaLimits, DecodeOptionsSaturateInsteadOfWrapping) {
  // 0 means no limit to mtmd, so an overflowing product must not wrap to it.
  const MediaLimits limits{
      .maxAudioSeconds = std::numeric_limits<uint64_t>::max() / 2};
  EXPECT_EQ(
      mediaDecodeOptions(limits, 16000).max_audio_frames,
      std::numeric_limits<uint64_t>::max());
}
