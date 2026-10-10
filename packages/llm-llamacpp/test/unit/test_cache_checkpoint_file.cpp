#include <cstdint>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/CacheCheckpointFile.hpp"
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
    EXPECT_TRUE(
        utils::partialSnapshotFromPayload(
            std::vector<uint8_t>(32 + tokens, static_cast<uint8_t>(fill)),
            static_cast<llama_pos>(tokens),
            utils::SnapshotStorage::Memory,
            {},
            result.state));
    return result;
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
  std::vector<uint8_t> payload;
  ASSERT_TRUE(utils::readPartialSnapshotPayload(read.front().state, payload));
  EXPECT_EQ(payload, checkpoints.back().state.buffer());
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

  const uint64_t stateEnd = 3 * sizeof(uint32_t) +
                            entry.ledgerWords.size() * sizeof(llama_token) +
                            entry.state.size();
  const cache::Checkpoints read =
      cache::readCheckpointSection(path_, stateEnd, resident(), policy());
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
