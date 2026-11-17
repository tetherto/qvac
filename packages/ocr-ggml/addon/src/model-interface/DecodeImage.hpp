#pragma once

#include <cstddef>
#include <limits>

#include <opencv2/core.hpp>

#include "OcrTypes.hpp"

namespace qvac_lib_infer_ocr_ggml {

namespace detail {

// Validate sizes without allocating buffers. maxBytes allows the raw byte-count
// checks to be tested against a 32-bit address space on a 64-bit host.
int checkedEncodedImageLength(size_t byteCount);
size_t checkedRawImageByteCount(
    int width, int height, int bytesPerPixel,
    size_t maxBytes = std::numeric_limits<size_t>::max());

} // namespace detail

// Decode an encoded JPEG/PNG (or wrap a raw bitmap) into an RGB cv::Mat.
// Throws std::runtime_error on invalid dimensions, an oversized buffer, a
// size mismatch, or a decode failure. Extracted from Pipeline so the
// untrusted-input front door can be fuzzed without linking @qvac/fabric.
cv::Mat decodeOrWrapImage(const OcrInput& input);

} // namespace qvac_lib_infer_ocr_ggml
