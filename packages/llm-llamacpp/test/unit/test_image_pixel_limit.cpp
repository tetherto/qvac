#include <chrono>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iterator>
#include <string>
#include <unordered_map>
#include <vector>

#ifndef _WIN32
#include <sys/stat.h>
#endif

#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>

#include "model-interface/ImagePixelLimit.hpp"

namespace {
std::vector<uint8_t> pngHeader(uint32_t width, uint32_t height) {
  std::vector<uint8_t> png{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
                           0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0,    0,
                           0,    0,    0,    0,    0,    0,    0x08, 0x02, 0x00,
                           0x00, 0x00, 0,    0,    0,    0,    0,    0,    0,
                           0,    0,    0,    0,    0};
  for (int index = 0; index < 4; ++index) {
    png[16 + index] = static_cast<uint8_t>(width >> (24 - index * 8));
    png[20 + index] = static_cast<uint8_t>(height >> (24 - index * 8));
  }
  png[37] = 'I';
  png[38] = 'D';
  png[39] = 'A';
  png[40] = 'T';
  return png;
}

std::vector<uint8_t> picHeader(uint16_t width, uint16_t height) {
  std::vector<uint8_t> pic(128, 0);
  pic[0] = 0x53;
  pic[1] = 0x80;
  pic[2] = 0xf6;
  pic[3] = 0x34;
  pic[88] = 'P';
  pic[89] = 'I';
  pic[90] = 'C';
  pic[91] = 'T';
  pic[92] = static_cast<uint8_t>(width >> 8);
  pic[93] = static_cast<uint8_t>(width);
  pic[94] = static_cast<uint8_t>(height >> 8);
  pic[95] = static_cast<uint8_t>(height);
  pic[105] = 8;
  pic[106] = 1;
  pic[107] = 0xe0;
  return pic;
}

std::vector<uint8_t> topDownBmp() {
  std::vector<uint8_t> bmp(78, 0);
  bmp[0] = 'B';
  bmp[1] = 'M';
  bmp[2] = 78;
  bmp[10] = 54;
  bmp[14] = 40;
  bmp[18] = 4;
  bmp[22] = 0xfe;
  bmp[23] = 0xff;
  bmp[24] = 0xff;
  bmp[25] = 0xff;
  bmp[26] = 1;
  bmp[28] = 24;
  bmp[34] = 24;
  return bmp;
}

void expectRejected(
    const std::function<void()>& check,
    const std::string& expected = "image-max-megapixels") {
  try {
    check();
    FAIL() << "Expected the image to be rejected";
  } catch (const qvac_errors::StatusError& error) {
    EXPECT_NE(error.codeString().find("InvalidArgument"), std::string::npos);
    EXPECT_NE(std::string(error.what()).find(expected), std::string::npos)
        << error.what();
  }
}

constexpr const char* UNKNOWN_DIMENSIONS = "cannot determine dimensions";
} // namespace

TEST(ImagePixelLimit, DefaultAndConfigOverride) {
  std::unordered_map<std::string, std::string> config;
  EXPECT_EQ(
      image_pixel_limit::takeMaxPixels(config),
      image_pixel_limit::DEFAULT_MAX_PIXELS);

  config["image_max_megapixels"] = "64";
  EXPECT_EQ(image_pixel_limit::takeMaxPixels(config), 64'000'000u);
  EXPECT_TRUE(config.empty());

  config["image-max-megapixels"] = "32";
  EXPECT_EQ(image_pixel_limit::takeMaxPixels(config), 32'000'000u);
  EXPECT_TRUE(config.empty());
}

TEST(ImagePixelLimit, RejectsInvalidConfig) {
  for (const std::string value : {"0", "-1", "1.5", "abc", "18446744073710"}) {
    std::unordered_map<std::string, std::string> config{
        {"image-max-megapixels", value}};
    EXPECT_THROW(
        image_pixel_limit::takeMaxPixels(config), qvac_errors::StatusError);
  }
  std::unordered_map<std::string, std::string> duplicate{
      {"image-max-megapixels", "50"}, {"image_max_megapixels", "50"}};
  EXPECT_THROW(
      image_pixel_limit::takeMaxPixels(duplicate), qvac_errors::StatusError);
}

TEST(ImagePixelLimit, BufferBoundaryAndOverride) {
  auto atLimit = pngHeader(10'000, 5'000);
  auto overLimit = pngHeader(10'000, 5'001);
  EXPECT_NO_THROW(
      image_pixel_limit::checkBuffer(
          atLimit.data(), atLimit.size(), 50'000'000));
  expectRejected([&] {
    image_pixel_limit::checkBuffer(
        overLimit.data(), overLimit.size(), 50'000'000);
  });
  EXPECT_NO_THROW(
      image_pixel_limit::checkBuffer(
          overLimit.data(), overLimit.size(), 64'000'000));
}

TEST(ImagePixelLimit, RejectsPicWhenStbInfoCannotReportDimensions) {
  const auto small = picHeader(1, 1);
  const auto oversized = picHeader(65'535, 4'097);
  EXPECT_NO_THROW(
      image_pixel_limit::checkBuffer(small.data(), small.size(), 50'000'000));
  expectRejected(
      [&] {
        image_pixel_limit::checkBuffer(
            oversized.data(), oversized.size(), 300'000'000);
      },
      UNKNOWN_DIMENSIONS);
}

TEST(ImagePixelLimit, AcceptsTopDownBmpWithinPixelLimit) {
  const auto bmp = topDownBmp();
  EXPECT_NO_THROW(
      image_pixel_limit::checkBuffer(bmp.data(), bmp.size(), 50'000'000));
  EXPECT_THROW(
      image_pixel_limit::checkBuffer(bmp.data(), bmp.size(), 7),
      qvac_errors::StatusError);

  const auto path =
      std::filesystem::temp_directory_path() /
      ("qvac25639-top-down-" +
       std::to_string(
           std::chrono::steady_clock::now().time_since_epoch().count()) +
       ".bmp");
  {
    std::ofstream out(path, std::ios::binary);
    ASSERT_TRUE(out.is_open());
    out.write(
        reinterpret_cast<const char*>(bmp.data()),
        static_cast<std::streamsize>(bmp.size()));
  }
  EXPECT_NO_THROW(image_pixel_limit::checkFile(path.string(), 50'000'000));
  std::filesystem::remove(path);
}

TEST(ImagePixelLimit, AcceptsJpegHeader) {
  const auto path = std::filesystem::path(TEST_MEDIA_DIR) / "news-paper.jpg";
  std::ifstream stream(path, std::ios::binary);
  ASSERT_TRUE(stream.is_open());
  const std::vector<uint8_t> jpeg{
      std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
  EXPECT_NO_THROW(
      image_pixel_limit::checkBuffer(jpeg.data(), jpeg.size(), 50'000'000));
  EXPECT_NO_THROW(image_pixel_limit::checkFile(path.string(), 50'000'000));
}

TEST(ImagePixelLimit, PreservesMtmdAudioDispatch) {
  const std::vector<uint8_t> wav{
      'R', 'I', 'F', 'F', 0, 0, 0, 0, 'W', 'A', 'V', 'E'};
  const std::vector<uint8_t> id3{'I', 'D', '3', 0, 0, 0, 0, 0, 0, 0, 0, 0};
  const std::vector<uint8_t> mp3{0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
  const std::vector<uint8_t> flac{'f', 'L', 'a', 'C', 0, 0, 0, 0, 0, 0, 0, 0};
  for (const auto& audio : {wav, id3, mp3, flac}) {
    EXPECT_NO_THROW(
        image_pixel_limit::checkBuffer(audio.data(), audio.size(), 50'000'000));
  }
}

TEST(ImagePixelLimit, EmptyBufferReportsEmptyMedia) {
  try {
    image_pixel_limit::checkBuffer(nullptr, 0, 50'000'000);
    FAIL() << "Expected empty media to be rejected";
  } catch (const qvac_errors::StatusError& error) {
    EXPECT_NE(
        std::string(error.what()).find("Media buffer is empty"),
        std::string::npos);
  }
}

TEST(ImagePixelLimit, FileIsRejectedBeforeDecode) {
  const auto path =
      std::filesystem::temp_directory_path() /
      ("qvac25639-image-limit-" +
       std::to_string(
           std::chrono::steady_clock::now().time_since_epoch().count()) +
       ".png");
  const auto header = pngHeader(16'384, 16'384);
  {
    std::ofstream out(path, std::ios::binary);
    ASSERT_TRUE(out.is_open());
    out.write(
        reinterpret_cast<const char*>(header.data()),
        static_cast<std::streamsize>(header.size()));
  }
  expectRejected(
      [&] { image_pixel_limit::checkFile(path.string(), 50'000'000); });
  EXPECT_NO_THROW(image_pixel_limit::checkFile(path.string(), 300'000'000));
  EXPECT_EQ(image_pixel_limit::readRegularFile(path.string()), header);
  const auto pic = picHeader(65'535, 4'097);
  {
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    ASSERT_TRUE(out.is_open());
    out.write(
        reinterpret_cast<const char*>(pic.data()),
        static_cast<std::streamsize>(pic.size()));
  }
  expectRejected(
      [&] { image_pixel_limit::checkFile(path.string(), 300'000'000); },
      UNKNOWN_DIMENSIONS);
  std::filesystem::remove(path);
}

TEST(ImagePixelLimit, RejectsNonRegularFileBeforeOpening) {
  EXPECT_THROW(
      image_pixel_limit::checkFile(
          std::filesystem::temp_directory_path().string(), 50'000'000),
      qvac_errors::StatusError);
#ifndef _WIN32
  EXPECT_THROW(
      image_pixel_limit::readRegularFile("/dev/zero"),
      qvac_errors::StatusError);
  // Opening a FIFO without a writer would block a reader that skipped the
  // type check.
  const auto fifo =
      std::filesystem::temp_directory_path() /
      ("qvac25639-fifo-" +
       std::to_string(
           std::chrono::steady_clock::now().time_since_epoch().count()));
  ASSERT_EQ(::mkfifo(fifo.c_str(), 0600), 0);
  EXPECT_THROW(
      image_pixel_limit::checkFile(fifo.string(), 50'000'000),
      qvac_errors::StatusError);
  EXPECT_THROW(
      image_pixel_limit::readRegularFile(fifo.string()),
      qvac_errors::StatusError);
  std::filesystem::remove(fifo);
#endif
}

TEST(ImagePixelLimit, MissingFileReportsNotFound) {
  const auto path =
      std::filesystem::temp_directory_path() /
      ("qvac25639-missing-" +
       std::to_string(
           std::chrono::steady_clock::now().time_since_epoch().count()));
  try {
    image_pixel_limit::checkFile(path.string(), 50'000'000);
    FAIL() << "Expected missing media file to be rejected";
  } catch (const qvac_errors::StatusError& error) {
    EXPECT_NE(
        std::string(error.what()).find("Media file not found"),
        std::string::npos);
  }
}
