// Image decoding limits and format tests.

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <limits>
#include <memory>
#include <string_view>
#include <vector>

#include <gtest/gtest.h>
#include <stb_image_write.h>

#include "utils/EsrganUpscaler.hpp"
#include "utils/ImageCodec.hpp"

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

class StbImageSecurityTest : public ::testing::Test {};

std::vector<uint8_t> decodeBase64(std::string_view encoded) {
  std::vector<uint8_t> bytes;
  uint32_t value = 0;
  int bits = -8;
  for (char c : encoded) {
    if (c == '=') {
      break;
    }
    int digit = c >= 'A' && c <= 'Z'   ? c - 'A'
                : c >= 'a' && c <= 'z' ? c - 'a' + 26
                : c >= '0' && c <= '9' ? c - '0' + 52
                : c == '+'             ? 62
                                       : 63;
    value = (value << 6) | digit;
    bits += 6;
    if (bits >= 0) {
      bytes.push_back(static_cast<uint8_t>((value >> bits) & 0xFF));
      bits -= 8;
    }
  }
  return bytes;
}

// ─────────────────────────────────────────────────────────────────────────────
// decodeImage security tests
// ─────────────────────────────────────────────────────────────────────────────

TEST_F(StbImageSecurityTest, RejectsEmptyInput) {
  std::vector<uint8_t> empty;
  auto result = image_codec::decodeImage(empty);

  EXPECT_EQ(result.data, nullptr);
  EXPECT_EQ(result.width, 0u);
  EXPECT_EQ(result.height, 0u);
}

TEST_F(StbImageSecurityTest, RejectsInvalidImageBytes) {
  // JPEG magic bytes without a valid JPEG body.
  std::vector<uint8_t> badImage = {
      0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46 // JPEG signature
  };

  auto result = image_codec::decodeImage(badImage);

  EXPECT_EQ(result.data, nullptr) << "Should reject invalid image data";
}

TEST_F(StbImageSecurityTest, RejectsLargeCorruptInput) {
  // Large corrupt images should fail cleanly without crashing.
  const size_t corruptSize = 1024 * 1024;
  std::vector<uint8_t> huge(corruptSize);

  // Set PNG magic bytes but keep rest as zeros
  huge[0] = 0x89;
  huge[1] = 0x50;
  huge[2] = 0x4E;
  huge[3] = 0x47;
  huge[4] = 0x0D;
  huge[5] = 0x0A;
  huge[6] = 0x1A;
  huge[7] = 0x0A;

  auto result = image_codec::decodeImage(huge);

  EXPECT_EQ(result.data, nullptr)
      << "Should reject large corrupt images cleanly";
}

TEST_F(StbImageSecurityTest, RejectsTruncatedPngHeader) {
  // Only 4 bytes - not enough for full PNG signature
  std::vector<uint8_t> truncated = {0x89, 0x50, 0x4E, 0x47};

  auto result = image_codec::decodeImage(truncated);

  EXPECT_EQ(result.data, nullptr) << "Should reject truncated PNG header";
}

TEST_F(StbImageSecurityTest, AcceptsValidMinimalPng) {
  auto validPng = createValidPngHeader();

  // This might fail (stb_image is picky), but should not crash
  // The test verifies we handle both success and failure gracefully
  auto result = image_codec::decodeImage(validPng);

  // Either succeeds with valid data or fails cleanly
  if (result.data != nullptr) {
    EXPECT_GT(result.width, 0u);
    EXPECT_GT(result.height, 0u);
    EXPECT_LE(result.width, 16384u) << "Width should be within max dimension";
    EXPECT_LE(result.height, 16384u) << "Height should be within max dimension";
    free(result.data);
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

  auto result = image_codec::encodeToPng(img);

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

  auto result1 = image_codec::encodeToPng(img1);
  EXPECT_TRUE(result1.empty()) << "Should reject zero width";

  // Zero height
  sd_image_t img2{};
  img2.width = 100;
  img2.height = 0;
  img2.channel = 3;
  img2.data = dummyData;

  auto result2 = image_codec::encodeToPng(img2);
  EXPECT_TRUE(result2.empty()) << "Should reject zero height";
}

TEST_F(StbImageSecurityTest, RejectsDimensionsAboveNativeIntRange) {
  uint8_t dummyData[3] = {0, 0, 0};

  sd_image_t img{};
  img.width = static_cast<uint32_t>(std::numeric_limits<int>::max()) + 1u;
  img.height = 1;
  img.channel = 3;
  img.data = dummyData;

  auto result = image_codec::encodeToPng(img);

  EXPECT_TRUE(result.empty()) << "Should reject dimensions above native int";
}

TEST_F(StbImageSecurityTest, RejectsInvalidChannelCount) {
  uint8_t dummyData[3] = {0, 0, 0};

  sd_image_t img{};
  img.width = 100;
  img.height = 100;
  img.channel = 7; // Invalid (must be 3 or 4)
  img.data = dummyData;

  auto result = image_codec::encodeToPng(img);

  EXPECT_TRUE(result.empty()) << "Should reject invalid channel count";
}

TEST_F(StbImageSecurityTest, PreventsStrideOverflow) {
  uint8_t dummyData[3] = {0, 0, 0};

  // Dimensions that would cause int32 overflow in stride calculation.
  sd_image_t img{};
  img.width = static_cast<uint32_t>(std::numeric_limits<int>::max() / 4) + 1u;
  img.height = 1;
  img.channel = 4;
  img.data = dummyData;

  auto result = image_codec::encodeToPng(img);

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

  auto result = image_codec::encodeToPng(img);

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
  auto pngBytes = image_codec::encodeToPng(original);
  ASSERT_FALSE(pngBytes.empty()) << "Encoding should succeed";

  // Decode
  auto decoded = image_codec::decodeImage(pngBytes);
  ASSERT_NE(decoded.data, nullptr) << "Decoding should succeed";

  // Verify dimensions
  EXPECT_EQ(decoded.width, original.width);
  EXPECT_EQ(decoded.height, original.height);
  EXPECT_EQ(decoded.channel, 3u); // Forced to 3 in decodeImage

  // Cleanup
  free(decoded.data);
}

TEST_F(StbImageSecurityTest, AcceptsJpeg) {
  std::vector<uint8_t> pixels(2 * 2 * 3, 128);
  sd_image_t image{2, 2, 3, pixels.data()};
  auto jpeg = image_codec::encodeToJpeg(image, 90);
  ASSERT_FALSE(jpeg.empty());

  auto decoded = image_codec::decodeImage(jpeg);
  std::unique_ptr<uint8_t, image_codec::FreeDeleter> owned(decoded.data);
  ASSERT_NE(decoded.data, nullptr);
  EXPECT_EQ(decoded.width, 2u);
  EXPECT_EQ(decoded.height, 2u);
}

TEST_F(StbImageSecurityTest, AcceptsProgressiveJpegWithinScanLimit) {
  const auto jpeg = decodeBase64(
      "/9j/4AAQSkZJRgABAQAAAQABAAD/"
      "2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAx"
      "NDQ0Hyc5PTgyPC4zNDL/"
      "2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy"
      "MjIyMjIyMjIyMjIyMjL/wgARCAACAAIDASIAAhEBAxEB/"
      "8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUAQEAAAAAAAAAAAAAAAAAAAAC/"
      "9oADAMBAAIQAxAAAAGIDH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/"
      "9oACAEBAAEFAn//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AX//"
      "xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AX//"
      "xAAUEAEAAAAAAAAAAAAAAAAAAAAA/"
      "9oACAEBAAY/An//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IX//"
      "2gAMAwEAAgADAAAAEAf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/"
      "9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//"
      "xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==");
  image_codec::DecodeFailure failure;
  auto decoded =
      image_codec::decodeImage(jpeg, image_codec::MAX_DECODED_PIXELS, &failure);
  std::unique_ptr<uint8_t, image_codec::FreeDeleter> owned(decoded.data);
  ASSERT_NE(decoded.data, nullptr)
      << image_codec::decodeFailureMessage(failure);
  EXPECT_EQ(failure, image_codec::DecodeFailure::None);
  EXPECT_EQ(decoded.width, 2u);
  EXPECT_EQ(decoded.height, 2u);
}

TEST_F(StbImageSecurityTest, AcceptsSmall16BitPng) {
  const auto png = decodeBase64(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACEAAAAAAHTY67AAAAEklEQVR4nGNkYWBgYGJgYGAA"
      "AABCAAg70OdSAAAAAElFTkSuQmCC");
  auto decoded = image_codec::decodeImage(png);
  std::unique_ptr<uint8_t, image_codec::FreeDeleter> owned(decoded.data);
  ASSERT_NE(decoded.data, nullptr);
  EXPECT_EQ(decoded.width, 2u);
  EXPECT_EQ(decoded.height, 2u);
}

TEST_F(StbImageSecurityTest, RejectsUnsupportedFormats) {
  const std::vector<std::vector<uint8_t>> unsupported = {
      {'G', 'I', 'F', '8', '9', 'a'},
      {'B', 'M', 0, 0},
      {'P', '6', '\n', '1', ' ', '1', '\n'},
      {'#', '?', 'R', 'A', 'D', 'I', 'A', 'N', 'C', 'E'},
      {'8', 'B', 'P', 'S'},
      {0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 24, 0},
      {'P', 'I', 'C', 'T'}};
  for (const auto& bytes : unsupported) {
    auto decoded = image_codec::decodeImage(bytes);
    EXPECT_EQ(decoded.data, nullptr);
  }
}

TEST_F(StbImageSecurityTest, RejectsValidBmp) {
  std::vector<uint8_t> bmp;
  const uint8_t pixel[3] = {255, 0, 0};
  const auto appendBytes = [](void* context, void* data, int size) {
    auto& bytes = *static_cast<std::vector<uint8_t>*>(context);
    const auto* first = static_cast<const uint8_t*>(data);
    bytes.insert(bytes.end(), first, first + size);
  };
  ASSERT_NE(stbi_write_bmp_to_func(appendBytes, &bmp, 1, 1, 3, pixel), 0);
  ASSERT_FALSE(bmp.empty());
  EXPECT_EQ(image_codec::decodeImage(bmp).data, nullptr);
}

TEST_F(StbImageSecurityTest, RejectsCompressedInputAboveLimit) {
  std::vector<uint8_t> bytes(50ULL * 1024 * 1024 + 1, 0);
  const auto png = createValidPngHeader();
  std::copy(png.begin(), png.end(), bytes.begin());
  EXPECT_EQ(image_codec::decodeImage(bytes).data, nullptr);
}

TEST_F(StbImageSecurityTest, RejectsValidPngAbovePixelLimit) {
  constexpr int side = 8193;
  std::vector<uint8_t> png;
  {
    std::vector<uint8_t> pixels(static_cast<size_t>(side) * side * 3, 0);
    sd_image_t image{
        static_cast<uint32_t>(side),
        static_cast<uint32_t>(side),
        3,
        pixels.data()};
    png = image_codec::encodeToPng(image);
  }
  ASSERT_FALSE(png.empty());
  EXPECT_EQ(image_codec::decodeImage(png).data, nullptr);
}

TEST_F(StbImageSecurityTest, EnforcesRemainingJobPixelBudget) {
  std::vector<uint8_t> pixels(2 * 2 * 3, 128);
  sd_image_t image{2, 2, 3, pixels.data()};
  auto png = image_codec::encodeToPng(image);
  ASSERT_FALSE(png.empty());

  EXPECT_EQ(image_codec::decodeImage(png, 3).data, nullptr);
  EXPECT_EQ(image_codec::decodeImage(png, 0).data, nullptr);
  auto decoded = image_codec::decodeImage(png, 4);
  std::unique_ptr<uint8_t, image_codec::FreeDeleter> owned(decoded.data);
  EXPECT_NE(decoded.data, nullptr);
}

TEST_F(StbImageSecurityTest, UsesConfiguredImagePixelLimit) {
  std::vector<uint8_t> pixels(2 * 2 * 3, 0);
  sd_image_t image{2, 2, 3, pixels.data()};
  auto png = image_codec::encodeToPng(image);
  ASSERT_FALSE(png.empty());

  image_codec::DecodeFailure failure;
  auto rejected = image_codec::decodeImage(png, 4, &failure, 3);
  EXPECT_EQ(rejected.data, nullptr);
  EXPECT_EQ(failure, image_codec::DecodeFailure::PixelLimit);

  auto accepted = image_codec::decodeImage(png, 4, &failure, 4);
  std::unique_ptr<uint8_t, image_codec::FreeDeleter> owned(accepted.data);
  EXPECT_NE(accepted.data, nullptr);
  EXPECT_EQ(failure, image_codec::DecodeFailure::None);
}

TEST_F(StbImageSecurityTest, RaisedLimitPassesHeaderBudgetCheck) {
  auto png = createValidPngHeader();
  png[18] = 0x20;
  png[19] = 0;
  png[22] = 0x20;
  png[23] = 1;
  image_codec::DecodeFailure failure;
  auto rejected = image_codec::decodeImage(png, 128ULL * 1024 * 1024, &failure);
  EXPECT_EQ(rejected.data, nullptr);
  EXPECT_EQ(failure, image_codec::DecodeFailure::PixelLimit);

  auto inspected = image_codec::decodeImage(
      png, 128ULL * 1024 * 1024, &failure, 128ULL * 1024 * 1024);
  EXPECT_EQ(inspected.data, nullptr);
  EXPECT_NE(failure, image_codec::DecodeFailure::PixelLimit);
}

TEST_F(StbImageSecurityTest, EnforcesDimensionBoundary) {
  for (const int width : {16384, 16385}) {
    std::vector<uint8_t> pixels(static_cast<size_t>(width) * 3, 0);
    sd_image_t image{static_cast<uint32_t>(width), 1, 3, pixels.data()};
    auto png = image_codec::encodeToPng(image);
    ASSERT_FALSE(png.empty());
    auto decoded = image_codec::decodeImage(png);
    std::unique_ptr<uint8_t, image_codec::FreeDeleter> owned(decoded.data);
    EXPECT_EQ(decoded.data != nullptr, width == 16384);
  }
}

TEST_F(StbImageSecurityTest, RejectsPngInflateBeyondHeader) {
  std::vector<uint8_t> pixels(1024 * 1024 * 3, 0);
  sd_image_t image{1024, 1024, 3, pixels.data()};
  auto png = image_codec::encodeToPng(image);
  ASSERT_FALSE(png.empty());
  png[18] = 0;
  png[19] = 1;
  png[22] = 0;
  png[23] = 1;

  image_codec::DecodeFailure failure;
  auto decoded =
      image_codec::decodeImage(png, image_codec::MAX_DECODED_PIXELS, &failure);
  EXPECT_EQ(decoded.data, nullptr);
  EXPECT_EQ(failure, image_codec::DecodeFailure::PngInflateLimit);
}

TEST_F(StbImageSecurityTest, RejectsHighMemoryPngSource) {
  std::vector<uint8_t> pixels(4, 0);
  sd_image_t image{1, 1, 4, pixels.data()};
  auto png = image_codec::encodeToPng(image);
  ASSERT_FALSE(png.empty());
  png[16] = 0;
  png[17] = 0;
  png[18] = 0x20;
  png[19] = 0;
  png[20] = 0;
  png[21] = 0;
  png[22] = 0x20;
  png[23] = 0;
  png[24] = 16;
  image_codec::DecodeFailure failure;
  auto decoded =
      image_codec::decodeImage(png, image_codec::MAX_DECODED_PIXELS, &failure);
  EXPECT_EQ(decoded.data, nullptr);
  EXPECT_EQ(failure, image_codec::DecodeFailure::HighMemoryInputLimit);
}

TEST_F(StbImageSecurityTest, RejectsHighMemoryGrayscalePngSource) {
  std::vector<uint8_t> pixel(4, 0);
  sd_image_t image{1, 1, 4, pixel.data()};
  auto png = image_codec::encodeToPng(image);
  ASSERT_FALSE(png.empty());
  png[18] = 0x20;
  png[19] = 0;
  png[22] = 0x20;
  png[23] = 0;
  png[24] = 16;
  png[25] = 0;

  image_codec::DecodeFailure failure;
  auto decoded = image_codec::decodeImage(png, 64ULL * 1024 * 1024, &failure);
  EXPECT_EQ(decoded.data, nullptr);
  EXPECT_EQ(failure, image_codec::DecodeFailure::HighMemoryInputLimit);
}

TEST_F(StbImageSecurityTest, RejectsHighMemoryFourComponentJpeg) {
  const std::vector<uint8_t> jpeg = {0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x14, 0x08,
                                     0x20, 0x00, 0x20, 0x00, 0x04, 0x01, 0x11,
                                     0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
                                     0x04, 0x11, 0x00, 0xFF, 0xD9};
  image_codec::DecodeFailure failure;
  auto decoded =
      image_codec::decodeImage(jpeg, image_codec::MAX_DECODED_PIXELS, &failure);
  EXPECT_EQ(decoded.data, nullptr);
  EXPECT_EQ(failure, image_codec::DecodeFailure::HighMemoryInputLimit);

  auto withinSourceBudget = jpeg;
  withinSourceBudget[7] = 0x0F;
  withinSourceBudget[8] = 0xA0;
  withinSourceBudget[9] = 0x17;
  withinSourceBudget[10] = 0x70;
  auto invalidData = image_codec::decodeImage(
      withinSourceBudget, image_codec::MAX_DECODED_PIXELS, &failure);
  EXPECT_EQ(invalidData.data, nullptr);
  EXPECT_NE(failure, image_codec::DecodeFailure::HighMemoryInputLimit);
}

TEST_F(StbImageSecurityTest, RejectsExcessiveJpegScans) {
  std::vector<uint8_t> pixels(3, 128);
  sd_image_t image{1, 1, 3, pixels.data()};
  auto jpeg = image_codec::encodeToJpeg(image, 90);
  ASSERT_FALSE(jpeg.empty());
  const std::vector<uint8_t> marker = {0xFF, 0xDA};
  const auto firstScan =
      std::search(jpeg.begin(), jpeg.end(), marker.begin(), marker.end());
  ASSERT_NE(firstScan, jpeg.end());
  const std::vector<uint8_t> emptyScans(33 * 4, 0);
  auto offset = static_cast<size_t>(firstScan - jpeg.begin());
  jpeg.insert(jpeg.begin() + offset, emptyScans.begin(), emptyScans.end());
  for (size_t i = offset; i < offset + emptyScans.size(); i += 4) {
    jpeg[i] = 0xFF;
    jpeg[i + 1] = 0xDA;
    jpeg[i + 2] = 0;
    jpeg[i + 3] = 2;
  }
  image_codec::DecodeFailure failure;
  auto decoded =
      image_codec::decodeImage(jpeg, image_codec::MAX_DECODED_PIXELS, &failure);
  EXPECT_EQ(decoded.data, nullptr);
  EXPECT_EQ(failure, image_codec::DecodeFailure::JpegScanLimit);
}

TEST_F(StbImageSecurityTest, BoundsProjectedEsrganOutput) {
  using qvac_lib_inference_addon_sd::esrganOutputFitsLimits;
  EXPECT_TRUE(esrganOutputFitsLimits(512, 512, 4, 2));
  EXPECT_TRUE(esrganOutputFitsLimits(2048, 2048, 4, 1));
  EXPECT_FALSE(esrganOutputFitsLimits(2048, 2048, 4, 2));
  EXPECT_FALSE(esrganOutputFitsLimits(16384, 1, 2, 1));
  EXPECT_FALSE(esrganOutputFitsLimits(1024, 1024, 4, 2));
  EXPECT_TRUE(esrganOutputFitsLimits(
      1024, 1024, 4, 2, image_codec::MAX_CONFIGURED_IMAGE_PIXELS));
}
