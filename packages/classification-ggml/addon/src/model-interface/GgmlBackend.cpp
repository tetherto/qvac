#include "GgmlBackend.hpp"

#include <algorithm>
#include <cstdint>
#include <utility>
#include <vector>

#include <ggml-alloc.h>
#include <inference-addon-cpp/Errors.hpp>
#include <qvac-fabric.h>

namespace classification_ggml {

using qvac_errors::StatusError;
using qvac_errors::general_error::InternalError;
using qvac_errors::general_error::InvalidArgument;

int backendId(const char* name) {
  const std::string value(name);
  if (value.starts_with("CPU"))
    return 0;
  if (value.starts_with("Metal") || value.starts_with("MTL"))
    return 1;
  if (value.starts_with("CUDA"))
    return 2;
  if (value.starts_with("Vulkan"))
    return 3;
  if (value.starts_with("OpenCL") || value.starts_with("GPUOpenCL"))
    return 4;
  return 99;
}

std::string deviceName(ggml_backend_t backend) {
  return ggml_backend_dev_name(ggml_backend_get_device(backend));
}

std::mutex& backendRegistryMutex() {
  static std::mutex mutex;
  return mutex;
}

std::vector<BufferSplit> planBufferSplits(
    ggml_context* ctx, ggml_backend_buffer_type_t type, size_t maxSize) {
  std::vector<BufferSplit> plan;
  const size_t alignment = ggml_backend_buft_get_alignment(type);
  size_t current = 0;
  int first = 0;
  int index = 0;
  for (auto* tensor = ggml_get_first_tensor(ctx); tensor != nullptr;
       tensor = ggml_get_next_tensor(ctx, tensor), ++index) {
    const size_t bytes =
        tensor->data == nullptr && tensor->view_src == nullptr
            ? GGML_PAD(
                  ggml_backend_buft_get_alloc_size(type, tensor), alignment)
            : 0;
    if (bytes > 0 && current > 0 && current + bytes > maxSize) {
      plan.push_back({current, first, index});
      current = bytes;
      first = index;
    } else {
      current += bytes;
    }
  }
  if (current > 0)
    plan.push_back({current, first, index});
  return plan;
}

uint64_t ctxBufferBytes(ggml_context* ctx, ggml_backend_t backend) {
  auto* type = ggml_backend_get_default_buffer_type(backend);
  // Each buffer is padded on its own by the backend, so the sum is taken per
  // split. Hexagon plans its own splits but only groups KV cache tensors
  // differently, which these models do not have.
  uint64_t total = 0;
  for (const BufferSplit& split :
       planBufferSplits(ctx, type, ggml_backend_buft_get_max_size(type)))
    total += ggml_backend_buft_get_buffer_alloc_size(type, split.bytes);
  return total;
}

uint64_t allocatedCtxBytes(ggml_context* ctx) {
  // A split allocation is a multi buffer whose parts carry the tensors. A
  // view sits in its source's buffer, which may belong to another context.
  std::vector<ggml_backend_buffer_t> seen;
  uint64_t total = 0;
  for (auto* tensor = ggml_get_first_tensor(ctx); tensor != nullptr;
       tensor = ggml_get_next_tensor(ctx, tensor)) {
    auto* buffer = tensor->buffer;
    if (buffer == nullptr || tensor->view_src != nullptr ||
        std::find(seen.begin(), seen.end(), buffer) != seen.end())
      continue;
    seen.push_back(buffer);
    total += ggml_backend_buft_get_buffer_alloc_size(
        ggml_backend_buffer_get_type(buffer),
        ggml_backend_buffer_get_size(buffer));
  }
  return total;
}

EmptyWeightBuffers::~EmptyWeightBuffers() {
  for (auto* buffer : buffers_)
    ggml_backend_buffer_free(buffer);
}

EmptyWeightBuffers::EmptyWeightBuffers(EmptyWeightBuffers&& other) noexcept
    : buffers_(std::move(other.buffers_)) {
  other.buffers_.clear();
}

EmptyWeightBuffers&
EmptyWeightBuffers::operator=(EmptyWeightBuffers&& other) noexcept {
  if (this != &other) {
    for (auto* buffer : buffers_)
      ggml_backend_buffer_free(buffer);
    buffers_ = std::move(other.buffers_);
    other.buffers_.clear();
  }
  return *this;
}

EmptyWeightBuffers placeOnEmptyWeightBuffers(
    ggml_context* ctx, ggml_backend_buffer_type_t type, size_t maxSize) {
  const std::vector<BufferSplit> plan = planBufferSplits(ctx, type, maxSize);
  std::vector<ggml_tensor*> tensors;
  for (auto* tensor = ggml_get_first_tensor(ctx); tensor != nullptr;
       tensor = ggml_get_next_tensor(ctx, tensor))
    tensors.push_back(tensor);
  // A backend may reorder a graph by which memory its nodes touch: Metal keeps
  // two nodes in order when one writes a range the other reads, keyed on the
  // tensor's buffer and address, and a reshape of a weight counts as a write
  // to it. Weights that all sat at one address would look like one range and
  // give a different order, so a different compute buffer size. Lay them out
  // the way the allocator does, one buffer per split, from bases that are
  // never dereferenced and do not overlap.
  const size_t alignment = ggml_backend_buft_get_alignment(type);
  EmptyWeightBuffers result;
  uintptr_t base = alignment;
  for (const BufferSplit& split : plan) {
    // ggml hands out a buffer without storage for size 0. The scheduler places
    // a tensor by its buffer and the graph allocator skips a tensor that has
    // one.
    auto* buffer = ggml_backend_buft_alloc_buffer(type, 0);
    if (!buffer)
      throw StatusError(InternalError, "empty weight buffer allocation failed");
    result.buffers_.push_back(buffer);
    ggml_backend_buffer_set_usage(buffer, GGML_BACKEND_BUFFER_USAGE_WEIGHTS);
    uintptr_t address = base;
    for (int i = split.first; i < split.last; ++i) {
      auto* tensor = tensors[i];
      if (tensor->data != nullptr || tensor->view_src != nullptr)
        continue;
      tensor->buffer = buffer;
      tensor->data = reinterpret_cast<void*>(address);
      address +=
          GGML_PAD(ggml_backend_buft_get_alloc_size(type, tensor), alignment);
    }
    base += GGML_PAD(split.bytes, alignment);
  }
  return result;
}

EmptyWeightBuffers
placeOnEmptyWeightBuffers(ggml_context* ctx, ggml_backend_t backend) {
  auto* type = ggml_backend_get_default_buffer_type(backend);
  return placeOnEmptyWeightBuffers(
      ctx, type, ggml_backend_buft_get_max_size(type));
}

BufferFootprint schedulerBuffers(
    ggml_backend_sched_t scheduler, ggml_backend_t device, ggml_backend_t cpu) {
  auto physical = [&](ggml_backend_t backend) {
    return ggml_backend_buft_get_buffer_alloc_size(
        ggml_backend_sched_get_buffer_type(scheduler, backend),
        ggml_backend_sched_get_buffer_size(scheduler, backend));
  };
  BufferFootprint result;
  result.deviceComputeBytes = physical(device);
  if (cpu != device)
    result.cpuComputeBytes = physical(cpu);
  result.cpuWorkBytes = ggml_backend_get_work_size(cpu);
  return result;
}

bool measureSchedulerBuffers(
    ggml_backend_sched_t scheduler, ggml_cgraph* graph, ggml_backend_t device,
    ggml_backend_t cpu, BufferFootprint& out) {
  // ggml_backend_sched_reserve_size fills one size per scheduler backend, in
  // the order the backends were given to ggml_backend_sched_new.
  std::vector<size_t> sizes(ggml_backend_sched_get_n_backends(scheduler), 0);
  if (!ggml_backend_sched_reserve_size(scheduler, graph, sizes.data()))
    return false;
  auto physical = [&](ggml_backend_t backend, size_t index) {
    return ggml_backend_buft_get_buffer_alloc_size(
        ggml_backend_sched_get_buffer_type(scheduler, backend), sizes[index]);
  };
  out.deviceComputeBytes = physical(device, 0);
  // Two backends with one buffer type share one buffer, which the scheduler
  // reports on the first only.
  const bool ownCpuBuffer =
      cpu != device &&
      ggml_backend_sched_get_buffer_type(scheduler, cpu) !=
          ggml_backend_sched_get_buffer_type(scheduler, device);
  out.cpuComputeBytes = ownCpuBuffer ? physical(cpu, 1) : 0;
  out.cpuWorkBytes = ggml_backend_sched_get_work_size(scheduler, cpu);
  return true;
}

GgmlBackends::GgmlBackends(
    const std::string& backend, const std::string& backendsDir, int threads,
    const std::string& who) {
  const std::lock_guard<std::mutex> lock(backendRegistryMutex());
#if defined(GGML_BACKEND_DL)
  if (backendsDir.empty())
    qvac_fabric_load_backends();
  else
    ggml_backend_load_all_from_path(backendsDir.c_str());
#else
  (void)backendsDir;
#endif
  auto* selected = backend.empty()
                       ? ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_GPU)
                       : ggml_backend_dev_by_name(backend.c_str());
  if (!selected && backend.starts_with("Metal")) {
    const auto name = "MTL" + backend.substr(5);
    selected = ggml_backend_dev_by_name(name == "MTL" ? "MTL0" : name.c_str());
  }
  if (!selected && backend.empty())
    selected = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_IGPU);
  if (!selected && backend.empty())
    selected = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
  if (selected == nullptr)
    throw StatusError(
        InvalidArgument,
        who + ": requested backend is unavailable: " + backend);
  device_ = ggml_backend_dev_init(selected, nullptr);
  if (!device_)
    throw StatusError(InternalError, who + " backend initialization failed");
  cpu_ = ggml_backend_dev_type(selected) == GGML_BACKEND_DEVICE_TYPE_CPU
             ? device_
             : ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_CPU, nullptr);
  if (!cpu_) {
    ggml_backend_free(device_);
    device_ = nullptr;
    throw StatusError(
        InternalError, who + " CPU backend initialization failed");
  }
  auto* registry = ggml_backend_dev_backend_reg(ggml_backend_get_device(cpu_));
  auto setThreads = reinterpret_cast<void (*)(ggml_backend_t, int)>(
      ggml_backend_reg_get_proc_address(
          registry, "ggml_backend_set_n_threads"));
  if (setThreads)
    setThreads(cpu_, threads);
}

GgmlBackends::~GgmlBackends() {
  if (cpu_ && cpu_ != device_)
    ggml_backend_free(cpu_);
  if (device_)
    ggml_backend_free(device_);
}

} // namespace classification_ggml
