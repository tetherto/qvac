// Guards the device resolution that gates smolvlaLoadModel's mmap fast path.
//
// ggml declares the CPU buffer type with a NULL device, so reading
// capabilities straight off the buffer type skips the fast path on every CPU
// load and commits the whole model to anonymous memory — an allocation iOS
// refuses near its jetsam limit. These tests assert a CPU load still resolves
// a device and satisfies both gates.

#include <ggml-backend.h>
#include <gtest/gtest.h>

#include "model-interface/smolvla.hpp"

namespace {

struct CpuBackend {
  ggml_backend_t backend = nullptr;

  CpuBackend() {
    ggml_backend_dev_t dev =
        ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
    if (dev != nullptr) {
      backend = ggml_backend_dev_init(dev, nullptr);
    }
  }

  CpuBackend(const CpuBackend&) = delete;
  CpuBackend& operator=(const CpuBackend&) = delete;

  ~CpuBackend() {
    if (backend != nullptr) {
      ggml_backend_free(backend);
    }
  }
};

} // namespace

TEST(SmolvlaWeightsDevice, ResolvesADeviceForTheCpuBufferType) {
  CpuBackend cpu;
  ASSERT_NE(cpu.backend, nullptr) << "no CPU backend registered";

  ggml_backend_buffer_type_t buft =
      ggml_backend_get_default_buffer_type(cpu.backend);
  ASSERT_NE(buft, nullptr);

  EXPECT_NE(smolvlaResolveDevice(buft), nullptr)
      << "a CPU weight load cannot read device capabilities, so it will "
         "allocate the whole model in anonymous memory";
}

TEST(SmolvlaWeightsDevice, CpuLoadSatisfiesBothMmapFastPathGates) {
  CpuBackend cpu;
  ASSERT_NE(cpu.backend, nullptr) << "no CPU backend registered";

  ggml_backend_buffer_type_t buft =
      ggml_backend_get_default_buffer_type(cpu.backend);
  ggml_backend_dev_t dev = smolvlaResolveDevice(buft);
  ASSERT_NE(dev, nullptr);

  ggml_backend_dev_props props;
  ggml_backend_dev_get_props(dev, &props);

  EXPECT_TRUE(props.caps.buffer_from_host_ptr)
      << "the CPU device no longer accepts host pointers, so CPU weight loads "
         "fall back to a single anonymous allocation of the whole model";
  EXPECT_EQ(buft, ggml_backend_dev_buffer_type(dev))
      << "the CPU backend's default buffer type is no longer the device's "
         "own, so the mmap fast path is skipped on every CPU load";
}
