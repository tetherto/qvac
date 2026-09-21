// Global test environment: preload the ggml DL backend modules before any test.
//
// Under GGML_BACKEND_DL the backends are separate libqvac-ggml-*.so modules
// shipped with the shared @qvac/fabric runtime. ggml's default search only
// looks next to the test binary and the CWD, and under ctest addon-test runs
// from the package root (where the model fixtures are), so without this no
// backend (not even CPU) is registered and tests that construct a backend
// dereference null and abort (ASan). CMake stages the backends into the test
// binary dir and injects its absolute path via GGML_BACKEND_DIR; load them from
// there before the first test. No-op in static builds (no modules in that dir,
// CPU is linked in).

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
