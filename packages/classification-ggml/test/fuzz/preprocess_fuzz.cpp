#include <cstddef>
#include <cstdint>
#include <span>
#include <tuple>
#include <vector>

#include <fuzztest/fuzztest.h>
#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>

#include "model-interface/ImagePreprocessor.hpp"

// Seeds are encoded here rather than checked in as byte blobs: the bytes come
// out of the same stb the addon decodes with, so they cannot drift out of sync
// with it, and no hand-computed PNG CRC ends up in the tree.
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include <stb_image_write.h>

namespace {

using classification_ggml::preprocess::CHANNELS;
using classification_ggml::preprocess::INPUT_SIZE;
using classification_ggml::preprocess::MAX_IMAGE_DIMENSION;
using classification_ggml::preprocess::preprocessToTensor;
using qvac_errors::StatusError;

constexpr uint32_t SEED_SIDE = 16;

// A gradient rather than a flat fill: JPEG is lossy and a flat block encodes to
// a degenerate DCT, so varying pixels keep the seed representative of a real
// photo's entropy.
std::vector<uint8_t> rawRgbSeed() {
  std::vector<uint8_t> rgb(
      static_cast<size_t>(SEED_SIDE) * SEED_SIDE * CHANNELS);
  for (uint32_t y = 0; y < SEED_SIDE; ++y) {
    for (uint32_t x = 0; x < SEED_SIDE; ++x) {
      const size_t i = (static_cast<size_t>(y) * SEED_SIDE + x) * CHANNELS;
      rgb[i + 0] = static_cast<uint8_t>(x * 16);
      rgb[i + 1] = static_cast<uint8_t>(y * 16);
      rgb[i + 2] = static_cast<uint8_t>((x + y) * 8);
    }
  }
  return rgb;
}

void collectBytes(void* context, void* data, int size) {
  auto* out = static_cast<std::vector<uint8_t>*>(context);
  const auto* bytes = static_cast<const uint8_t*>(data);
  out->insert(out->end(), bytes, bytes + size);
}

std::vector<uint8_t> pngSeed() {
  const std::vector<uint8_t> rgb = rawRgbSeed();
  std::vector<uint8_t> png;
  stbi_write_png_to_func(
      collectBytes,
      &png,
      static_cast<int>(SEED_SIDE),
      static_cast<int>(SEED_SIDE),
      static_cast<int>(CHANNELS),
      rgb.data(),
      static_cast<int>(SEED_SIDE * CHANNELS));
  return png;
}

std::vector<uint8_t> jpegSeed() {
  const std::vector<uint8_t> rgb = rawRgbSeed();
  std::vector<uint8_t> jpeg;
  stbi_write_jpg_to_func(
      collectBytes,
      &jpeg,
      static_cast<int>(SEED_SIDE),
      static_cast<int>(SEED_SIDE),
      static_cast<int>(CHANNELS),
      rgb.data(),
      90);
  return jpeg;
}

// Property: preprocessToTensor() must never crash or trip a sanitizer on
// arbitrary input bytes. Malformed input is rejected with StatusError — the
// expected, non-buggy outcome — so we swallow only that error and let
// unexpected exceptions or memory-safety failures abort the run.
//
// declaredWidth/Height/Channels = 0 selects the encoded branch: magic-byte
// detection, then the stb_image decode path. Reaching past isEncodedImage()
// needs an exact JPEG (FF D8 FF) or 8-byte PNG magic prefix, which random bytes
// hit with probability 2^-24 / 2^-64 — and bounded unit-test mode carries no
// coverage instrumentation to steer toward it. The seeds below are what makes
// the decode path run on every CI job instead of only under `--fuzz_for`.
//
// Before triaging an OOM or std::bad_alloc reproducer: a header-legal
// 16384x16384 image is permitted and peaks near 1.5 GiB, above libFuzzer's
// default RSS limit. Note the seeds are 16x16, so inflating one axis of a
// mutated header allocates only kilobytes — the pathological shape needs both
// axes mutated at once. See "Resource exhaustion reads as a crash" in
// docs/architecture/ADDON-FUZZING.md.
void PreprocessDecodedNeverCrashes(const std::vector<uint8_t>& bytes) {
  try {
    (void)preprocessToTensor(
        std::span<const uint8_t>(bytes.data(), bytes.size()), 0, 0, 0);
  } catch (const StatusError&) {
    // Rejected as invalid — not a defect.
  }
}
// Seeds are supplied through the provider overload so the encoders run on first
// use rather than during static initialization.
FUZZ_TEST(PreprocessorFuzz, PreprocessDecodedNeverCrashes).WithSeeds([] {
  return std::vector<std::tuple<std::vector<uint8_t>>>{
      std::make_tuple(pngSeed()), std::make_tuple(jpegSeed())};
});

// Same property over the raw-RGB branch, which the encoded harness above cannot
// reach: preprocessToTensor() takes it only when a declared dimension is
// non-zero, so with the dimensions fixed at 0 validateRawRgb(), resizeToInput()
// and normalizeToWhcn() are dead code to that fuzzer. Fuzzing the dimensions
// pins validateRawRgb()'s size == width * height * channels invariant and feeds
// attacker-controlled srcWidth/srcHeight into resizeToInput()'s stride
// arithmetic.
//
// Bounds: width/height reach MAX_IMAGE_DIMENSION + 1 and channels CHANNELS + 1
// so the guards' reject side stays reachable, while validateRawRgb() rejects
// oversized dimensions before anything allocates — the buffer must match
// width * height * channels exactly, so a large declared size cannot make this
// harness allocate more than the fuzzer's own input. That exact-match
// requirement is also why the deep path is rare without coverage feedback: the
// seed pins it on every run, and trace-cmp lets continuous mode learn the size
// comparison. A size-dependent domain (buffer length derived from the
// dimensions) is the upgrade if the raw branch shows up starved in a continuous
// run.
void PreprocessRawNeverCrashes(
    const std::vector<uint8_t>& bytes, uint32_t declaredWidth,
    uint32_t declaredHeight, uint32_t declaredChannels) {
  try {
    (void)preprocessToTensor(
        std::span<const uint8_t>(bytes.data(), bytes.size()),
        declaredWidth,
        declaredHeight,
        declaredChannels);
  } catch (const StatusError&) {
    // Rejected as invalid — not a defect.
  }
}
FUZZ_TEST(PreprocessorFuzz, PreprocessRawNeverCrashes)
    .WithDomains(
        fuzztest::Arbitrary<std::vector<uint8_t>>(),
        fuzztest::InRange<uint32_t>(0, MAX_IMAGE_DIMENSION + 1),
        fuzztest::InRange<uint32_t>(0, MAX_IMAGE_DIMENSION + 1),
        fuzztest::InRange<uint32_t>(0, CHANNELS + 1))
    .WithSeeds([] {
      return std::vector<
          std::tuple<std::vector<uint8_t>, uint32_t, uint32_t, uint32_t>>{
          std::make_tuple(rawRgbSeed(), SEED_SIDE, SEED_SIDE, CHANNELS)};
    });

// A seed only buys coverage if it is what it claims to be. These run in the
// same bounded step as the FUZZ_TESTs above, so a seed that stops decoding
// fails loudly here instead of silently demoting both fuzzers to their reject
// paths — which is exactly the failure mode that is invisible in a green fuzz
// log.
TEST(PreprocessorFuzzSeeds, EncodedSeedsReachTheDecodePath) {
  const std::vector<uint8_t> png = pngSeed();
  ASSERT_FALSE(png.empty());
  std::vector<float> fromPng;
  EXPECT_NO_THROW(fromPng = preprocessToTensor(png, 0, 0, 0));
  EXPECT_EQ(
      fromPng.size(), static_cast<size_t>(INPUT_SIZE) * INPUT_SIZE * CHANNELS);

  const std::vector<uint8_t> jpeg = jpegSeed();
  ASSERT_FALSE(jpeg.empty());
  std::vector<float> fromJpeg;
  EXPECT_NO_THROW(fromJpeg = preprocessToTensor(jpeg, 0, 0, 0));
  EXPECT_EQ(
      fromJpeg.size(), static_cast<size_t>(INPUT_SIZE) * INPUT_SIZE * CHANNELS);
}

TEST(PreprocessorFuzzSeeds, RawSeedReachesTheResizePath) {
  const std::vector<uint8_t> rgb = rawRgbSeed();
  std::vector<float> out;
  EXPECT_NO_THROW(
      out = preprocessToTensor(rgb, SEED_SIDE, SEED_SIDE, CHANNELS));
  EXPECT_EQ(
      out.size(), static_cast<size_t>(INPUT_SIZE) * INPUT_SIZE * CHANNELS);
}

} // namespace
