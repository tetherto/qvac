#pragma once

#include <fstream>
#include <stdexcept>
#include <string>

namespace qvac::ttslib {

inline std::string loadFileBytes(const std::string &path) {
  std::ifstream f(path, std::ios::binary | std::ios::ate);
  if (!f)
    throw std::runtime_error("Cannot open file: " + path);
  const size_t size = static_cast<size_t>(f.tellg());
  f.seekg(0);
  std::string data(size, '\0');
  if (!f.read(data.data(), size))
    throw std::runtime_error("Failed to read file: " + path);
  return data;
}

} // namespace qvac::ttslib
