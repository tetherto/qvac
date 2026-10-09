#include <ggml-backend.h>
#include <gmock/gmock.h>

TEST(AsrTestBackendStartup, CpuDeviceIsRegisteredBeforeModelLoad) {
  EXPECT_NE(ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU), nullptr);
}

int main(int argc, char** argv) {
  testing::InitGoogleMock(&argc, argv);
  ggml_backend_load_all_from_path(QVAC_ASR_TEST_BACKENDS_DIR);
  return RUN_ALL_TESTS();
}
