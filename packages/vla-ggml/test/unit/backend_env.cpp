// Global test environment: load the ggml backends once before any test runs.
//
// In production the addon loads its backends at init via
// vla_backend_selection::loadBackendsOnce(backendsDir), where backendsDir is
// the prebuilds folder holding the DL backend modules. The unit tests link the
// addon objects directly and the factory test passes backendsDir="" — fine in a
// static build (CPU is linked in), but under GGML_BACKEND_DL=ON it means no
// backend gets loaded, so pi05LoadModel throws "no CPU backend available".
//
// The DL modules (libqvac-ggml-cpu-*.so) are installed next to the ggml core
// library this test binary links. Resolve that directory at runtime via
// dladdr() and hand it to loadBackendsOnce() — the same code path production
// uses, just with the test's own lib dir. loadBackendsOnce is std::call_once,
// so this first load wins and the factory test's later loadBackendsOnce("")
// becomes a no-op.

#include <filesystem>
#include <string>

#include <ggml-backend.h>
#include <gtest/gtest.h>

#include "utils/BackendSelection.hpp"

// dladdr/dlfcn is the POSIX fallback used only when CMake didn't inject
// GGML_BACKEND_DIR. It doesn't exist on Windows (a static, non-DL build where
// GGML_BACKEND_DIR is always defined), so keep the include behind the guard.
#ifndef GGML_BACKEND_DIR
#include <dlfcn.h>
#endif

namespace {

// Directory of the ggml core library linked into this test binary, where the
// DL backend modules are co-installed. CMake injects the absolute path via
// GGML_BACKEND_DIR; we fall back to dladdr (and then the default search) only
// if it isn't defined.
std::string ggmlLibDir() {
#ifdef GGML_BACKEND_DIR
  return GGML_BACKEND_DIR;
#else
  Dl_info info{};
  if (dladdr(reinterpret_cast<const void*>(&ggml_backend_load_all), &info) !=
          0 &&
      info.dli_fname != nullptr) {
    return std::filesystem::path(info.dli_fname).parent_path().string();
  }
  return "";
#endif
}

class BackendEnvironment : public ::testing::Environment {
public:
  void SetUp() override {
    vla_backend_selection::loadBackendsOnce(ggmlLibDir());
  }
};

// Registered at static-init (before main), so gtest_main runs SetUp() ahead of
// RUN_ALL_TESTS. The returned pointer is owned by gtest.
const ::testing::Environment* const kBackendEnvironment =
    ::testing::AddGlobalTestEnvironment(new BackendEnvironment);

} // namespace
