// Global test environment: preload the ggml DL backend modules before any test.
//
// Under GGML_BACKEND_DL the backends are separate libqvac-ggml-*.so modules
// co-installed with the ggml core lib. ggml's default search only looks next to
// the test binary and the CWD, so without this no backend (not even CPU) is
// registered, and tests that construct a backend dereference null and abort.
// CMake injects the absolute ggml lib dir via GGML_BACKEND_DIR; load the
// modules from there before the first test. No-op in static builds (no modules
// there, CPU is linked in).

#include <ggml-backend.h>
#include <gtest/gtest.h>

// The ggml Vulkan backend leaks a small, one-time allocation while enumerating
// devices at registration (ggml_backend_vk_reg_get_device) — a known upstream
// ggml issue, benign (one-time, non-growing). classification is a CPU-only
// model that only pulls in the Vulkan module incidentally via load_all under
// GGML_BACKEND_DL; suppress that specific third-party leak so LeakSanitizer
// doesn't fail the run. All test assertions still execute unchanged.
extern "C" const char* __lsan_default_suppressions() {
  return "leak:ggml_backend_vk_reg_get_device\n";
}

namespace {

class GgmlBackendEnvironment : public ::testing::Environment {
public:
  void SetUp() override {
#ifdef GGML_BACKEND_DIR
    ggml_backend_load_all_from_path(GGML_BACKEND_DIR);
#else
    ggml_backend_load_all();
#endif
  }
};

const ::testing::Environment* const kGgmlBackendEnv =
    ::testing::AddGlobalTestEnvironment(new GgmlBackendEnvironment);

} // namespace
