#include <ggml-backend.h>
#include <gmock/gmock.h>
#include <qvac-fabric.h>

TEST(AsrTestBackendStartup, CpuDeviceIsRegisteredBeforeModelLoad) {
  EXPECT_NE(ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU), nullptr);
}

int main(int argc, char** argv) {
  testing::InitGoogleMock(&argc, argv);
  qvac_fabric_load_backends();
  return RUN_ALL_TESTS();
}
