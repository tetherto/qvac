// Global test environment: preload the ggml DL backend modules before any test.
//
// Under GGML_BACKEND_DL the backends are separate libqvac-ggml-*.so modules
// staged next to the test binary by qvac_addon_stage_fabric_for_test(). Without
// this no backend (not even CPU) is registered, and tests that construct a
// backend dereference null and abort.

#include <ggml-backend.h>
#include <gtest/gtest.h>

#include "utils/BackendSelection.hpp"

// The ggml Vulkan backend leaks a small, one-time allocation while enumerating
// devices at registration — a known upstream ggml issue, benign (one-time,
// non-growing). Suppress that specific third-party leak so LeakSanitizer
// doesn't fail the run when ASan is enabled on addon-test.
extern "C" const char* __lsan_default_suppressions() {
  return "leak:ggml_backend_vk_reg_get_device\n";
}

namespace {

class BackendEnvironment : public ::testing::Environment {
public:
  void SetUp() override {
#ifdef GGML_BACKEND_DIR
    ggml_backend_load_all_from_path(GGML_BACKEND_DIR);
#else
    vla_backend_selection::loadBackendsOnce("");
#endif
  }
};

const ::testing::Environment* const kBackendEnvironment =
    ::testing::AddGlobalTestEnvironment(new BackendEnvironment);

} // namespace
