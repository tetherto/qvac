#pragma once

#include <cstdlib>
#include <stdexcept>

#include <stable-diffusion.h>

namespace qvac_lib_inference_addon_sd {

/**
 * RAII wrapper for the `sd_image_t*` frame array returned by
 * `generate_video()`.
 *
 * Unlike `SdImageBatch` (used for the image path), the frame count is
 * resolved at runtime from the `num_frames_out` out-parameter -- the caller
 * may request N frames and receive fewer when decoding fails mid-run. The
 * wrapper therefore carries an explicit `count_` and frees exactly that many
 * frames on destruction.
 *
 * Ownership contract (mirrors upstream stable-diffusion.cpp):
 *   - `data` must have been allocated with `malloc()` via the library.
 *   - Each `data[i].data` is a `malloc()`-allocated pixel buffer.
 *   - This class calls `free()` on every frame's pixel buffer and on the
 *     array itself, in that order, on destruction.
 *   - Null `data` and/or zero `count` are both valid no-op states (empty()).
 *
 * Copy and move are disabled on purpose: the array is exclusively owned and
 * the whole class is intended to live on a single stack frame for the
 * lifetime of a single video job.
 *
 * Thread-safety: none. Callers must not share a single `SdVideoFrames`
 * instance across threads; per-job exclusivity is already enforced one
 * level up by the run queue.
 */
class SdVideoFrames {
public:
  SdVideoFrames() : data_(nullptr), count_(0) {}

  /**
   * @param data  Pointer returned by `generate_video()` (may be null).
   * @param count Value of `num_frames_out` after the call (may be 0).
   *
   * Constructing with a null `data` and non-zero `count` is legal (the
   * destructor will short-circuit on null); it avoids exposing an extra
   * error state to callers that already checked `data != nullptr`.
   */
  SdVideoFrames(sd_image_t *data, int count) : data_(data), count_(count) {}

  ~SdVideoFrames() {
    if (!data_)
      return;
    for (int i = 0; i < count_; ++i) {
      free(data_[i].data);
    }
    free(data_);
  }

  SdVideoFrames(const SdVideoFrames &) = delete;
  SdVideoFrames &operator=(const SdVideoFrames &) = delete;
  SdVideoFrames(SdVideoFrames &&) = delete;
  SdVideoFrames &operator=(SdVideoFrames &&) = delete;

  [[nodiscard]] int count() const noexcept { return count_; }
  [[nodiscard]] bool empty() const noexcept { return !data_ || count_ == 0; }
  [[nodiscard]] const sd_image_t *data() const noexcept { return data_; }

  [[nodiscard]] const sd_image_t &operator[](int i) const {
    if (!data_)
      throw std::runtime_error("SdVideoFrames: null data");
    if (i < 0 || i >= count_)
      throw std::out_of_range("SdVideoFrames: index out of range");
    return data_[i];
  }

private:
  sd_image_t *const data_;
  const int count_;
};

} // namespace qvac_lib_inference_addon_sd
