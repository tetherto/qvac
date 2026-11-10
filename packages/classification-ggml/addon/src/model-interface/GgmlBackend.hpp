#pragma once

#include <cstddef>
#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

#include <ggml-backend.h>

#include "ModelFootprint.hpp"

namespace classification_ggml {

// Held around backend registration, device selection and device queries.
// ggml's backend registry has no lock of its own, and a backendsDir load
// appends to it while another thread may be iterating it. It covers this
// addon's callers only.
std::mutex& backendRegistryMutex();

// One compute device plus the CPU backend the scheduler falls back to. Both are
// owned; `cpu` equals `device` when the CPU itself was selected.
class GgmlBackends {
public:
  // `backend` is an exact ggml device name (CPU, CUDA0, Vulkan0, MTL0 or
  // Metal0); empty picks a GPU, then an integrated GPU, then the CPU.
  // `backendsDir` overrides where dynamic backends are loaded from. `who`
  // prefixes error messages.
  GgmlBackends(
      const std::string& backend, const std::string& backendsDir, int threads,
      const std::string& who);
  ~GgmlBackends();
  GgmlBackends(const GgmlBackends&) = delete;
  GgmlBackends& operator=(const GgmlBackends&) = delete;

  [[nodiscard]] ggml_backend_t device() const { return device_; }
  [[nodiscard]] ggml_backend_t cpu() const { return cpu_; }

private:
  ggml_backend_t device_ = nullptr;
  ggml_backend_t cpu_ = nullptr;
};

// One buffer of a ggml_backend_alloc_ctx_tensors allocation: the tensors
// [first, last) in context order and the bytes requested for them.
struct BufferSplit {
  size_t bytes = 0;
  int first = 0;
  int last = 0;
};

// How ggml_backend_alloc_ctx_tensors_from_buft splits the tensors of `ctx`
// into buffers of at most `maxSize` bytes (fabric ggml-backend.cpp,
// ggml_backend_buft_alloc_buffer_n_plan). A tensor larger than `maxSize` gets
// a buffer of its own. Only tensors without data or a view source take space.
std::vector<BufferSplit> planBufferSplits(
    ggml_context* ctx, ggml_backend_buffer_type_t type, size_t maxSize);

// Physical bytes of the buffers ggml_backend_alloc_ctx_tensors(ctx, backend)
// would allocate, without allocating them.
uint64_t ctxBufferBytes(ggml_context* ctx, ggml_backend_t backend);

// Physical bytes of the buffers the allocated non-view tensors of `ctx` sit
// in, each buffer counted once. The counterpart of ctxBufferBytes after
// allocation.
uint64_t allocatedCtxBytes(ggml_context* ctx);

// Empty buffers that stand in for a weight allocation. They own no storage.
class EmptyWeightBuffers {
public:
  EmptyWeightBuffers() = default;
  ~EmptyWeightBuffers();
  EmptyWeightBuffers(const EmptyWeightBuffers&) = delete;
  EmptyWeightBuffers& operator=(const EmptyWeightBuffers&) = delete;
  EmptyWeightBuffers(EmptyWeightBuffers&& other) noexcept;
  EmptyWeightBuffers& operator=(EmptyWeightBuffers&& other) noexcept;

  [[nodiscard]] size_t size() const { return buffers_.size(); }

private:
  friend EmptyWeightBuffers placeOnEmptyWeightBuffers(
      ggml_context* ctx, ggml_backend_buffer_type_t type, size_t maxSize);
  std::vector<ggml_backend_buffer_t> buffers_;
};

// Puts every tensor of `ctx` on empty weight buffers of `type`, split the way
// ggml_backend_alloc_ctx_tensors splits them at `maxSize`, so a graph over
// them can be split and sized without their data. The tensors get the
// addresses real buffers would lay them out at, but there is no storage
// behind them: they must not be read, written or computed.
EmptyWeightBuffers placeOnEmptyWeightBuffers(
    ggml_context* ctx, ggml_backend_buffer_type_t type, size_t maxSize);
// The same for the default buffer type of `backend` and its max size.
EmptyWeightBuffers
placeOnEmptyWeightBuffers(ggml_context* ctx, ggml_backend_t backend);

// Physical compute buffer sizes of a scheduler over {device, cpu} that has
// allocated and run a graph, and the workspace the CPU backend holds, which
// keeps the largest size any graph it ran needed.
BufferFootprint schedulerBuffers(
    ggml_backend_sched_t scheduler, ggml_backend_t device, ggml_backend_t cpu);

// The same numbers for `graph` on a fresh scheduler, without allocating. The
// workspace is planned from the graph's CPU splits. Returns false when the
// graph cannot be split.
bool measureSchedulerBuffers(
    ggml_backend_sched_t scheduler, ggml_cgraph* graph, ggml_backend_t device,
    ggml_backend_t cpu, BufferFootprint& out);

// ggml device name of a backend, e.g. CPU, MTL0, CUDA0.
std::string deviceName(ggml_backend_t backend);

// Public backend ids reported in runtime stats: CPU=0, Metal=1, CUDA=2,
// Vulkan=3, OpenCL=4, other=99.
int backendId(const char* name);

} // namespace classification_ggml
