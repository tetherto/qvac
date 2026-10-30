#include <ggml-backend.h>
#include <gtest/gtest.h>
#include <qvac-fabric.h>

namespace {

class TtsBackendEnvironment : public ::testing::Environment {
public:
  void SetUp() override {
    qvac_fabric_load_backends();
    ASSERT_NE(ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU), nullptr)
        << "No CPU backend found in " << qvac_fabric_backends_dir();
  }
};

const ::testing::Environment* const kTtsBackendEnvironment =
    ::testing::AddGlobalTestEnvironment(new TtsBackendEnvironment);

} // namespace
