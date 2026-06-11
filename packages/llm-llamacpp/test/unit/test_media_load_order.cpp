// computeMediaLoadOrder must turn an ordered media plan into a load sequence
// that preserves prompt-marker order. The single-prompt path loads hoisted
// byte buffers and inline paths into one shared bitmap list while the MTMD
// markers are emitted in original prompt order; if the load order diverges
// from the plan, bitmaps bind to the wrong markers (the bug).
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/MediaLoadOrder.hpp"

namespace {

PlannedMedia byteBuffer() { return {MediaSource::ByteBuffer, ""}; }
PlannedMedia path(std::string p) { return {MediaSource::Path, std::move(p)}; }

} // namespace

/// An interleaved plan must yield the same order, with byte buffers numbered in
/// the sequence they appear. Plan [Path, ByteBuffer, Path, ByteBuffer] must
/// load as Path a -> ByteBuffer#0 -> Path b -> ByteBuffer#1.
TEST(MediaLoadOrder, PreservesInterleavedPromptOrder) {
  const std::vector<PlannedMedia> plan = {
      path("a.jpg"), byteBuffer(), path("b.jpg"), byteBuffer()};

  const auto steps = computeMediaLoadOrder(plan);

  ASSERT_EQ(steps.size(), 4u);

  EXPECT_EQ(steps[0].source, MediaSource::Path);
  EXPECT_EQ(steps[0].path, "a.jpg");

  EXPECT_EQ(steps[1].source, MediaSource::ByteBuffer);
  EXPECT_EQ(steps[1].byteIndex, 0u);

  EXPECT_EQ(steps[2].source, MediaSource::Path);
  EXPECT_EQ(steps[2].path, "b.jpg");

  EXPECT_EQ(steps[3].source, MediaSource::ByteBuffer);
  EXPECT_EQ(steps[3].byteIndex, 1u);
}

TEST(MediaLoadOrder, AllByteBuffersNumberedInOrder) {
  const std::vector<PlannedMedia> plan = {
      byteBuffer(), byteBuffer(), byteBuffer()};

  const auto steps = computeMediaLoadOrder(plan);

  ASSERT_EQ(steps.size(), 3u);
  for (size_t i = 0; i < steps.size(); ++i) {
    EXPECT_EQ(steps[i].source, MediaSource::ByteBuffer);
    EXPECT_EQ(steps[i].byteIndex, i);
  }
}

TEST(MediaLoadOrder, AllPathsCarryTheirPathInOrder) {
  const std::vector<PlannedMedia> plan = {
      path("a.jpg"), path("b.jpg"), path("c.jpg")};

  const auto steps = computeMediaLoadOrder(plan);

  ASSERT_EQ(steps.size(), 3u);
  EXPECT_EQ(steps[0].path, "a.jpg");
  EXPECT_EQ(steps[1].path, "b.jpg");
  EXPECT_EQ(steps[2].path, "c.jpg");
}
