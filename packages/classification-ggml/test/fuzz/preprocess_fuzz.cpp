#include <cstdint>
#include <span>
#include <vector>

#include <fuzztest/fuzztest.h>
#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>

#include "model-interface/ImagePreprocessor.hpp"

namespace {

using classification_ggml::preprocess::preprocessToTensor;
using qvac_errors::StatusError;

// Property: preprocessToTensor() must never crash or trip a sanitizer on
// arbitrary input bytes. Malformed input is rejected with StatusError — the
// expected, non-buggy outcome — so we swallow only that error and let unexpected
// exceptions or memory-safety failures abort the run. Passing
// declaredWidth/Height/Channels = 0 routes through magic-byte detection + the
// stb_image decode path, i.e. the real untrusted-input surface.
void PreprocessDecodedNeverCrashes(const std::vector<uint8_t>& bytes) {
  try {
    (void)preprocessToTensor(
        std::span<const uint8_t>(bytes.data(), bytes.size()), 0, 0, 0);
  } catch (const StatusError&) {
    // Rejected as invalid — not a defect.
  }
}
FUZZ_TEST(PreprocessorFuzz, PreprocessDecodedNeverCrashes);

} // namespace
