#include <ggml-backend.h>
#include <gtest/gtest.h>

namespace {

class AsrBackendEnvironment : public ::testing::Environment {
public:
  void SetUp() override {
    // The standalone test executable has no JS-provided backendsDir. Load
    // CPU modules before tests can construct a Whisper VAD context directly.
    ggml_backend_load_all_from_path(QVAC_ASR_TEST_BACKENDS_DIR);
    ASSERT_NE(ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU), nullptr)
        << "No CPU backend found in " << QVAC_ASR_TEST_BACKENDS_DIR;
  }
};

const ::testing::Environment* const kAsrBackendEnvironment =
    ::testing::AddGlobalTestEnvironment(new AsrBackendEnvironment);

} // namespace
