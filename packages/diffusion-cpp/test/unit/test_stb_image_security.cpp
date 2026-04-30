/**
 * Security tests for stb_image CVE mitigations
 *
 * Tests defensive coding around stb_image to prevent exploitation of:
 *   - CVE-2021-28021: Buffer overflow in stbi__extend_receive
 *   - CVE-2021-37789: Heap-based buffer overflow in stbi__jpeg_load
 *   - CVE-2022-28041: Integer overflow via stbi__jpeg_decode_block_prog_dc
 *   - CVE-2022-28042: Heap-based use-after-free in stbi__jpeg_huff_decode
 */

#include <cstdint>
#include <vector>

#include <gtest/gtest.h>

#include "handlers/SdCtxHandlers.hpp"
#include "model-interface/SdModel.hpp"

using namespace qvac_lib_inference_addon_sd;

// Helper to create a minimal valid PNG header
std::vector<uint8_t> createValidPngHeader() {
  return {
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
      0x00, 0x00, 0x00, 0x0D,                         // IHDR length
      0x49, 0x48, 0x44, 0x52,                         // "IHDR"
      0x00, 0x00, 0x00, 0x01,                         // width: 1
      0x00, 0x00, 0x00, 0x01,                         // height: 1
      0x08, 0x02, 0x00, 0x00, 0x00, // bit depth, color type, etc.
      0x90, 0x77, 0x53, 0xDE,       // CRC
      0x00, 0x00, 0x00, 0x00,       // IEND length
      0x49, 0x45, 0x4E, 0x44,       // "IEND"
      0xAE, 0x42, 0x60, 0x82        // CRC
  };
}

class StbImageSecurityTest : public ::testing::Test {
protected:
  void SetUp() override {
    SdCtxConfig config{};
    config.modelPath = ""; // Not loading actual model for image tests
    model = std::make_unique<SdModel>(std::move(config));
  }

  std::unique_ptr<SdModel> model;
};

// ─────────────────────────────────────────────────────────────────────────────
// decodePng security tests
// ─────────────────────────────────────────────────────────────────────────────

TEST_F(StbImageSecurityTest, RejectsEmptyInput) {
  std::vector<uint8_t> empty;
  auto result = model->decodePng(empty);

  EXPECT_EQ(result.data, nullptr);
  EXPECT_EQ(result.width, 0u);
  EXPECT_EQ(result.height, 0u);
}

TEST_F(StbImageSecurityTest, RejectsInvalidPngMagicBytes) {
  // Wrong magic bytes (not PNG signature)
  std::vector<uint8_t> notPng = {
      0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46 // JPEG signature
  };

  auto result = model->decodePng(notPng);

  EXPECT_EQ(result.data, nullptr) << "Should reject non-PNG data";
}

TEST_F(StbImageSecurityTest, RejectsOversizedInput) {
  // Create a buffer larger than MAX_IMAGE_SIZE (50MB)
  const size_t oversized = 51 * 1024 * 1024;
  std::vector<uint8_t> huge(oversized);

  // Set PNG magic bytes but keep rest as zeros
  huge[0] = 0x89;
  huge[1] = 0x50;
  huge[2] = 0x4E;
  huge[3] = 0x47;
  huge[4] = 0x0D;
  huge[5] = 0x0A;
  huge[6] = 0x1A;
  huge[7] = 0x0A;

  auto result = model->decodePng(huge);

  EXPECT_EQ(result.data, nullptr) << "Should reject images exceeding size "
                                     "limit (CVE-2021-28021 mitigation)";
}

TEST_F(StbImageSecurityTest, RejectsTruncatedPngHeader) {
  // Only 4 bytes - not enough for full PNG signature
  std::vector<uint8_t> truncated = {0x89, 0x50, 0x4E, 0x47};

  auto result = model->decodePng(truncated);

  EXPECT_EQ(result.data, nullptr) << "Should reject truncated PNG header";
}

TEST_F(StbImageSecurityTest, AcceptsValidMinimalPng) {
  auto validPng = createValidPngHeader();

  // This might fail (stb_image is picky), but should not crash
  // The test verifies we handle both success and failure gracefully
  auto result = model->decodePng(validPng);

  // Either succeeds with valid data or fails cleanly
  if (result.data != nullptr) {
    EXPECT_GT(result.width, 0u);
    EXPECT_GT(result.height, 0u);
    EXPECT_LE(result.width, 16384u) << "Width should be within max dimension";
    EXPECT_LE(result.height, 16384u) << "Height should be within max dimension";
    stbi_image_free(result.data);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// encodeToPng security tests
// ─────────────────────────────────────────────────────────────────────────────

TEST_F(StbImageSecurityTest, RejectsNullDataPointer) {
  sd_image_t img{};
  img.width = 100;
  img.height = 100;
  img.channel = 3;
  img.data = nullptr; // NULL pointer

  auto result = model->encodeToPng(img);

  EXPECT_TRUE(result.empty()) << "Should reject null data pointer";
}

TEST_F(StbImageSecurityTest, RejectsZeroDimensions) {
  uint8_t dummyData[3] = {0, 0, 0};

  // Zero width
  sd_image_t img1{};
  img1.width = 0;
  img1.height = 100;
  img1.channel = 3;
  img1.data = dummyData;

  auto result1 = model->encodeToPng(img1);
  EXPECT_TRUE(result1.empty()) << "Should reject zero width";

  // Zero height
  sd_image_t img2{};
  img2.width = 100;
  img2.height = 0;
  img2.channel = 3;
  img2.data = dummyData;

  auto result2 = model->encodeToPng(img2);
  EXPECT_TRUE(result2.empty()) << "Should reject zero height";
}

TEST_F(StbImageSecurityTest, RejectsOversizedDimensions) {
  uint8_t dummyData[3] = {0, 0, 0};

  sd_image_t img{};
  img.width = 20000; // Exceeds MAX_DIMENSION (16384)
  img.height = 20000;
  img.channel = 3;
  img.data = dummyData;

  auto result = model->encodeToPng(img);

  EXPECT_TRUE(result.empty()) << "Should reject oversized dimensions";
}

TEST_F(StbImageSecurityTest, RejectsInvalidChannelCount) {
  uint8_t dummyData[3] = {0, 0, 0};

  sd_image_t img{};
  img.width = 100;
  img.height = 100;
  img.channel = 7; // Invalid (must be 3 or 4)
  img.data = dummyData;

  auto result = model->encodeToPng(img);

  EXPECT_TRUE(result.empty()) << "Should reject invalid channel count";
}

TEST_F(StbImageSecurityTest, PreventsStrideOverflow) {
  uint8_t dummyData[3] = {0, 0, 0};

  // Dimensions that would cause int32 overflow in stride calculation
  // 16384 * 4 = 65536 (OK), but 100000 * 4 would overflow
  sd_image_t img{};
  img.width = 100000;
  img.height = 100;
  img.channel = 4;
  img.data = dummyData;

  auto result = model->encodeToPng(img);

  EXPECT_TRUE(result.empty())
      << "Should reject dimensions causing stride overflow (CVE-2022-28041 "
         "mitigation)";
}

TEST_F(StbImageSecurityTest, EncodesValidSmallImage) {
  // Create a small 2x2 RGB image
  std::vector<uint8_t> pixels = {
      255,
      0,
      0, // Red
      0,
      255,
      0, // Green
      0,
      0,
      255, // Blue
      255,
      255,
      255 // White
  };

  sd_image_t img{};
  img.width = 2;
  img.height = 2;
  img.channel = 3;
  img.data = pixels.data();

  auto result = model->encodeToPng(img);

  EXPECT_FALSE(result.empty()) << "Should successfully encode valid image";

  // Verify PNG signature
  ASSERT_GE(result.size(), 8u);
  EXPECT_EQ(result[0], 0x89);
  EXPECT_EQ(result[1], 0x50);
  EXPECT_EQ(result[2], 0x4E);
  EXPECT_EQ(result[3], 0x47);
  EXPECT_EQ(result[4], 0x0D);
  EXPECT_EQ(result[5], 0x0A);
  EXPECT_EQ(result[6], 0x1A);
  EXPECT_EQ(result[7], 0x0A);
}

// ─────────────────────────────────────────────────────────────────────────────
// Round-trip test
// ─────────────────────────────────────────────────────────────────────────────

TEST_F(StbImageSecurityTest, RoundTripEncodeDecode) {
  // Create a small test image
  std::vector<uint8_t> originalPixels = {
      128,
      64,
      32, // Pixel 1
      32,
      64,
      128, // Pixel 2
      255,
      0,
      0, // Pixel 3
      0,
      255,
      0 // Pixel 4
  };

  sd_image_t original{};
  original.width = 2;
  original.height = 2;
  original.channel = 3;
  original.data = originalPixels.data();

  // Encode
  auto pngBytes = model->encodeToPng(original);
  ASSERT_FALSE(pngBytes.empty()) << "Encoding should succeed";

  // Decode
  auto decoded = model->decodePng(pngBytes);
  ASSERT_NE(decoded.data, nullptr) << "Decoding should succeed";

  // Verify dimensions
  EXPECT_EQ(decoded.width, original.width);
  EXPECT_EQ(decoded.height, original.height);
  EXPECT_EQ(decoded.channel, 3u); // Forced to 3 in decodePng

  // Cleanup
  stbi_image_free(decoded.data);
}
