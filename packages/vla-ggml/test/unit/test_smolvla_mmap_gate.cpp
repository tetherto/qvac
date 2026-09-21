// Guards the gate that decides whether smolvlaLoadModel maps the GGUF or
// allocates a copy of it.
//
// ggml declares the CPU buffer type with a NULL device, so a gate that reads
// the device back off the buffer type answers "cannot map" on every CPU load
// and commits the whole model to anonymous memory — an allocation iOS refuses
// near its jetsam limit. Asserting smolvlaCanMmapWeights directly is what makes
// that a test failure rather than a silent change of strategy.
//
// The NULL device itself is deliberately not asserted: it is ggml's own
// documented FIXME, and pinning it here would turn an upstream fix into a red
// build while nothing was actually broken.

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

TEST(SmolvlaMmapGate, CpuLoadMapsTheWeights) {
  CpuBackend cpu;
  ASSERT_NE(cpu.backend, nullptr) << "no CPU backend registered";

  EXPECT_TRUE(smolvlaCanMmapWeights(cpu.backend))
      << "a CPU weight load will copy the whole model into anonymous memory "
         "instead of mapping it";
}

// Separates "we broke the gate" from "the CPU backend stopped accepting host
// pointers", which would need a different fix than restoring the gate.
TEST(SmolvlaMmapGate, CpuDeviceStillAcceptsHostPointers) {
  CpuBackend cpu;
  ASSERT_NE(cpu.backend, nullptr) << "no CPU backend registered";

  ggml_backend_dev_t dev = ggml_backend_get_device(cpu.backend);
  ASSERT_NE(dev, nullptr) << "a live backend has no device";

  ggml_backend_dev_props props;
  ggml_backend_dev_get_props(dev, &props);

  EXPECT_TRUE(props.caps.buffer_from_host_ptr)
      << "the CPU device no longer wraps host pointers, so mapped weights are "
         "no longer possible on a CPU load";
}
