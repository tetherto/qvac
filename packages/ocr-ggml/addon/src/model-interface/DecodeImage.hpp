#pragma once

#include <opencv2/core.hpp>

#include "OcrTypes.hpp"

namespace qvac_lib_infer_ocr_ggml {

// Decode an encoded JPEG/PNG (or wrap a raw bitmap) into an RGB cv::Mat.
// Throws std::runtime_error on invalid dimensions, an oversized buffer, a
// size mismatch, or a decode failure. Extracted from Pipeline so the
// untrusted-input front door can be fuzzed without linking @qvac/fabric.
cv::Mat decodeOrWrapImage(const OcrInput& input);

} // namespace qvac_lib_infer_ocr_ggml
