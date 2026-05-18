#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <stdexcept>

#include <gtest/gtest.h>
#include <stable-diffusion.h>

#include "utils/SdVideoFrames.hpp"

using qvac_lib_inference_addon_sd::SdVideoFrames;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
//
// SdVideoFrames owns two layers of malloc() allocations:
//   1. the sd_image_t* array itself
//   2. each frame's pixel data buffer (frame.data)
//
// Both are freed on destruction using free(). These helpers mirror what
// generate_video() does internally so tests exercise the exact same
// ownership contract the real API relies on.
// ---------------------------------------------------------------------------

namespace {

/**
 * Allocate an sd_image_t array of size `count` using malloc(), each frame
 * pointing at a zero-initialised malloc()'d pixel buffer sized for
 * `width x height` RGB8. Matches generate_video() semantics.
 */
sd_image_t *makeFrameArray(int count, uint32_t width, uint32_t height) {
  auto *arr = static_cast<sd_image_t *>(malloc(sizeof(sd_image_t) * count));
  if (!arr)
    return nullptr;
  for (int i = 0; i < count; ++i) {
    const size_t bytes = static_cast<size_t>(width) * height * 3;
    auto *pixels = static_cast<uint8_t *>(malloc(bytes));
    // Fill with a per-frame sentinel so the destructor visibly frees
    // distinct allocations under ASan.
    if (pixels)
      std::memset(pixels, static_cast<int>(i & 0xFF), bytes);
    arr[i] = sd_image_t{width, height, 3, pixels};
  }
  return arr;
}

} // namespace

// ---------------------------------------------------------------------------
// Default / empty construction
// ---------------------------------------------------------------------------

TEST(SdVideoFramesTest, DefaultConstructedIsEmpty) {
  SdVideoFrames frames;
  EXPECT_TRUE(frames.empty());
  EXPECT_EQ(frames.count(), 0);
  EXPECT_EQ(frames.data(), nullptr);
}

TEST(SdVideoFramesTest, NullDataWithZeroCountIsEmpty) {
  SdVideoFrames frames(nullptr, 0);
  EXPECT_TRUE(frames.empty());
  EXPECT_EQ(frames.count(), 0);
  EXPECT_EQ(frames.data(), nullptr);
}

TEST(SdVideoFramesTest, NullDataWithNonZeroCountIsStillEmpty) {
  // generate_video() may set num_frames_out to a non-zero value even when
  // the array pointer is null on error paths. empty() must still report
  // true so callers don't deref the pointer.
  SdVideoFrames frames(nullptr, 33);
  EXPECT_TRUE(frames.empty());
  EXPECT_EQ(frames.count(), 33);
  EXPECT_EQ(frames.data(), nullptr);
}

// ---------------------------------------------------------------------------
// Ownership + destruction
// ---------------------------------------------------------------------------

TEST(SdVideoFramesTest, DestroysSingleFrameWithoutLeak) {
  sd_image_t *arr = makeFrameArray(1, 64, 64);
  ASSERT_NE(arr, nullptr);
  ASSERT_NE(arr[0].data, nullptr);
  {
    SdVideoFrames frames(arr, 1);
    EXPECT_FALSE(frames.empty());
    EXPECT_EQ(frames.count(), 1);
  }
  // ASan / LeakSanitizer on non-Apple CI will flag a leak if either the
  // pixel buffer or the array itself is not freed on destruction.
  SUCCEED();
}

TEST(SdVideoFramesTest, DestroysMultipleFramesWithoutLeak) {
  const int kN = 16;
  sd_image_t *arr = makeFrameArray(kN, 32, 32);
  ASSERT_NE(arr, nullptr);
  {
    SdVideoFrames frames(arr, kN);
    EXPECT_FALSE(frames.empty());
    EXPECT_EQ(frames.count(), kN);
  }
  SUCCEED();
}

TEST(SdVideoFramesTest, DestroysFramesWith4kPlus1Count) {
  // video_frames follows the 4k+1 rule in SdVidGenHandlers; verify the
  // RAII wrapper handles the typical production counts (5, 9, 33, 81).
  for (int count : {5, 9, 33, 81}) {
    sd_image_t *arr = makeFrameArray(count, 16, 16);
    ASSERT_NE(arr, nullptr);
    SdVideoFrames frames(arr, count);
    EXPECT_EQ(frames.count(), count);
    EXPECT_FALSE(frames.empty());
    // Dtor runs here on loop exit.
  }
  SUCCEED();
}

TEST(SdVideoFramesTest, HandlesFrameWithNullPixelBuffer) {
  // On mid-run decode failure the library may leave an individual frame's
  // data pointer null. The destructor must tolerate free(NULL) gracefully
  // (which is standard C) instead of assuming every frame has pixels.
  auto *arr = static_cast<sd_image_t *>(malloc(sizeof(sd_image_t) * 3));
  ASSERT_NE(arr, nullptr);
  arr[0] = sd_image_t{16, 16, 3, nullptr};
  auto *goodPixels = static_cast<uint8_t *>(malloc(16 * 16 * 3));
  arr[1] = sd_image_t{16, 16, 3, goodPixels};
  arr[2] = sd_image_t{16, 16, 3, nullptr};
  {
    SdVideoFrames frames(arr, 3);
    EXPECT_EQ(frames.count(), 3);
  }
  SUCCEED();
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

TEST(SdVideoFramesTest, DataReturnsUnderlyingPointer) {
  sd_image_t *arr = makeFrameArray(4, 8, 8);
  ASSERT_NE(arr, nullptr);
  SdVideoFrames frames(arr, 4);
  EXPECT_EQ(frames.data(), arr);
}

TEST(SdVideoFramesTest, IndexOperatorReturnsSameFrame) {
  const int kN = 3;
  sd_image_t *arr = makeFrameArray(kN, 16, 16);
  ASSERT_NE(arr, nullptr);
  SdVideoFrames frames(arr, kN);
  for (int i = 0; i < kN; ++i) {
    const sd_image_t &f = frames[i];
    EXPECT_EQ(f.width, 16u);
    EXPECT_EQ(f.height, 16u);
    EXPECT_EQ(f.channel, 3u);
    ASSERT_NE(f.data, nullptr);
    // The sentinel pattern set by makeFrameArray: pixel[0] == (i & 0xFF).
    EXPECT_EQ(f.data[0], static_cast<uint8_t>(i & 0xFF));
  }
}

TEST(SdVideoFramesTest, IndexOperatorThrowsOnNullData) {
  SdVideoFrames frames(nullptr, 5);
  EXPECT_THROW((void)frames[0], std::runtime_error);
}

TEST(SdVideoFramesTest, IndexOperatorThrowsOnOutOfRange) {
  sd_image_t *arr = makeFrameArray(2, 8, 8);
  ASSERT_NE(arr, nullptr);
  SdVideoFrames frames(arr, 2);
  EXPECT_THROW((void)frames[-1], std::out_of_range);
  EXPECT_THROW((void)frames[2], std::out_of_range);
  EXPECT_THROW((void)frames[999], std::out_of_range);
  // Valid indices stay fine.
  EXPECT_NO_THROW((void)frames[0]);
  EXPECT_NO_THROW((void)frames[1]);
}

// ---------------------------------------------------------------------------
// Copy/move semantics (should be deleted at compile time)
// ---------------------------------------------------------------------------

TEST(SdVideoFramesTest, CopyAndMoveAreDisabledAtCompileTime) {
  // Compile-time checks: if these traits flip to true, a double-free would
  // be possible at runtime. Explicit static_assert(false...) would fail the
  // build; EXPECT_FALSE at runtime keeps the assertion visible in test
  // output without breaking other compilers that don't support constexpr
  // checks in this position.
  EXPECT_FALSE(std::is_copy_constructible<SdVideoFrames>::value);
  EXPECT_FALSE(std::is_copy_assignable<SdVideoFrames>::value);
  EXPECT_FALSE(std::is_move_constructible<SdVideoFrames>::value);
  EXPECT_FALSE(std::is_move_assignable<SdVideoFrames>::value);
}
