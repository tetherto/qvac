#pragma once

#include <filesystem>
#include <string>

namespace qvac::audiogenggml {

inline std::string resolveBackendsDir(const std::string& root) {
  if (root.empty()) {
    return {};
  }
  std::filesystem::path dir(root);
#ifdef BACKENDS_SUBDIR
  dir = (dir / std::filesystem::path(BACKENDS_SUBDIR)).lexically_normal();
#endif
  return dir.string();
}

}  // namespace qvac::audiogenggml
