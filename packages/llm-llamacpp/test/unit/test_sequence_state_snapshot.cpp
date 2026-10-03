#include <cstdint>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include <gtest/gtest.h>
#include <llama.h>

#include "utils/SequenceStateSnapshot.hpp"

using namespace qvac_lib_inference_addon_llama::utils;

// Pure-logic coverage of the snapshot helpers. End-to-end coverage that
// touches a real `llama_context` lives in the `reasoning.test.js` and
// `gemma4.test.js` integration suites — those exercise the snapshot +
// restore + replay path against actual hybrid / pure-attention models.
//
// The snapshot has two backends: a temp file written via
// `llama_state_seq_save_file`, or a host buffer from
// `llama_state_seq_get_data`. The tests below cover the ownership / RAII
// contract around both (clear, destructor, move) so we never leak a temp
// file or double-delete one. The test seam (`seedForTesting`) hands the
// snapshot a sentinel path so we can exercise the lifecycle without a real
// `llama_context`; `adoptBuffer` does the same for the memory backend.

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

TEST(SequenceStateSnapshotTest, EmptyByDefault) {
  SequenceStateSnapshot snap;
  EXPECT_TRUE(snap.empty());
  EXPECT_FALSE(snap.hasFile());
  EXPECT_TRUE(snap.filePath().empty());
  EXPECT_EQ(snap.nPast, 0);
}

TEST(SequenceStateSnapshotTest, AdoptEmptyMarksCapturedWithoutFile) {
  // The pre-prefill capture path uses `adoptEmpty` to record "we
  // captured an empty sequence". The snapshot must report a recorded
  // capture (so rollback gates trigger) but expose no on-disk file.
  SequenceStateSnapshot snap;
  snap.adoptEmpty(/*nPastAt=*/0);
  EXPECT_FALSE(snap.empty());
  EXPECT_FALSE(snap.hasFile());
  EXPECT_TRUE(snap.filePath().empty());
  EXPECT_EQ(snap.nPast, 0);
}

TEST(SequenceStateSnapshotTest, ClearResetsAdoptEmptyState) {
  // Clearing a captured-empty snapshot must wipe the captured flag so
  // subsequent rollback queries see it as "nothing captured".
  SequenceStateSnapshot snap;
  snap.adoptEmpty(/*nPastAt=*/0);
  ASSERT_FALSE(snap.empty());
  snap.clear();
  EXPECT_TRUE(snap.empty());
  EXPECT_FALSE(snap.hasFile());
  EXPECT_EQ(snap.nPast, 0);
}

TEST(SequenceStateSnapshotTest, MoveTransfersCapturedEmptyState) {
  // A captured-empty snapshot moves like any other capture: the
  // destination inherits the captured flag, the source resets to
  // "nothing captured". Guards against future regressions where
  // move would forget to copy `captured_`.
  SequenceStateSnapshot src;
  src.adoptEmpty(/*nPastAt=*/5);

  SequenceStateSnapshot dst(std::move(src));
  EXPECT_TRUE(src.empty());
  EXPECT_EQ(src.nPast, 0);
  EXPECT_FALSE(dst.empty());
  EXPECT_FALSE(dst.hasFile());
  EXPECT_EQ(dst.nPast, 5);
}

TEST(SequenceStateSnapshotTest, ClearRemovesUnderlyingFile) {
  // Seed the snapshot with a real on-disk file via the test seam,
  // then verify clear() removes it and resets the metadata.
  const fs::path tmp = makeTempFile("clear");
  ASSERT_TRUE(fs::exists(tmp));

  SequenceStateSnapshot snap;
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

TEST(SequenceStateSnapshotTest, ClearOnEmptySnapshotIsNoOp) {
  // Defense against the destructor / clear() path calling
  // `std::filesystem::remove` with an empty string on a never-seeded
  // snapshot. Must be a clean no-op.
  SequenceStateSnapshot snap;
  EXPECT_NO_THROW(snap.clear());
  EXPECT_TRUE(snap.empty());
}

TEST(SequenceStateSnapshotTest, DestructorRemovesUnderlyingFile) {
  const fs::path tmp = makeTempFile("dtor");
  ASSERT_TRUE(fs::exists(tmp));

  {
    SequenceStateSnapshot snap;
    snap.seedForTesting(tmp.string(), /*nPastAt=*/0);
    ASSERT_TRUE(fs::exists(tmp));
  } // ~SequenceStateSnapshot here

  EXPECT_FALSE(fs::exists(tmp))
      << "destructor must remove the temp file the snapshot owned";
}

TEST(SequenceStateSnapshotTest, MoveConstructTransfersFileOwnership) {
  const fs::path tmp = makeTempFile("move_ctor");
  ASSERT_TRUE(fs::exists(tmp));

  SequenceStateSnapshot src;
  src.seedForTesting(tmp.string(), /*nPastAt=*/7);

  SequenceStateSnapshot dst(std::move(src));
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

TEST(SequenceStateSnapshotTest, MoveAssignReplacesAndCleansOldFile) {
  // Move-assigning a new snapshot over an existing one must remove
  // the previously owned file (otherwise it leaks).
  const fs::path oldFile = makeTempFile("move_assign_old");
  const fs::path newFile = makeTempFile("move_assign_new");

  SequenceStateSnapshot dst;
  dst.seedForTesting(oldFile.string(), /*nPastAt=*/1);

  SequenceStateSnapshot src;
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

TEST(SequenceStateSnapshotTest, SnapshotOnNullCtxFails) {
  // Pre-seed `snap` with a real file so the helper's "clear before
  // populate" step has something to remove. After the null-ctx
  // failure path, the snapshot must report empty AND the seeded file
  // must be gone (no leaked temp file).
  const fs::path tmp = makeTempFile("snap_null_ctx");
  SequenceStateSnapshot snap;
  snap.seedForTesting(tmp.string(), /*nPastAt=*/7);

  EXPECT_FALSE(snapshotSequenceState(
      /*lctx=*/nullptr, /*seqId=*/0, /*nPastAt=*/12, snap));
  EXPECT_TRUE(snap.empty());
  EXPECT_EQ(snap.nPast, 0);
  EXPECT_FALSE(fs::exists(tmp))
      << "failed capture must not leak the pre-existing temp file";
}

TEST(SequenceStateSnapshotTest, RestoreOnNullCtxFails) {
  SequenceStateSnapshot snap;
  snap.seedForTesting("dummy_nonexistent_path.bin", /*nPastAt=*/0);
  EXPECT_FALSE(restoreSequenceState(/*lctx=*/nullptr, /*seqId=*/0, snap));
}

TEST(
    SequenceStateSnapshotTest, RestoreEmptySnapshotIsNoOpButRequiresCtxSafety) {
  // Empty snapshot + null ctx still returns false (we never reach the
  // empty-shortcut path because the ctx check guards first); this is
  // the documented contract — programming errors are surfaced.
  SequenceStateSnapshot snap;
  EXPECT_FALSE(restoreSequenceState(/*lctx=*/nullptr, /*seqId=*/0, snap));
}

TEST(SequenceStateSnapshotTest, AdoptBufferOwnsPayloadInMemory) {
  SequenceStateSnapshot snap;
  snap.adoptBuffer(std::vector<uint8_t>{1, 2, 3, 4}, /*nPastAt=*/9);
  EXPECT_FALSE(snap.empty());
  EXPECT_TRUE(snap.hasBuffer());
  EXPECT_TRUE(snap.hasPayload());
  EXPECT_FALSE(snap.hasFile()) << "a memory-backed snapshot owns no file";
  EXPECT_EQ(snap.bytes(), 4u);
  EXPECT_EQ(snap.nPast, 9);

  snap.clear();
  EXPECT_TRUE(snap.empty());
  EXPECT_FALSE(snap.hasBuffer());
  EXPECT_EQ(snap.bytes(), 0u);
}

TEST(SequenceStateSnapshotTest, MoveTransfersBufferOwnership) {
  SequenceStateSnapshot src;
  src.adoptBuffer(std::vector<uint8_t>(64, 7), /*nPastAt=*/3);

  SequenceStateSnapshot dst(std::move(src));
  EXPECT_TRUE(src.empty());
  EXPECT_FALSE(src.hasBuffer());
  EXPECT_EQ(src.bytes(), 0u);
  EXPECT_TRUE(dst.hasBuffer());
  EXPECT_EQ(dst.bytes(), 64u);
  EXPECT_EQ(dst.nPast, 3);

  // Move-assigning a file-backed snapshot over it drops the buffer and
  // takes the file, and vice versa: exactly one payload is ever owned.
  const fs::path tmp = makeTempFile("move_over_buffer");
  SequenceStateSnapshot fileBacked;
  fileBacked.seedForTesting(tmp.string(), /*nPastAt=*/1);
  dst = std::move(fileBacked);
  EXPECT_FALSE(dst.hasBuffer());
  EXPECT_TRUE(dst.hasFile());
  dst.clear();
  EXPECT_FALSE(fs::exists(tmp));
}

TEST(SequenceStateSnapshotTest, AdoptFileRecordsPayloadBytes) {
  const fs::path tmp = makeTempFile("adopt_bytes");
  SequenceStateSnapshot snap;
  snap.adoptFile(tmp.string(), /*nPastAt=*/2, /*bytes=*/4096);
  EXPECT_TRUE(snap.hasFile());
  EXPECT_FALSE(snap.hasBuffer());
  EXPECT_EQ(snap.bytes(), 4096u);
  snap.clear();
  EXPECT_FALSE(fs::exists(tmp));
}

TEST(SequenceStateSnapshotTest, MemorySnapshotOnNullCtxFails) {
  SequenceStateSnapshot snap;
  snap.adoptBuffer(std::vector<uint8_t>{1}, /*nPastAt=*/1);
  EXPECT_FALSE(snapshotSequenceState(
      /*lctx=*/nullptr,
      /*seqId=*/0,
      /*nPastAt=*/12,
      snap,
      SnapshotStorage::Memory));
  EXPECT_TRUE(snap.empty());
  EXPECT_FALSE(snap.hasBuffer())
      << "a failed capture must drop the old payload";
}

TEST(SequenceStateSnapshotTest, EstimateOnNullCtxIsZero) {
  EXPECT_EQ(
      estimateMaxSequenceStateBytes(
          /*lctx=*/nullptr, /*vocab=*/nullptr, /*perSeqTokens=*/4096),
      0u);
}
