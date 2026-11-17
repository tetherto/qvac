// A packaging-only Bare addon. Register its backend directory with the shared
// runtime without loading a GPU module (which may not be usable on this host).
#include <bare.h>

#include "backend-packages.h"

namespace {

js_value_t* backendPackageExports(js_env_t* /*env*/, js_value_t* exports) {
  qvac_fabric_register_backend_package(
      reinterpret_cast<void*>(&backendPackageExports),
      QVAC_FABRIC_MODULE_NAME,
      QVAC_FABRIC_BACKEND_FILE);
  return exports;
}

} // namespace

BARE_MODULE(qvac_fabric_backend, backendPackageExports)
