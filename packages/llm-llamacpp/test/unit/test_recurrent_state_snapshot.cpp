#include <cstdint>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include <gtest/gtest.h>
#include <llama.h>

#include "utils/RecurrentStateSnapshot.hpp"

using namespace qvac_lib_inference_addon_llama::utils;

// Pure-logic coverage of the snapshot helpers. End-to-end coverage that
// touches a real `llama_context` lives in the `reasoning.test.js` and
// `gemma4.test.js` integration suites — those exercise the snapshot +
// restore + replay path against actual hybrid / pure-attention models.
//
// The snapshot is now disk-backed: each capture writes the full per-
// sequence state to a temp file via `llama_state_seq_save_file`. The
// tests below cover the ownership / RAII contract that surrounds that
// file (clear, destructor, move) so we never leak a temp file or
// double-delete one. The test seam (`seedForTesting`) hands the
// snapshot a sentinel path so we can exercise the lifecycle without a
// real `llama_context`.

namespace fs = std::filesystem;

namespace {

// Creates a real (small) file under temp_directory_path() so the
// snapshot has something to remove. Returns the absolute path.
fs::path makeTempFile(const std::string& suffix) {
  const fs::path p =
      fs::temp_directory_path() / ("qvac_snap_unit_" + suffix + ".bin");
  std::error_code ec;
  fs::remove(p, ec); // start clean if a previous run left it
  std::ofstream(p) << "test";
  return p;
}

} // namespace

TEST(RecurrentStateSnapshotTest, EmptyByDefault) {
  RecurrentStateSnapshot snap;
  EXPECT_TRUE(snap.empty());
  EXPECT_FALSE(snap.hasFile());
  EXPECT_TRUE(snap.filePath().empty());
  EXPECT_EQ(snap.nPast, 0);
}

TEST(RecurrentStateSnapshotTest, AdoptEmptyMarksCapturedWithoutFile) {
  // The pre-prefill capture path uses `adoptEmpty` to record "we
  // captured an empty sequence". The snapshot must report a recorded
  // capture (so rollback gates trigger) but expose no on-disk file.
  RecurrentStateSnapshot snap;
  snap.adoptEmpty(/*nPastAt=*/0);
  EXPECT_FALSE(snap.empty());
  EXPECT_FALSE(snap.hasFile());
  EXPECT_TRUE(snap.filePath().empty());
  EXPECT_EQ(snap.nPast, 0);
}

TEST(RecurrentStateSnapshotTest, ClearResetsAdoptEmptyState) {
  // Clearing a captured-empty snapshot must wipe the captured flag so
  // subsequent rollback queries see it as "nothing captured".
  RecurrentStateSnapshot snap;
  snap.adoptEmpty(/*nPastAt=*/0);
  ASSERT_FALSE(snap.empty());
  snap.clear();
  EXPECT_TRUE(snap.empty());
  EXPECT_FALSE(snap.hasFile());
  EXPECT_EQ(snap.nPast, 0);
}

TEST(RecurrentStateSnapshotTest, MoveTransfersCapturedEmptyState) {
  // A captured-empty snapshot moves like any other capture: the
  // destination inherits the captured flag, the source resets to
  // "nothing captured". Guards against future regressions where
  // move would forget to copy `captured_`.
  RecurrentStateSnapshot src;
  src.adoptEmpty(/*nPastAt=*/5);

  RecurrentStateSnapshot dst(std::move(src));
  EXPECT_TRUE(src.empty());
  EXPECT_EQ(src.nPast, 0);
  EXPECT_FALSE(dst.empty());
  EXPECT_FALSE(dst.hasFile());
  EXPECT_EQ(dst.nPast, 5);
}

TEST(RecurrentStateSnapshotTest, ClearRemovesUnderlyingFile) {
  // Seed the snapshot with a real on-disk file via the test seam,
  // then verify clear() removes it and resets the metadata.
  const fs::path tmp = makeTempFile("clear");
  ASSERT_TRUE(fs::exists(tmp));

  RecurrentStateSnapshot snap;
  snap.seedForTesting(tmp.string(), /*nPastAt=*/42);
  ASSERT_FALSE(snap.empty());
  ASSERT_EQ(snap.nPast, 42);

  snap.clear();
  EXPECT_TRUE(snap.empty());
  EXPECT_TRUE(snap.filePath().empty());
  EXPECT_EQ(snap.nPast, 0);
  EXPECT_FALSE(fs::exists(tmp))
      << "clear() must remove the temp file the snapshot owned";
}

TEST(RecurrentStateSnapshotTest, ClearOnEmptySnapshotIsNoOp) {
  // Defense against the destructor / clear() path calling
  // `std::filesystem::remove` with an empty string on a never-seeded
  // snapshot. Must be a clean no-op.
  RecurrentStateSnapshot snap;
  EXPECT_NO_THROW(snap.clear());
  EXPECT_TRUE(snap.empty());
}

TEST(RecurrentStateSnapshotTest, DestructorRemovesUnderlyingFile) {
  const fs::path tmp = makeTempFile("dtor");
  ASSERT_TRUE(fs::exists(tmp));

  {
    RecurrentStateSnapshot snap;
    snap.seedForTesting(tmp.string(), /*nPastAt=*/0);
    ASSERT_TRUE(fs::exists(tmp));
  } // ~RecurrentStateSnapshot here

  EXPECT_FALSE(fs::exists(tmp))
      << "destructor must remove the temp file the snapshot owned";
}

TEST(RecurrentStateSnapshotTest, MoveConstructTransfersFileOwnership) {
  const fs::path tmp = makeTempFile("move_ctor");
  ASSERT_TRUE(fs::exists(tmp));

  RecurrentStateSnapshot src;
  src.seedForTesting(tmp.string(), /*nPastAt=*/7);

  RecurrentStateSnapshot dst(std::move(src));
  // Source loses ownership and file metadata.
  EXPECT_TRUE(src.empty());
  EXPECT_EQ(src.nPast, 0);
  // Destination takes over; the file is still present until `dst`
  // goes out of scope or is cleared.
  EXPECT_FALSE(dst.empty());
  EXPECT_EQ(dst.nPast, 7);
  EXPECT_EQ(dst.filePath(), tmp.string());
  EXPECT_TRUE(fs::exists(tmp)) << "move must not delete the underlying file";

  dst.clear();
  EXPECT_FALSE(fs::exists(tmp));
}

TEST(RecurrentStateSnapshotTest, MoveAssignReplacesAndCleansOldFile) {
  // Move-assigning a new snapshot over an existing one must remove
  // the previously owned file (otherwise it leaks).
  const fs::path oldFile = makeTempFile("move_assign_old");
  const fs::path newFile = makeTempFile("move_assign_new");

  RecurrentStateSnapshot dst;
  dst.seedForTesting(oldFile.string(), /*nPastAt=*/1);

  RecurrentStateSnapshot src;
  src.seedForTesting(newFile.string(), /*nPastAt=*/2);

  dst = std::move(src);

  EXPECT_FALSE(fs::exists(oldFile))
      << "move-assign must remove the previously owned temp file";
  EXPECT_TRUE(fs::exists(newFile))
      << "move-assign must keep the moved-in file alive";
  EXPECT_EQ(dst.filePath(), newFile.string());
  EXPECT_EQ(dst.nPast, 2);
  EXPECT_TRUE(src.empty());
  EXPECT_EQ(src.nPast, 0);

  dst.clear();
}

TEST(RecurrentStateSnapshotTest, SnapshotOnNullCtxFails) {
  // Pre-seed `snap` with a real file so the helper's "clear before
  // populate" step has something to remove. After the null-ctx
  // failure path, the snapshot must report empty AND the seeded file
  // must be gone (no leaked temp file).
  const fs::path tmp = makeTempFile("snap_null_ctx");
  RecurrentStateSnapshot snap;
  snap.seedForTesting(tmp.string(), /*nPastAt=*/7);

  EXPECT_FALSE(snapshotRecurrentState(
      /*lctx=*/nullptr, /*seqId=*/0, /*nPastAt=*/12, snap));
  EXPECT_TRUE(snap.empty());
  EXPECT_EQ(snap.nPast, 0);
  EXPECT_FALSE(fs::exists(tmp))
      << "failed capture must not leak the pre-existing temp file";
}

TEST(RecurrentStateSnapshotTest, RestoreOnNullCtxFails) {
  RecurrentStateSnapshot snap;
  snap.seedForTesting("dummy_nonexistent_path.bin", /*nPastAt=*/0);
  EXPECT_FALSE(restoreRecurrentState(/*lctx=*/nullptr, /*seqId=*/0, snap));
}

TEST(
    RecurrentStateSnapshotTest,
    RestoreEmptySnapshotIsNoOpButRequiresCtxSafety) {
  // Empty snapshot + null ctx still returns false (we never reach the
  // empty-shortcut path because the ctx check guards first); this is
  // the documented contract — programming errors are surfaced.
  RecurrentStateSnapshot snap;
  EXPECT_FALSE(restoreRecurrentState(/*lctx=*/nullptr, /*seqId=*/0, snap));
}

TEST(RecurrentStateSnapshotTest, ReplayEmptyTokensIsNoOpEvenWithNullCtx) {
  std::vector<llama_token> empty;
  EXPECT_TRUE(replayTokensThroughDecoder(
      /*lctx=*/nullptr, /*seqId=*/0, empty, /*startPos=*/0));
}

TEST(RecurrentStateSnapshotTest, ReplayNonEmptyTokensWithNullCtxFails) {
  std::vector<llama_token> tokens = {1, 2, 3};
  EXPECT_FALSE(replayTokensThroughDecoder(
      /*lctx=*/nullptr, /*seqId=*/0, tokens, /*startPos=*/0));
}

TEST(RecurrentStateSnapshotTest, ReplayFailureAfterPartialChunksReturnsFalse) {
  std::vector<llama_token> tokens = {1, 2, 3, 4, 5};
  int decodeCalls = 0;
  std::vector<int32_t> chunkSizes;
  auto* fakeCtx = reinterpret_cast<::llama_context*>(static_cast<uintptr_t>(1));

  const bool replayOk = replayTokensThroughDecoderForTesting(
      fakeCtx,
      /*seqId=*/0,
      tokens,
      /*startPos=*/10,
      /*outputLogitsForLast=*/false,
      /*chunkSize=*/2,
      [&](::llama_context*, llama_batch batch) {
        ++decodeCalls;
        chunkSizes.push_back(batch.n_tokens);
        return decodeCalls == 3 ? -1 : 0;
      });

  EXPECT_FALSE(replayOk)
      << "a decode failure after earlier replay chunks must propagate";
  EXPECT_EQ(decodeCalls, 3);
  ASSERT_EQ(chunkSizes.size(), 3u);
  EXPECT_EQ(chunkSizes[0], 2);
  EXPECT_EQ(chunkSizes[1], 2);
  EXPECT_EQ(chunkSizes[2], 1);
}
