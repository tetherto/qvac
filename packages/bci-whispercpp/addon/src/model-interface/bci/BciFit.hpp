#pragma once

#include <cstdint>

#include <whisper.h>

namespace qvac_lib_inference_addon_bci {

inline uint64_t saturatingAdd(uint64_t a, uint64_t b) {
  return a > UINT64_MAX - b ? UINT64_MAX : a + b;
}

/// Whisper's projection of a BCI load, and the embedder the load reads beside
/// it.
struct BciFit {
  whisper_fit_result whisper{};
  uint64_t marginBytes = 0;
  bool embedderReadable = true;
  uint64_t embedderBytes = 0;

  /// Whisper's host-side buffers and the embedder, which the host holds.
  [[nodiscard]] uint64_t hostBytes() const {
    return saturatingAdd(whisper.host_bytes, embedderBytes);
  }

  /// On a device that shares host memory, the embedder competes with the model
  /// for the same free memory, so whisper's verdict is checked again with it.
  [[nodiscard]] bool embedderFitsBesideModel() const {
    if (!whisper.device_shares_host_memory) {
      return true;
    }
    const uint64_t required = saturatingAdd(
        saturatingAdd(whisper.device.total_bytes, marginBytes), hostBytes());
    return required <= whisper.device_free_bytes;
  }

  [[nodiscard]] bool fits() const {
    return whisper.status == WHISPER_FIT_SUCCESS && embedderFitsBesideModel();
  }
};

} // namespace qvac_lib_inference_addon_bci
