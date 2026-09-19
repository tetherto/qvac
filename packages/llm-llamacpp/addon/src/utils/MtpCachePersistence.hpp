#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <optional>
#include <random>
#include <string>
#include <system_error>
#include <vector>

namespace qvac_lib_inference_addon_llama::utils {

inline constexpr size_t MTP_STATE_HEADER_SIZE = 28;
inline constexpr uint64_t MTP_STATE_MAX_BYTES = 64ULL * 1024ULL * 1024ULL;

struct MtpDriverStateFile {
  uint64_t generation = 0;
  std::vector<uint8_t> state;
};

inline uint64_t makeMtpCacheGeneration() {
  std::random_device source;
  std::seed_seq seed{
      source(),
      source(),
      source(),
      source(),
      source(),
      source(),
      source(),
      source()};
  std::mt19937_64 generator(seed);
  uint64_t generation = 0;
  while (generation == 0) {
    generation = generator();
  }
  return generation;
}

inline std::string mtpDraftCachePath(const std::string& cacheKey) {
  return cacheKey + ".mtp-draft";
}

inline std::string mtpDriverStateCachePath(const std::string& cacheKey) {
  return cacheKey + ".mtp-state";
}

inline bool writeMtpDriverStateFile(
    const std::string& path, uint64_t generation,
    const std::vector<uint8_t>& state) {
  static constexpr std::array<char, 8> magic = {
      'Q', 'V', 'M', 'T', 'P', 'S', 'T', '\0'};
  static constexpr uint32_t version = 1;
  const uint64_t stateSize = state.size();
  if (generation == 0 || state.empty() || stateSize > MTP_STATE_MAX_BYTES) {
    return false;
  }

  std::ofstream output(path, std::ios::binary | std::ios::trunc);
  if (!output) {
    return false;
  }
  output.write(magic.data(), static_cast<std::streamsize>(magic.size()));
  output.write(
      reinterpret_cast<const char*>(&version),
      static_cast<std::streamsize>(sizeof(version)));
  output.write(
      reinterpret_cast<const char*>(&generation),
      static_cast<std::streamsize>(sizeof(generation)));
  output.write(
      reinterpret_cast<const char*>(&stateSize),
      static_cast<std::streamsize>(sizeof(stateSize)));
  output.write(
      reinterpret_cast<const char*>(state.data()),
      static_cast<std::streamsize>(state.size()));
  output.flush();
  return output.good();
}

inline std::optional<MtpDriverStateFile>
readMtpDriverStateFile(const std::string& path) {
  static constexpr std::array<char, 8> expectedMagic = {
      'Q', 'V', 'M', 'T', 'P', 'S', 'T', '\0'};
  static constexpr uint32_t expectedVersion = 1;

  std::error_code sizeError;
  const uint64_t fileSize = std::filesystem::file_size(path, sizeError);
  if (sizeError || fileSize < MTP_STATE_HEADER_SIZE) {
    return std::nullopt;
  }

  std::ifstream input(path, std::ios::binary);
  if (!input) {
    return std::nullopt;
  }
  std::array<char, 8> magic{};
  uint32_t version = 0;
  MtpDriverStateFile result;
  uint64_t stateSize = 0;
  input.read(magic.data(), static_cast<std::streamsize>(magic.size()));
  input.read(
      reinterpret_cast<char*>(&version),
      static_cast<std::streamsize>(sizeof(version)));
  input.read(
      reinterpret_cast<char*>(&result.generation),
      static_cast<std::streamsize>(sizeof(result.generation)));
  input.read(
      reinterpret_cast<char*>(&stateSize),
      static_cast<std::streamsize>(sizeof(stateSize)));
  if (!input || magic != expectedMagic || version != expectedVersion ||
      result.generation == 0 || stateSize == 0 ||
      stateSize > MTP_STATE_MAX_BYTES ||
      fileSize != MTP_STATE_HEADER_SIZE + stateSize) {
    return std::nullopt;
  }

  result.state.resize(static_cast<size_t>(stateSize));
  input.read(
      reinterpret_cast<char*>(result.state.data()),
      static_cast<std::streamsize>(result.state.size()));
  if (!input) {
    return std::nullopt;
  }
  return result;
}

} // namespace qvac_lib_inference_addon_llama::utils
