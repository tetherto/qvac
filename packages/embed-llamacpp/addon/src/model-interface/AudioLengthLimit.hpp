#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <unordered_map>

/// Rejects audio longer than a duration limit before it is decoded.
///
/// mtmd-helper sizes its decode by the length miniaudio reports, which comes
/// from the file's headers (WAV, FLAC) or its frames (MP3), and decodes all
/// of it to float samples at once. A small file can therefore declare, or
/// expand to, gigabytes of samples. The same length is read here first.
namespace audio_length_limit {

inline constexpr uint64_t DEFAULT_MAX_SECONDS = 600;

/// Reads and erases `audio-max-seconds` (or `audio_max_seconds`) from
/// @p config. Returns DEFAULT_MAX_SECONDS when neither is set.
uint64_t takeMaxSeconds(std::unordered_map<std::string, std::string>& config);

/// The length in seconds that WAV, FLAC or MP3 audio in @p data decodes to,
/// read without decoding it; nullopt when it cannot be read.
std::optional<double> durationSeconds(const uint8_t* data, size_t size);

/// Throws when the audio in @p data runs longer than @p maxSeconds, or when
/// its length cannot be read before decoding.
void checkBuffer(const uint8_t* data, size_t size, uint64_t maxSeconds);

} // namespace audio_length_limit
