#include "ModelFootprint.hpp"

#include <memory>

#include <gguf.h>
#include <inference-addon-cpp/Errors.hpp>

#include "bridgedepth/BridgeDepthModel.hpp"
#include "megaloc/MegaLocModel.hpp"
#include "mobilenet/ClassificationModel.hpp"

namespace classification_ggml {
namespace {

using qvac_errors::StatusError;
using qvac_errors::general_error::InvalidArgument;

ModelKind detectKind(const std::string& path) {
  // No ggml context is requested, so only the header and the key-value and
  // tensor tables are read.
  const std::unique_ptr<gguf_context, decltype(&gguf_free)> gguf(
      gguf_init_from_file(path.c_str(), {/*no_alloc=*/true, /*ctx=*/nullptr}),
      gguf_free);
  if (!gguf)
    throw StatusError(InvalidArgument, "cannot read GGUF metadata: " + path);
  const int64_t key = gguf_find_key(gguf.get(), "general.architecture");
  const std::string architecture =
      key >= 0 && gguf_get_kv_type(gguf.get(), key) == GGUF_TYPE_STRING
          ? gguf_get_val_str(gguf.get(), key)
          : "";
  if (architecture == "megaloc")
    return ModelKind::MegaLoc;
  if (architecture == "bridgedepth")
    return ModelKind::BridgeDepth;
  // The MobileNet loader never reads general.architecture; it takes any file
  // that has its tensors, so the first and the last one identify it.
  if (gguf_find_tensor(gguf.get(), "features.0.0.weight") >= 0 &&
      gguf_find_tensor(gguf.get(), "classifier.3.weight") >= 0)
    return ModelKind::MobileNet;
  throw StatusError(
      InvalidArgument,
      "not a MobileNet, MegaLoc or BridgeDepth GGUF: " + path +
          (architecture.empty()
               ? std::string()
               : " (general.architecture " + architecture + ")"));
}

} // namespace

ModelFootprint measureFootprint(
    const std::string& path, const std::string& backend,
    const std::string& backendsDir, int width, int height, int threads) {
  ModelFootprint result;
  result.kind = detectKind(path);
  MeasuredBuffers measured;
  if (result.kind == ModelKind::MobileNet) {
    measured = ClassificationModel::measure(path, backendsDir);
  } else if (result.kind == ModelKind::MegaLoc) {
    measured =
        megaloc::MegaLocModel::measure({path, backendsDir, backend, threads});
  } else {
    if (width <= 0 || height <= 0)
      throw StatusError(
          InvalidArgument, "BridgeDepth: width and height are required");
    measured = bridgedepth::BridgeDepthModel::measure(
        {path, backendsDir, backend, threads},
        static_cast<uint32_t>(width),
        static_cast<uint32_t>(height));
  }
  result.deviceName = measured.deviceName;
  result.deviceIsCpu = measured.deviceIsCpu;
  const BufferFootprint& buffers = measured.buffers;
  if (result.deviceIsCpu) {
    result.hostWeightBytes = buffers.weightBytes;
    result.hostComputeBytes = buffers.deviceComputeBytes;
  } else {
    result.deviceWeightBytes = buffers.weightBytes;
    result.deviceComputeBytes = buffers.deviceComputeBytes;
    result.hostComputeBytes = buffers.cpuComputeBytes;
  }
  result.hostWorkBytes = buffers.cpuWorkBytes;
  result.hostStagingBytes = measured.hostStagingBytes;
  return result;
}

} // namespace classification_ggml
