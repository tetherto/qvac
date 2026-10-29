#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <sstream>
#include <string>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/CacheCheckpointFile.hpp"
#include "model-interface/CacheFileIndex.hpp"
#include "model-interface/CacheLedger.hpp"
#include "model-interface/SlotStateCache.hpp"
#include "utils/SequenceStateSnapshot.hpp"

namespace cache = qvac_lib_inference_addon_llama::cache;
namespace utils = qvac_lib_inference_addon_llama::utils;
namespace fs = std::filesystem;

namespace {

// Stands in for the header, ledger and sequence state a real save writes
// first; the section only ever follows them.
const std::string K_STATE = "llama.cpp header, ledger and sequence state";

class CacheCheckpointFileTest : public ::testing::Test {
protected:
  void SetUp() override {
    path_ =
        (fs::temp_directory_path() /
         ("qvac_checkpoint_section_" +
          std::to_string(::testing::UnitTest::GetInstance()->random_seed()) +
          "_" +
          ::testing::UnitTest::GetInstance()->current_test_info()->name() +
          ".bin"))
            .string();
    std::ofstream out(path_, std::ios::binary | std::ios::trunc);
    out << K_STATE;
  }
  void TearDown() override {
    std::error_code ec;
    fs::remove(path_, ec);
  }

  [[nodiscard]] uint64_t stateEnd() const { return K_STATE.size(); }
  [[nodiscard]] uintmax_t fileSize() const { return fs::file_size(path_); }

  // A checkpoint whose ledger is the first `tokens` tokens of `resident()`.
  static cache::Checkpoint checkpoint(size_t tokens, char fill) {
    cache::Checkpoint result;
    std::vector<llama_token> prefix;
    for (size_t i = 0; i < tokens; ++i) {
      prefix.push_back(static_cast<llama_token>(100 + i));
    }
    result.ledger = cache::fromTokens(prefix);
    result.cacheTokens = static_cast<llama_pos>(tokens);
    result.state.adoptBuffer(
        std::vector<uint8_t>(32 + tokens, static_cast<uint8_t>(fill)),
        static_cast<llama_pos>(tokens));
    result.state.setScope(utils::SnapshotScope::Partial);
    return result;
  }
  // A partial snapshot of `payload` stored in a file of the snapshot
  // directory, as `cache_checkpoint_storage: disk` keeps one.
  static utils::SequenceStateSnapshot
  diskSnapshot(const std::vector<uint8_t>& payload, llama_pos nPast) {
    utils::SequenceStateSnapshot result;
    std::istringstream in(
        std::string(payload.begin(), payload.end()), std::ios::binary);
    EXPECT_TRUE(
        utils::partialSnapshotFromStream(
            in,
            payload.size(),
            nPast,
            utils::SnapshotStorage::Disk,
            fs::temp_directory_path().string(),
            [](const uint8_t*, size_t) {},
            result));
    return result;
  }
  static std::vector<uint8_t> readAll(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(in), {}};
  }
  static cache::Ledger resident() {
    std::vector<llama_token> tokens;
    for (int i = 0; i < 12; ++i) {
      tokens.push_back(100 + i);
    }
    return cache::fromTokens(tokens);
  }
  static cache::CheckpointPolicy policy(size_t maxCount = 4) {
    cache::CheckpointPolicy result;
    result.maxCount = maxCount;
    return result;
  }

  std::string path_;
};

} // namespace

TEST_F(CacheCheckpointFileTest, KeepsTheNewestCheckpointAfterTheState) {
  cache::Checkpoints checkpoints;
  checkpoints.push_back(checkpoint(4, 'a'));
  checkpoints.push_back(checkpoint(7, 'b'));

  ASSERT_TRUE(cache::appendCheckpointSection(path_, checkpoints));
  ASSERT_GT(fileSize(), stateEnd());
  {
    std::ifstream in(path_, std::ios::binary);
    std::string head(K_STATE.size(), '\0');
    in.read(head.data(), static_cast<std::streamsize>(head.size()));
    EXPECT_EQ(head, K_STATE) << "the section must not touch the state";
  }

  const cache::Checkpoints read =
      cache::readCheckpointSection(path_, stateEnd(), resident(), policy());
  ASSERT_EQ(read.size(), 1u) << "only the newest checkpoint is kept";
  EXPECT_EQ(read.front().ledger.entries, checkpoints.back().ledger.entries);
  EXPECT_EQ(read.front().state.nPast, 7);
  EXPECT_EQ(read.front().cacheTokens, 7);
  EXPECT_EQ(read.front().state.scope(), utils::SnapshotScope::Partial);
  EXPECT_EQ(read.front().state.buffer(), checkpoints.back().state.buffer());
}

TEST_F(CacheCheckpointFileTest, NoCheckpointLeavesTheFileUntouched) {
  EXPECT_TRUE(cache::appendCheckpointSection(path_, {}));
  cache::Checkpoints withoutPayload;
  withoutPayload.emplace_back();
  EXPECT_TRUE(cache::appendCheckpointSection(path_, withoutPayload));
  EXPECT_EQ(fileSize(), stateEnd());
  EXPECT_TRUE(
      cache::readCheckpointSection(path_, stateEnd(), resident(), policy())
          .empty());
}

TEST_F(CacheCheckpointFileTest, IgnoresADamagedSection) {
  cache::Checkpoints checkpoints;
  checkpoints.push_back(checkpoint(5, 'c'));
  ASSERT_TRUE(cache::appendCheckpointSection(path_, checkpoints));
  const uintmax_t complete = fileSize();

  // A changed nPast fails the checksum.
  {
    std::fstream io(path_, std::ios::binary | std::ios::in | std::ios::out);
    io.seekp(static_cast<std::streamoff>(stateEnd() + 12));
    const int32_t wrong = 3;
    io.write(reinterpret_cast<const char*>(&wrong), sizeof(wrong));
  }
  EXPECT_TRUE(
      cache::readCheckpointSection(path_, stateEnd(), resident(), policy())
          .empty());

  // A truncated section fails the size checks.
  ASSERT_TRUE(cache::appendCheckpointSection(path_, {}));
  fs::resize_file(path_, stateEnd());
  ASSERT_TRUE(cache::appendCheckpointSection(path_, checkpoints));
  fs::resize_file(path_, complete - 3);
  EXPECT_TRUE(
      cache::readCheckpointSection(path_, stateEnd(), resident(), policy())
          .empty());

  // Unknown bytes after the state are not a section.
  fs::resize_file(path_, stateEnd());
  {
    std::ofstream out(path_, std::ios::binary | std::ios::app);
    out << "trailing bytes from something else";
  }
  EXPECT_TRUE(
      cache::readCheckpointSection(path_, stateEnd(), resident(), policy())
          .empty());
}

TEST_F(CacheCheckpointFileTest, DropsACheckpointThatDoesNotMatchTheState) {
  cache::Checkpoints checkpoints;
  checkpoints.push_back(checkpoint(6, 'd'));
  ASSERT_TRUE(cache::appendCheckpointSection(path_, checkpoints));

  cache::Ledger other = resident();
  other.entries[2].identity = 999;
  EXPECT_TRUE(
      cache::readCheckpointSection(path_, stateEnd(), other, policy()).empty())
      << "a checkpoint is only valid on top of the state it was saved with";
}

TEST_F(CacheCheckpointFileTest, FollowsTheLoadingModelsPolicy) {
  cache::Checkpoints checkpoints;
  checkpoints.push_back(checkpoint(5, 'e'));
  ASSERT_TRUE(cache::appendCheckpointSection(path_, checkpoints));

  EXPECT_TRUE(
      cache::readCheckpointSection(path_, stateEnd(), resident(), policy(0))
          .empty())
      << "cache_checkpoints: 0 keeps none";

  cache::CheckpointPolicy onDisk = policy();
  onDisk.storage = utils::SnapshotStorage::Disk;
  onDisk.directory = fs::temp_directory_path().string();
  const cache::Checkpoints read =
      cache::readCheckpointSection(path_, stateEnd(), resident(), onDisk);
  ASSERT_EQ(read.size(), 1u);
  EXPECT_TRUE(read.front().state.hasFile());
  EXPECT_EQ(
      readAll(read.front().state.filePath()),
      checkpoints.back().state.buffer());
}

// The RAM tier writes cacheKey files itself; a conversation pushed out of a
// full tier keeps its newest checkpoint in the file like any other save.
TEST_F(CacheCheckpointFileTest, RamTierFileKeepsTheNewestCheckpoint) {
  using qvac_lib_inference_addon_llama::batching::SlotStateCache;
  using qvac_lib_inference_addon_llama::batching::SlotStateCacheEntry;
  SlotStateCacheEntry entry;
  entry.ledgerWords = cache::serialize(resident(), 12, 12);
  entry.state = std::vector<uint8_t>(64, 0x5a);
  entry.checkpoints.push_back(checkpoint(9, 'h'));
  ASSERT_TRUE(SlotStateCache::writeStateFile(path_, entry));

  const uint64_t sectionStart = 3 * sizeof(uint32_t) +
                                entry.ledgerWords.size() * sizeof(llama_token) +
                                entry.state.size();
  const cache::Checkpoints read =
      cache::readCheckpointSection(path_, sectionStart, resident(), policy());
  ASSERT_EQ(read.size(), 1u);
  EXPECT_EQ(read.front().state.nPast, 9);
  EXPECT_EQ(
      read.front().state.buffer(), entry.checkpoints.back().state.buffer());
}

TEST_F(CacheCheckpointFileTest, RefusesBytesAfterTheSection) {
  cache::Checkpoints first;
  first.push_back(checkpoint(3, 'f'));
  cache::Checkpoints second;
  second.push_back(checkpoint(8, 'g'));
  ASSERT_TRUE(cache::appendCheckpointSection(path_, first));
  const uintmax_t firstEnd = fileSize();
  ASSERT_TRUE(cache::appendCheckpointSection(path_, second));
  // The section ends the file: anything after it means the file is not what
  // this version wrote, so the reader keeps nothing rather than guessing.
  EXPECT_TRUE(
      cache::readCheckpointSection(path_, stateEnd(), resident(), policy())
          .empty());
  fs::resize_file(path_, firstEnd);
  EXPECT_EQ(
      cache::readCheckpointSection(path_, stateEnd(), resident(), policy())
          .size(),
      1u);
}

// The KV-cell count comes from the checkpoint's ledger, not from what the
// writer kept in memory: a text context leaves it at 0, and a multimodal
// context that loads its file must still see the cells the ledger occupies.
TEST_F(CacheCheckpointFileTest, CacheTokensComeFromTheLedger) {
  cache::Ledger ledger = cache::fromTokens({100, 101});
  ledger.entries.push_back(
      {.kind = cache::EntryKind::Media,
       .identity = 42,
       .positions = 2,
       .cacheTokens = 6});
  cache::Checkpoint written;
  written.ledger = ledger;
  written.cacheTokens = 0;
  written.state.adoptBuffer(std::vector<uint8_t>(40, 0x3c), 4);
  written.state.setScope(utils::SnapshotScope::Partial);
  cache::Checkpoints checkpoints;
  checkpoints.push_back(std::move(written));
  ASSERT_TRUE(cache::appendCheckpointSection(path_, checkpoints));

  cache::Ledger loaded = ledger;
  loaded.appendToken(102);
  const cache::Checkpoints read =
      cache::readCheckpointSection(path_, stateEnd(), loaded, policy());
  ASSERT_EQ(read.size(), 1u);
  EXPECT_EQ(read.front().state.nPast, 4);
  EXPECT_EQ(read.front().cacheTokens, 8)
      << "two text cells and the six cells of the media span";
}

// The payload has its own hash: a same-length change to the state bytes
// passes every size check and the section checksum, but is not restored.
TEST_F(CacheCheckpointFileTest, IgnoresAChangedPayload) {
  cache::Checkpoints checkpoints;
  checkpoints.push_back(checkpoint(5, 'p'));
  ASSERT_TRUE(cache::appendCheckpointSection(path_, checkpoints));
  ASSERT_EQ(
      cache::readCheckpointSection(path_, stateEnd(), resident(), policy())
          .size(),
      1u);

  // The last payload byte sits before the payload hash and the checksum.
  {
    std::fstream io(path_, std::ios::binary | std::ios::in | std::ios::out);
    io.seekp(
        static_cast<std::streamoff>(fileSize() - 2 * sizeof(uint64_t) - 1));
    io.put('q');
  }
  EXPECT_TRUE(
      cache::readCheckpointSection(path_, stateEnd(), resident(), policy())
          .empty());

  cache::CheckpointPolicy onDisk = policy();
  onDisk.storage = utils::SnapshotStorage::Disk;
  onDisk.directory = fs::temp_directory_path().string();
  EXPECT_TRUE(
      cache::readCheckpointSection(path_, stateEnd(), resident(), onDisk)
          .empty());
}

// Disk-backed checkpoints larger than one copy chunk go into the file and
// come back out byte for byte, into either storage.
TEST_F(CacheCheckpointFileTest, DiskCheckpointsRoundTripAcrossChunks) {
  std::vector<uint8_t> payload((5u << 20) / 2 + 17);
  for (size_t i = 0; i < payload.size(); ++i) {
    payload[i] = static_cast<uint8_t>(i * 31 + i / 4096);
  }
  cache::Checkpoint written = checkpoint(6, 'x');
  written.state = diskSnapshot(payload, 6);
  ASSERT_TRUE(written.state.hasFile());
  cache::Checkpoints checkpoints;
  checkpoints.push_back(std::move(written));
  ASSERT_TRUE(cache::appendCheckpointSection(path_, checkpoints));

  const cache::Checkpoints inMemory =
      cache::readCheckpointSection(path_, stateEnd(), resident(), policy());
  ASSERT_EQ(inMemory.size(), 1u);
  EXPECT_EQ(inMemory.front().state.buffer(), payload);

  cache::CheckpointPolicy onDisk = policy();
  onDisk.storage = utils::SnapshotStorage::Disk;
  onDisk.directory = fs::temp_directory_path().string();
  const cache::Checkpoints onFile =
      cache::readCheckpointSection(path_, stateEnd(), resident(), onDisk);
  ASSERT_EQ(onFile.size(), 1u);
  ASSERT_TRUE(onFile.front().state.hasFile());
  EXPECT_EQ(onFile.front().state.bytes(), payload.size());
  EXPECT_EQ(readAll(onFile.front().state.filePath()), payload);
}

// A checkpoint that cannot be written leaves the file holding the state only,
// so the save itself still succeeds.
TEST_F(CacheCheckpointFileTest, FailedAppendCutsTheFileBackToTheState) {
  cache::Checkpoint written = checkpoint(4, 'y');
  written.state = diskSnapshot(std::vector<uint8_t>(64, 0x11), 4);
  ASSERT_TRUE(written.state.hasFile());
  fs::remove(written.state.filePath());
  cache::Checkpoints checkpoints;
  checkpoints.push_back(std::move(written));

  EXPECT_FALSE(cache::appendCheckpointSection(path_, checkpoints));
  EXPECT_EQ(fileSize(), stateEnd());
  EXPECT_TRUE(
      cache::readCheckpointSection(path_, stateEnd(), resident(), policy())
          .empty());
}

namespace {

class CacheFileIndexTest : public ::testing::Test {
protected:
  void SetUp() override {
    dir_ =
        fs::temp_directory_path() /
        ("qvac_cache_file_index_" +
         std::to_string(::testing::UnitTest::GetInstance()->random_seed()) +
         "_" + ::testing::UnitTest::GetInstance()->current_test_info()->name());
    fs::create_directories(dir_);
  }
  void TearDown() override {
    std::error_code ec;
    fs::remove_all(dir_, ec);
  }

  // Writes a cacheKey file whose state is `tokens`, as the RAM tier does.
  [[nodiscard]] std::string
  write(const std::string& name, const std::vector<llama_token>& tokens) const {
    using qvac_lib_inference_addon_llama::batching::SlotStateCache;
    using qvac_lib_inference_addon_llama::batching::SlotStateCacheEntry;
    SlotStateCacheEntry entry;
    const auto count = static_cast<llama_pos>(tokens.size());
    entry.ledgerWords =
        cache::serialize(cache::fromTokens(tokens), count, count);
    entry.state = std::vector<uint8_t>(16, 0x11);
    const std::string path = (dir_ / name).string();
    EXPECT_TRUE(SlotStateCache::writeStateFile(path, entry));
    return path;
  }

  fs::path dir_;
};

} // namespace

// Only files a request named are candidates, the longest shared prefix wins,
// and the request's own file is left out.
TEST_F(CacheFileIndexTest, FindsTheNotedFileWithTheLongestPrefix) {
  cache::CacheFileIndex index;
  const std::string shortFile = write("short.bin", {1, 2});
  const std::string longFile = write("long.bin", {1, 2, 3, 7});
  const std::string unnoted = write("unnoted.bin", {1, 2, 3, 4, 5});
  index.note(shortFile);
  index.note(longFile);
  // Noted before it exists: skipped until it is written.
  index.note((dir_ / "later.bin").string());

  const cache::Ledger prompt = cache::fromTokens({1, 2, 3, 4, 5, 6});
  auto match = index.longestPrefix(prompt, true, "");
  ASSERT_TRUE(match.has_value());
  EXPECT_EQ(match->path, longFile);
  EXPECT_EQ(match->reusable, 3u);

  match = index.longestPrefix(prompt, true, longFile);
  ASSERT_TRUE(match.has_value());
  EXPECT_EQ(match->path, shortFile);

  // Untrimmable memory: only a state that is a prefix of the prompt serves.
  match = index.longestPrefix(prompt, false, "");
  ASSERT_TRUE(match.has_value());
  EXPECT_EQ(match->path, shortFile);
  EXPECT_EQ(match->reusable, 2u);

  const std::string later = write("later.bin", {1, 2, 3, 4});
  match = index.longestPrefix(prompt, true, "");
  ASSERT_TRUE(match.has_value());
  EXPECT_EQ(match->path, later);
  EXPECT_EQ(match->reusable, 4u);
  (void)unnoted;
}

// A rewritten file is read again and a deleted one stops being a candidate;
// a match carries the ledger words it was read with.
TEST_F(CacheFileIndexTest, FollowsRewrittenAndDeletedFiles) {
  cache::CacheFileIndex index;
  const std::string path = write("conversation.bin", {1, 2, 3});
  index.note(path);
  const cache::Ledger prompt = cache::fromTokens({1, 2, 3, 4, 5});
  auto match = index.longestPrefix(prompt, true, "");
  ASSERT_TRUE(match.has_value());
  EXPECT_EQ(match->reusable, 3u);
  EXPECT_EQ(
      cache::deserialize(match->words.data(), match->words.size()).nPast, 3);

  (void)write("conversation.bin", {1, 2, 3, 4, 9, 9});
  ASSERT_EQ(index.longestPrefix(prompt, true, "")->reusable, 4u);

  fs::remove(path);
  EXPECT_FALSE(index.longestPrefix(prompt, true, "").has_value());
}

// A file that failed to load is skipped until it is written again, instead of
// being loaded by every request.
TEST_F(CacheFileIndexTest, SkipsAFileThatFailedToLoadUntilItChanges) {
  cache::CacheFileIndex index;
  const std::string path = write("broken.bin", {1, 2, 3});
  index.note(path);
  const cache::Ledger prompt = cache::fromTokens({1, 2, 3, 4, 5});
  ASSERT_TRUE(index.longestPrefix(prompt, true, "").has_value());

  index.markUnusable(path);
  EXPECT_FALSE(index.longestPrefix(prompt, true, "").has_value());

  (void)write("broken.bin", {1, 2, 3, 4});
  const auto match = index.longestPrefix(prompt, true, "");
  ASSERT_TRUE(match.has_value()) << "the rewritten file stayed skipped";
  EXPECT_EQ(match->reusable, 4u);
}

// Files in another format share nothing, and the index stays bounded.
TEST_F(CacheFileIndexTest, IgnoresForeignFilesAndStaysBounded) {
  const std::string foreign = (dir_ / "foreign.bin").string();
  {
    std::ofstream out(foreign, std::ios::binary);
    out << "not a cache file";
  }
  EXPECT_FALSE(cache::CacheFileIndex::readLedgerWords(foreign).has_value());

  cache::CacheFileIndex index;
  index.note(foreign);
  EXPECT_FALSE(
      index.longestPrefix(cache::fromTokens({1}), true, "").has_value());

  for (size_t i = 0; i < cache::CacheFileIndex::MAX_FILES + 10; ++i) {
    index.note((dir_ / ("k" + std::to_string(i))).string());
  }
  EXPECT_EQ(index.size(), cache::CacheFileIndex::MAX_FILES);
}
