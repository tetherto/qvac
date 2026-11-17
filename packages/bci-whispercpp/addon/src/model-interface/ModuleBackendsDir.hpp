#pragma once

#include <filesystem>
#include <string>

#include <qvac-fabric.h>

namespace qvac_lib_inference_addon_bci {

inline std::filesystem::path resolveBackendsDir(const std::string& configured) {
  if (!configured.empty())
    return std::filesystem::path(configured);
  return std::filesystem::path(qvac_fabric_backends_dir());
}

} // namespace qvac_lib_inference_addon_bci
