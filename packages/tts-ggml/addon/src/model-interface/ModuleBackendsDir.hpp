#pragma once

#include <filesystem>
#include <string>

#include <qvac-fabric.h>

namespace qvac::ttsggml {

// A configured directory is used as given; otherwise the backends @qvac/fabric
// ships next to its runtime, which fabric locates itself (an installed
// platform package, a bare-pack bundle or a bare-link app alike).
inline std::filesystem::path resolveBackendsDir(const std::string& configured) {
  if (!configured.empty())
    return std::filesystem::path(configured);
  return std::filesystem::path(qvac_fabric_backends_dir());
}

} // namespace qvac::ttsggml
