#include <ggml-backend.h>
#include <gtest/gtest.h>

namespace {

class TtsBackendEnvironment : public ::testing::Environment {
public:
  void SetUp() override {
    ggml_backend_load_all_from_path(QVAC_TTS_TEST_BACKENDS_DIR);
    ASSERT_NE(ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU), nullptr)
        << "No CPU backend found in " << QVAC_TTS_TEST_BACKENDS_DIR;
  }
};

const ::testing::Environment* const kTtsBackendEnvironment =
    ::testing::AddGlobalTestEnvironment(new TtsBackendEnvironment);

} // namespace
