#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

namespace image_pixel_limit {

inline constexpr uint64_t DEFAULT_MAX_PIXELS = 50'000'000;

uint64_t takeMaxPixels(std::unordered_map<std::string, std::string>& config);

void checkBuffer(const uint8_t* data, size_t size, uint64_t maxPixels);
void checkFile(const std::string& path, uint64_t maxPixels);
std::vector<uint8_t> readRegularFile(const std::string& path);

} // namespace image_pixel_limit
