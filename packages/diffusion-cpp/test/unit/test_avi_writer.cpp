/**
 * Unit tests for AviWriter (MJPG AVI in-memory encoder).
 *
 * Coverage:
 *   1. Happy path   -- encode N solid-color frames, verify RIFF/AVI magic,
 *                      hdrl / strl / movi layout, idx1 table size.
 *   2. Frame count validation (zero, negative).
 *   3. FPS validation (zero, negative).
 *   4. JPEG quality validation (out of range).
 *   5. Channel count validation (unsupported values).
 *   6. Frame dimension mismatch validation.
 *   7. Null data / null pointer validation.
 *   8. Round-trip: first embedded JPEG in the movi list decodes with stbi.
 */

#include <cstdint>
#include <cstring>
#include <vector>

#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>
#include <stable-diffusion.h>

// stb_image implementation is already compiled into SdModel.cpp (which is
// linked into addon-test); we only need the declarations here.
#include <stb_image.h>

#include "utils/AviWriter.hpp"

using namespace qvac_lib_inference_addon_sd;
using namespace qvac_errors;

namespace {

// Build a synthetic sd_image_t array of solid-color RGB frames.
// Pixel data lives in a shared byte buffer owned by the caller -- each frame
// shares the same color for simplicity.
struct SyntheticFrames {
  std::vector<sd_image_t> frames;
  std::vector<std::vector<uint8_t>> buffers;
};

static SyntheticFrames makeFrames(int count, uint32_t w, uint32_t h,
                                  uint32_t channels, uint8_t color) {
  SyntheticFrames out;
  out.frames.reserve(count);
  out.buffers.reserve(count);
  for (int i = 0; i < count; ++i) {
    out.buffers.emplace_back(w * h * channels, color);
    sd_image_t img{};
    img.width = w;
    img.height = h;
    img.channel = channels;
    img.data = out.buffers.back().data();
    out.frames.push_back(img);
  }
  return out;
}

// Search for a 4-byte ASCII marker in a byte buffer. Returns the index of the
// first byte of the match, or -1 if not found.
static std::ptrdiff_t findFourCC(const std::vector<uint8_t> &buf,
                                 const char tag[4], size_t start = 0) {
  if (buf.size() < 4)
    return -1;
  for (size_t i = start; i + 4 <= buf.size(); ++i) {
    if (buf[i] == static_cast<uint8_t>(tag[0]) &&
        buf[i + 1] == static_cast<uint8_t>(tag[1]) &&
        buf[i + 2] == static_cast<uint8_t>(tag[2]) &&
        buf[i + 3] == static_cast<uint8_t>(tag[3])) {
      return static_cast<std::ptrdiff_t>(i);
    }
  }
  return -1;
}

static uint32_t readU32LE(const std::vector<uint8_t> &buf, size_t offset) {
  return static_cast<uint32_t>(buf[offset]) |
         (static_cast<uint32_t>(buf[offset + 1]) << 8) |
         (static_cast<uint32_t>(buf[offset + 2]) << 16) |
         (static_cast<uint32_t>(buf[offset + 3]) << 24);
}

} // namespace

// -----------------------------------------------------------------------------
// 1. Happy path
// -----------------------------------------------------------------------------

TEST(AviWriter, EncodesFiveRgbFramesWithValidRiffHeader) {
  auto fixture = makeFrames(
      /*count=*/5,
      /*w=*/32,
      /*h=*/32,
      /*channels=*/3,
      /*color=*/128);

  auto avi = encodeFramesToAvi(fixture.frames.data(), 5, /*fps=*/24);

  ASSERT_GT(avi.size(), 256u);

  // RIFF magic + AVI 4CC at offsets 0 and 8
  EXPECT_EQ(std::memcmp(avi.data(), "RIFF", 4), 0);
  EXPECT_EQ(std::memcmp(avi.data() + 8, "AVI ", 4), 0);

  // RIFF size == total file size - 8
  const uint32_t riffSize = readU32LE(avi, 4);
  EXPECT_EQ(riffSize, avi.size() - 8);

  // hdrl LIST at offset 12
  EXPECT_EQ(std::memcmp(avi.data() + 12, "LIST", 4), 0);
  EXPECT_EQ(std::memcmp(avi.data() + 20, "hdrl", 4), 0);

  // avih chunk immediately after hdrl
  EXPECT_EQ(std::memcmp(avi.data() + 24, "avih", 4), 0);

  // strl and strh somewhere inside hdrl list
  EXPECT_GE(findFourCC(avi, "strl"), 0);
  EXPECT_GE(findFourCC(avi, "strh"), 0);
  EXPECT_GE(findFourCC(avi, "strf"), 0);
  // MJPG codec FourCC appears in strh and strf
  EXPECT_GE(findFourCC(avi, "MJPG"), 0);

  // movi LIST exists
  EXPECT_GE(findFourCC(avi, "movi"), 0);

  // idx1 index exists
  const auto idxOff = findFourCC(avi, "idx1");
  ASSERT_GE(idxOff, 0);
  // idx1 size == numFrames * 16
  EXPECT_EQ(readU32LE(avi, idxOff + 4), 5u * 16);

  // 5 "00dc" chunks in total (frames) -- appears in movi and idx1 table ==
  // 5 in movi + 5 in idx1 = 10
  int count = 0;
  std::ptrdiff_t pos = 0;
  while ((pos = findFourCC(avi, "00dc", static_cast<size_t>(pos))) >= 0) {
    ++count;
    pos += 4;
  }
  EXPECT_EQ(count, 10);
}

TEST(AviWriter, FirstEmbeddedJpegDecodesToExpectedDimensions) {
  auto fixture = makeFrames(2, 64, 48, 3, 200);
  auto avi = encodeFramesToAvi(fixture.frames.data(), 2, 30);

  // Find first "00dc" chunk after "movi"
  const auto moviOff = findFourCC(avi, "movi");
  ASSERT_GE(moviOff, 0);
  const auto frameOff = findFourCC(avi, "00dc", static_cast<size_t>(moviOff));
  ASSERT_GE(frameOff, 0);

  // 4 bytes FourCC + 4 bytes size, then JPEG payload
  const uint32_t jpegSize = readU32LE(avi, frameOff + 4);
  ASSERT_GT(jpegSize, 0u);
  ASSERT_LE(static_cast<size_t>(frameOff) + 8 + jpegSize, avi.size());

  int w = 0, h = 0, c = 0;
  uint8_t *decoded = stbi_load_from_memory(
      avi.data() + frameOff + 8, static_cast<int>(jpegSize), &w, &h, &c, 0);
  ASSERT_NE(decoded, nullptr);
  EXPECT_EQ(w, 64);
  EXPECT_EQ(h, 48);
  EXPECT_EQ(c, 3);
  stbi_image_free(decoded);
}

// -----------------------------------------------------------------------------
// 2. Frame count validation
// -----------------------------------------------------------------------------

TEST(AviWriter, RejectsZeroFrames) {
  auto fixture = makeFrames(1, 16, 16, 3, 0);
  EXPECT_THROW(encodeFramesToAvi(fixture.frames.data(), 0, 24), StatusError);
}

TEST(AviWriter, RejectsNegativeFrameCount) {
  auto fixture = makeFrames(1, 16, 16, 3, 0);
  EXPECT_THROW(encodeFramesToAvi(fixture.frames.data(), -5, 24), StatusError);
}

TEST(AviWriter, RejectsNullFrames) {
  EXPECT_THROW(encodeFramesToAvi(nullptr, 5, 24), StatusError);
}

// -----------------------------------------------------------------------------
// 3. FPS validation
// -----------------------------------------------------------------------------

TEST(AviWriter, RejectsZeroFps) {
  auto fixture = makeFrames(2, 16, 16, 3, 0);
  EXPECT_THROW(encodeFramesToAvi(fixture.frames.data(), 2, 0), StatusError);
}

TEST(AviWriter, RejectsNegativeFps) {
  auto fixture = makeFrames(2, 16, 16, 3, 0);
  EXPECT_THROW(encodeFramesToAvi(fixture.frames.data(), 2, -1), StatusError);
}

// -----------------------------------------------------------------------------
// 4. JPEG quality validation
// -----------------------------------------------------------------------------

TEST(AviWriter, RejectsQualityBelow1) {
  auto fixture = makeFrames(2, 16, 16, 3, 0);
  EXPECT_THROW(encodeFramesToAvi(fixture.frames.data(), 2, 24, /*q=*/0),
               StatusError);
}

TEST(AviWriter, RejectsQualityAbove100) {
  auto fixture = makeFrames(2, 16, 16, 3, 0);
  EXPECT_THROW(encodeFramesToAvi(fixture.frames.data(), 2, 24, /*q=*/101),
               StatusError);
}

TEST(AviWriter, AcceptsBoundaryQualities) {
  auto fixture = makeFrames(2, 16, 16, 3, 0);
  EXPECT_NO_THROW(encodeFramesToAvi(fixture.frames.data(), 2, 24, 1));
  EXPECT_NO_THROW(encodeFramesToAvi(fixture.frames.data(), 2, 24, 100));
}

// -----------------------------------------------------------------------------
// 5. Channel count validation
// -----------------------------------------------------------------------------

TEST(AviWriter, RejectsUnsupportedChannelCountGrayscale) {
  auto fixture = makeFrames(1, 16, 16, /*channels=*/1, 0);
  EXPECT_THROW(encodeFramesToAvi(fixture.frames.data(), 1, 24), StatusError);
}

TEST(AviWriter, RejectsUnsupportedChannelCountTwo) {
  auto fixture = makeFrames(1, 16, 16, /*channels=*/2, 0);
  EXPECT_THROW(encodeFramesToAvi(fixture.frames.data(), 1, 24), StatusError);
}

TEST(AviWriter, AcceptsRgbaFrames) {
  auto fixture = makeFrames(3, 16, 16, /*channels=*/4, 0);
  EXPECT_NO_THROW(encodeFramesToAvi(fixture.frames.data(), 3, 24));
}

// -----------------------------------------------------------------------------
// 6. Frame dimension / channel homogeneity
// -----------------------------------------------------------------------------

TEST(AviWriter, RejectsMismatchedFrameDimensions) {
  auto a = makeFrames(1, 32, 32, 3, 128);
  auto b = makeFrames(1, 64, 32, 3, 128);
  // Splice: frame 0 from a, frame 1 from b
  std::vector<sd_image_t> frames{a.frames[0], b.frames[0]};
  EXPECT_THROW(encodeFramesToAvi(frames.data(), 2, 24), StatusError);
}

TEST(AviWriter, RejectsMismatchedFrameChannels) {
  auto a = makeFrames(1, 32, 32, 3, 128);
  auto b = makeFrames(1, 32, 32, 4, 128);
  std::vector<sd_image_t> frames{a.frames[0], b.frames[0]};
  EXPECT_THROW(encodeFramesToAvi(frames.data(), 2, 24), StatusError);
}

TEST(AviWriter, RejectsZeroDimensionFrame) {
  auto fixture = makeFrames(1, 32, 32, 3, 128);
  fixture.frames[0].width = 0;
  EXPECT_THROW(encodeFramesToAvi(fixture.frames.data(), 1, 24), StatusError);
}

TEST(AviWriter, RejectsNullFrameDataAtNonZeroIndex) {
  auto fixture = makeFrames(3, 16, 16, 3, 128);
  fixture.frames[2].data = nullptr;
  EXPECT_THROW(encodeFramesToAvi(fixture.frames.data(), 3, 24), StatusError);
}

// -----------------------------------------------------------------------------
// 6b. Overflow / 4 GB RIFF-cap guards -- the buffer-size estimate used to be
//     a raw multiply that could silently wrap on 32-bit targets and would
//     also exceed the AVI 1.0 uint32_t file-size header on 64-bit hosts.
//     Both paths must throw *before* we try to allocate or write anything.
// -----------------------------------------------------------------------------

TEST(AviWriter, RejectsDimensionsThatWouldOverflowFrameSize) {
  // 32-bit overflow protection: 1 GB^2 * 3 bytes/pixel saturates size_t on
  // 32-bit and approaches it on 64-bit. We don't allocate this -- the
  // pre-flight check fires before any encoding starts.
  auto fixture = makeFrames(1, 16, 16, 3, 128);
  fixture.frames[0].width = 1'000'000u;
  fixture.frames[0].height = 1'000'000u;
  EXPECT_THROW(encodeFramesToAvi(fixture.frames.data(), 1, 24), StatusError);
}

TEST(AviWriter, RejectsFrameCountTimesSizeExceedingRiffCap) {
  // 4096 * 4096 * 3 == 48 MB per uncompressed frame. 200 frames -> ~9.4 GB
  // which is well past the 4 GB RIFF cap. The pre-flight estimate guard
  // fires here, before we hit the (post-encode) final-size guard.
  auto fixture = makeFrames(1, 16, 16, 3, 128);
  fixture.frames[0].width = 4096u;
  fixture.frames[0].height = 4096u;
  EXPECT_THROW(encodeFramesToAvi(fixture.frames.data(), 200, 24), StatusError);
}

// -----------------------------------------------------------------------------
// 7. File-size monotonicity -- more frames produce strictly larger output
// -----------------------------------------------------------------------------

TEST(AviWriter, OutputSizeGrowsWithFrameCount) {
  auto small = makeFrames(1, 32, 32, 3, 64);
  auto large = makeFrames(5, 32, 32, 3, 64);
  auto aviSmall = encodeFramesToAvi(small.frames.data(), 1, 24);
  auto aviLarge = encodeFramesToAvi(large.frames.data(), 5, 24);
  EXPECT_GT(aviLarge.size(), aviSmall.size());
}
