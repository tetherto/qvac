#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <unordered_map>

/// Rejects images larger than a pixel budget before they are decoded, as
/// @qvac/llm-llamacpp's ImagePixelLimit does: a small compressed file can
/// decode to gigabytes of pixels.
namespace image_pixel_limit {

inline constexpr uint64_t DEFAULT_MAX_PIXELS = 50'000'000;

/// Reads and erases `image-max-megapixels` (or `image_max_megapixels`) from
/// @p config. Returns DEFAULT_MAX_PIXELS when neither is set.
uint64_t takeMaxPixels(std::unordered_map<std::string, std::string>& config);

/// Throws when @p data is an image larger than @p maxPixels, or an image whose
/// dimensions cannot be read. Audio (as mtmd detects it) passes.
void checkBuffer(const uint8_t* data, size_t size, uint64_t maxPixels);

/// Whether mtmd-helper treats @p data as audio (wav, mp3 or flac magic).
bool isMtmdAudio(const uint8_t* data, size_t size);

} // namespace image_pixel_limit
