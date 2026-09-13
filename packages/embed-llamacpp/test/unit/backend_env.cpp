// Global test environment: preload the ggml DL backend modules before any test.
//
// Under GGML_BACKEND_DL the backends are separate libqvac-ggml-*.so modules
// co-installed with the ggml core lib. ggml's default search only looks next to
// the test binary and the CWD, so without this no backend (not even CPU) is
// registered, and tests that construct a backend dereference null and abort
// (ASan). CMake injects the absolute ggml lib dir via GGML_BACKEND_DIR; load
// the modules from there before the first test. No-op in static builds (no
// modules in that dir, CPU is linked in).

#include <ggml-backend.h>
#include <gtest/gtest.h>

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
