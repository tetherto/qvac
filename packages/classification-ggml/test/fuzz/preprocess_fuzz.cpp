#include <cstdint>
#include <exception>
#include <span>
#include <vector>

#include <fuzztest/fuzztest.h>
#include <gtest/gtest.h>

#include "model-interface/ImagePreprocessor.hpp"

namespace {

using classification_ggml::preprocess::preprocessToTensor;

// Property: preprocessToTensor() must never crash or trip a sanitizer on
// arbitrary input bytes. Malformed input is rejected with a StatusError (a
// std::exception) — the expected, non-buggy outcome — so we swallow
// std::exception and let only memory-safety failures (ASan/UBSan) abort the
// run. Passing declaredWidth/Height/Channels = 0 routes through magic-byte
// detection + the stb_image decode path, i.e. the real untrusted-input surface.
void PreprocessDecodedNeverCrashes(const std::vector<uint8_t>& bytes) {
  try {
    (void)preprocessToTensor(
        std::span<const uint8_t>(bytes.data(), bytes.size()), 0, 0, 0);
  } catch (const std::exception&) {
    // Rejected as invalid — not a defect.
  }
}
FUZZ_TEST(PreprocessorFuzz, PreprocessDecodedNeverCrashes);

} // namespace
