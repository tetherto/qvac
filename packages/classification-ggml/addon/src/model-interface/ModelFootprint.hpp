#pragma once

// Memory a model takes once loaded and run, measured from the GGUF metadata
// alone: the tensors and graphs are built exactly as load and inference build
// them, but no weight data is read and no weight or compute buffer is
// allocated.

#include <cstdint>
#include <string>

namespace classification_ggml {

// Thread count the MegaLoc and BridgeDepth configs default to. The CPU
// backend's workspace depends on it.
inline constexpr int DEFAULT_THREADS = 8;

// The ggml buffers behind one model. A loaded model reports the buffers it
// holds after an inference; a measurement reports the same numbers without
// allocating them.
struct BufferFootprint {
  // Weight buffer. Always on the selected device, which may be the CPU.
  uint64_t weightBytes = 0;
  // Compute buffer on the selected device.
  uint64_t deviceComputeBytes = 0;
  // Compute buffer of the CPU backend the scheduler falls back to. 0 when the
  // selected device is the CPU: its buffer is deviceComputeBytes.
  uint64_t cpuComputeBytes = 0;
  // Workspace the CPU backend allocates for its ops, the largest over the
  // graph splits it runs. Only the CPU backend has one.
  uint64_t cpuWorkBytes = 0;

  bool operator==(const BufferFootprint&) const = default;
};

// A measurement: the buffers plus the host memory the addon code allocates
// itself around them.
struct MeasuredBuffers {
  BufferFootprint buffers;
  // See ModelFootprint::hostStagingBytes.
  uint64_t hostStagingBytes = 0;
  // ggml name of the device the weights are on, and whether it is the CPU.
  std::string deviceName;
  bool deviceIsCpu = true;
};

enum class ModelKind { MobileNet, MegaLoc, BridgeDepth };

// Every byte is in exactly one field. When the selected device is the CPU
// (deviceIsCpu) the device fields are 0 and the weight and compute buffers are
// in the host fields.
struct ModelFootprint {
  ModelKind kind = ModelKind::MobileNet;
  // Weight buffer on the selected device.
  uint64_t deviceWeightBytes = 0;
  // Scheduler compute buffer on the selected device.
  uint64_t deviceComputeBytes = 0;
  // Weight buffer when the selected device is the CPU.
  uint64_t hostWeightBytes = 0;
  // CPU backend compute buffer: the whole graph on a CPU load, the splits that
  // fall back to the CPU otherwise.
  uint64_t hostComputeBytes = 0;
  // CPU backend op workspace, see BufferFootprint::cpuWorkBytes.
  uint64_t hostWorkBytes = 0;
  // Largest host memory the addon allocates itself at one time, the larger of
  // the load and the inference phase plus what stays allocated between them.
  // It does not count the caller's encoded or decoded input image, ggml's
  // tensor and graph metadata, or allocations inside a backend.
  //   MobileNet: the GGUF data section (the loader reads it whole), or the
  //     [224, 224, 3] float input.
  //   MegaLoc: the 8 MiB read chunk, or the patch input plus the descriptor.
  //   BridgeDepth: the host copies of pos_embed and the relative position
  //     indices, plus the larger of the read buffer (the largest tensor) and
  //     one inference: both views as planar floats, every graph input built on
  //     the host (padded images, masks, expanded indices, resized pos_embed),
  //     the padded output and the returned disparity, all at the size the
  //     model runs at, plus the disparity resized back to an input above
  //     1280x720.
  uint64_t hostStagingBytes = 0;
  // ggml device name that a load with the same arguments selects.
  std::string deviceName;
  bool deviceIsCpu = true;
};

// Reads only GGUF metadata. The model kind comes from the file:
// general.architecture "megaloc" or "bridgedepth", otherwise the MobileNet
// tensor layout; anything else throws InvalidArgument.
//
// `backend` and `backendsDir` follow GgmlBackends. MobileNet always loads on
// the CPU, so `backend` is ignored for it. `width` and `height` are the
// BridgeDepth input size, checked against the limits inference enforces, and
// are ignored for the other models. An input above 1280x720 is sized at the
// downsampled size inference runs it at. `threads` is the CPU thread count the
// model will be configured with; MobileNet does not take one.
ModelFootprint measureFootprint(
    const std::string& path, const std::string& backend,
    const std::string& backendsDir, int width, int height,
    int threads = DEFAULT_THREADS);

} // namespace classification_ggml
