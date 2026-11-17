#pragma once

#include <filesystem>
#include <string>

#include <qvac-fabric.h>

namespace qvac::ttsggml {

inline std::filesystem::path resolveBackendsDir(const std::string& configured) {
  if (!configured.empty())
    return std::filesystem::path(configured);
  qvac_fabric_load_backends();
  return std::filesystem::path(qvac_fabric_backends_dir());
}

} // namespace qvac::ttsggml
