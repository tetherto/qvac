#include <deque>
#include <stdexcept>
#include <string>
#include <unordered_map>

#include <gtest/gtest.h>

#include "model-interface/CacheLedger.hpp"
#include "utils/ModelMemoryPolicy.hpp"

namespace cache = qvac_lib_inference_addon_llama::cache;

TEST(CacheLedger, FindsExactTokenAndMediaPrefix) {
  cache::Ledger cached = cache::fromTokens({1, 2});
  cached.entries.push_back(
      {.kind = cache::EntryKind::Media,
       .identity = 42,
       .positions = 8,
       .cacheTokens = 16});
  cached.appendToken(3);

  cache::Ledger edited = cached;
  edited.entries.back().identity = 9;

  EXPECT_EQ(cache::commonPrefix(cached, edited), 3u);
  EXPECT_EQ(cached.positions(3), 10);
  EXPECT_EQ(cached.cacheTokens(3), 18);
}

TEST(CacheLedger, RoundTripsVersionedPayload) {
  cache::Ledger ledger = cache::fromTokens({7, -3});
  ledger.entries.push_back(
      {.kind = cache::EntryKind::Media,
       .identity = static_cast<int64_t>(0xfedcba9876543210ULL),
       .positions = 4,
       .cacheTokens = 12});

  const auto encoded = cache::serialize(ledger, 6, 14);
  const auto decoded = cache::deserialize(encoded.data(), encoded.size());

  EXPECT_EQ(decoded.nPast, 6);
  EXPECT_EQ(decoded.cacheTokens, 14);
  EXPECT_EQ(decoded.ledger.entries, ledger.entries);
}

TEST(CacheLedger, RejectsMarkedCorruption) {
  cache::Ledger ledger = cache::fromTokens({1, 2, 3});
  auto encoded = cache::serialize(ledger, 3, 3);
  encoded.back() ^= 1;
  EXPECT_THROW(
      (void)cache::deserialize(encoded.data(), encoded.size()),
      std::runtime_error);
}

// Two spans near INT32_MAX must not wrap the int32 totals into a value that
// matches the header: the sum is checked in 64 bits.
TEST(CacheLedger, RejectsSpansThatOverflowTheTotals) {
  cache::Ledger ledger;
  for (const llama_pos span : {INT32_MAX - 10, 20}) {
    ledger.entries.push_back(
        {.kind = cache::EntryKind::Media,
         .identity = 7,
         .positions = span,
         .cacheTokens = span});
  }
  const auto encoded = cache::serialize(ledger, INT32_MAX, INT32_MAX);
  EXPECT_THROW(
      (void)cache::deserialize(encoded.data(), encoded.size()),
      std::runtime_error);
}

TEST(CacheLedger, RejectsTokensOutsideTheVocab) {
  cache::Ledger ledger = cache::fromTokens({1, 5, 100});
  ledger.entries.push_back(
      {.kind = cache::EntryKind::Media,
       .identity = 123456789,
       .positions = 4,
       .cacheTokens = 4});
  EXPECT_NO_THROW(cache::requireTokensInVocab(ledger, 101));
  EXPECT_THROW(cache::requireTokensInVocab(ledger, 100), std::runtime_error);
  cache::Ledger negative = cache::fromTokens({-1});
  EXPECT_THROW(cache::requireTokensInVocab(negative, 100), std::runtime_error);
}

TEST(CacheLedger, RecognizesLegacyPayloadAsUnmarked) {
  const llama_token legacy[] = {12, 12, 12, 12};
  EXPECT_FALSE(cache::hasMarker(legacy, std::size(legacy)));
}

TEST(CacheLedger, ReasoningIsRemovedLazilyByTheNextRenderedPrompt) {
  const cache::Ledger resident = cache::fromTokens({10, 20, 30, 40});
  const cache::Ledger omittedReasoning = cache::fromTokens({10, 20, 40, 50});
  const cache::Ledger preservedReasoning =
      cache::fromTokens({10, 20, 30, 40, 50});

  EXPECT_EQ(cache::commonPrefix(resident, omittedReasoning), 2u)
      << "omitting generated reasoning makes ordinary prefix reconciliation "
         "rewind to the first reasoning token";
  EXPECT_EQ(cache::commonPrefix(resident, preservedReasoning), 4u)
      << "an explicitly preserved reasoning span remains reusable";
}

namespace {
struct FakeCheckpoint {
  int id = 0;
  uint64_t bytes = 0;
};
const auto kBytesOf = [](const FakeCheckpoint& c) { return c.bytes; };
using qvac_lib_inference_addon_llama::utils::SnapshotStorage;
} // namespace

TEST(CacheLedger, ProcessCheckpointCollectionEvictsOldestFirst) {
  std::deque<FakeCheckpoint> checkpoints;
  cache::CheckpointPolicy four;
  four.maxCount = 4;
  for (int i = 0; i < 7; ++i) {
    cache::appendProcessCheckpoint(
        checkpoints, FakeCheckpoint{i, 1}, four, kBytesOf);
  }

  ASSERT_EQ(checkpoints.size(), 4u);
  EXPECT_EQ(checkpoints.front().id, 3);
  EXPECT_EQ(checkpoints.back().id, 6);
}

// The default keeps the end-of-history checkpoint of the last committed
// request: each commit pushes one and drops the one before.
TEST(CacheLedger, DefaultPolicyKeepsTheLastCheckpoint) {
  EXPECT_EQ(cache::DEFAULT_PROCESS_CHECKPOINTS, 1u);
  std::deque<FakeCheckpoint> checkpoints;
  for (int id = 1; id <= 4; ++id) {
    cache::appendProcessCheckpoint(
        checkpoints,
        FakeCheckpoint{id, 1},
        cache::CheckpointPolicy{},
        kBytesOf);
  }
  ASSERT_EQ(checkpoints.size(), 1u);
  EXPECT_EQ(checkpoints.front().id, 4);
}

TEST(CacheLedger, ProcessCheckpointCollectionHonoursConfiguredCount) {
  cache::CheckpointPolicy three;
  three.maxCount = 3;
  std::deque<FakeCheckpoint> checkpoints;
  for (int i = 0; i < 10; ++i) {
    cache::appendProcessCheckpoint(
        checkpoints, FakeCheckpoint{i, 1}, three, kBytesOf);
  }
  ASSERT_EQ(checkpoints.size(), 3u);
  EXPECT_EQ(checkpoints.front().id, 7);
  EXPECT_EQ(checkpoints.back().id, 9);

  cache::CheckpointPolicy none;
  none.maxCount = 0;
  std::deque<FakeCheckpoint> empty;
  cache::appendProcessCheckpoint(empty, FakeCheckpoint{1, 1}, none, kBytesOf);
  EXPECT_TRUE(empty.empty()) << "a count of 0 must keep no checkpoints";
}

TEST(CacheLedger, ProcessCheckpointByteBudgetTakesPriorityOverCount) {
  cache::CheckpointPolicy policy;
  policy.maxCount = 10;
  policy.maxBytes = 250;
  std::deque<FakeCheckpoint> checkpoints;
  for (int i = 0; i < 5; ++i) {
    cache::appendProcessCheckpoint(
        checkpoints, FakeCheckpoint{i, 100}, policy, kBytesOf);
  }
  // 250 bytes hold two 100-byte checkpoints even though the count allows 10.
  ASSERT_EQ(checkpoints.size(), 2u);
  EXPECT_EQ(checkpoints.front().id, 3);
  EXPECT_EQ(checkpoints.back().id, 4);

  // A single checkpoint larger than the whole budget is evicted at once.
  cache::appendProcessCheckpoint(
      checkpoints, FakeCheckpoint{5, 1000}, policy, kBytesOf);
  EXPECT_TRUE(checkpoints.empty());

  // maxBytes == 0 means unlimited: only the count applies.
  cache::CheckpointPolicy unlimited;
  unlimited.maxCount = 2;
  std::deque<FakeCheckpoint> byCount;
  for (int i = 0; i < 3; ++i) {
    cache::appendProcessCheckpoint(
        byCount, FakeCheckpoint{i, 1u << 30}, unlimited, kBytesOf);
  }
  EXPECT_EQ(byCount.size(), 2u);
}

TEST(CacheLedger, ParseCheckpointPolicyDefaultsWhenAbsent) {
  std::unordered_map<std::string, std::string> config{{"ctx_size", "4096"}};
  const cache::CheckpointPolicy policy = cache::parseCheckpointPolicy(config);
  EXPECT_EQ(policy.maxCount, cache::DEFAULT_PROCESS_CHECKPOINTS);
  EXPECT_EQ(policy.maxBytes, 0u);
  EXPECT_EQ(policy.storage, SnapshotStorage::Memory);
  EXPECT_EQ(config.size(), 1u) << "unrelated keys must be left alone";
}

TEST(CacheLedger, ParseCheckpointPolicyConsumesEverySpelling) {
  std::unordered_map<std::string, std::string> config{
      {"cache_checkpoints", "4"},
      {"cache-checkpoints-max-bytes", "1073741824"},
      {"cache_checkpoint_storage", "memory"},
      {"ctx_size", "4096"}};
  const cache::CheckpointPolicy policy = cache::parseCheckpointPolicy(config);
  EXPECT_EQ(policy.maxCount, 4u);
  EXPECT_EQ(policy.maxBytes, 1073741824u);
  EXPECT_EQ(policy.storage, SnapshotStorage::Memory);
  EXPECT_EQ(config.size(), 1u)
      << "every checkpoint key must be consumed so llama.cpp's parser never "
         "sees it";

  std::unordered_map<std::string, std::string> dashed{
      {"cache-checkpoints", "0"},
      {"cache-checkpoint-storage", "disk"},
      {"cache-checkpoint-dir", "/tmp"}};
  const cache::CheckpointPolicy zero = cache::parseCheckpointPolicy(dashed);
  EXPECT_EQ(zero.maxCount, 0u);
  EXPECT_EQ(zero.storage, SnapshotStorage::Disk);
  EXPECT_TRUE(dashed.empty());

  std::unordered_map<std::string, std::string> max{
      {"cache_checkpoints", "1024"}};
  EXPECT_EQ(cache::parseCheckpointPolicy(max).maxCount, 1024u);
}

TEST(CacheLedger, ParseCheckpointPolicyRejectsBadValues) {
  for (const char* bad : {"-1", "1025", "four", "", " 4", "4x"}) {
    std::unordered_map<std::string, std::string> config{
        {"cache_checkpoints", bad}};
    EXPECT_THROW(cache::parseCheckpointPolicy(config), std::invalid_argument)
        << "cache_checkpoints value: \"" << bad << "\"";
  }
  for (const char* bad : {"-1", "1MB", "", "1e9"}) {
    std::unordered_map<std::string, std::string> config{
        {"cache_checkpoints_max_bytes", bad}};
    EXPECT_THROW(cache::parseCheckpointPolicy(config), std::invalid_argument)
        << "cache_checkpoints_max_bytes value: \"" << bad << "\"";
  }
  for (const char* bad : {"ram", "Disk", "", "file"}) {
    std::unordered_map<std::string, std::string> config{
        {"cache_checkpoint_storage", bad}};
    EXPECT_THROW(cache::parseCheckpointPolicy(config), std::invalid_argument)
        << "cache_checkpoint_storage value: \"" << bad << "\"";
  }

  std::unordered_map<std::string, std::string> both{
      {"cache_checkpoints", "4"}, {"cache-checkpoints", "4"}};
  EXPECT_THROW(cache::parseCheckpointPolicy(both), std::invalid_argument)
      << "both spellings at once must be rejected like flash-attn";
}

// `cache_checkpoint_dir` goes with disk storage both ways: `disk` requires it
// (there is no OS temp dir default), and it is refused without `disk` rather
// than silently ignored.
TEST(CacheLedger, ParseCheckpointDirIsRequiredExactlyWithDisk) {
  std::unordered_map<std::string, std::string> disk{
      {"cache_checkpoint_storage", "disk"},
      {"cache-checkpoint-dir", "/data/user/0/app/cache"}};
  const cache::CheckpointPolicy policy = cache::parseCheckpointPolicy(disk);
  EXPECT_EQ(policy.storage, SnapshotStorage::Disk);
  EXPECT_EQ(policy.directory, "/data/user/0/app/cache");
  EXPECT_TRUE(disk.empty());

  std::unordered_map<std::string, std::string> none;
  EXPECT_TRUE(cache::parseCheckpointPolicy(none).directory.empty());

  std::unordered_map<std::string, std::string> memory{
      {"cache_checkpoint_dir", "/tmp/x"}};
  EXPECT_THROW(cache::parseCheckpointPolicy(memory), std::invalid_argument);

  std::unordered_map<std::string, std::string> empty{
      {"cache_checkpoint_storage", "disk"}, {"cache_checkpoint_dir", ""}};
  EXPECT_THROW(cache::parseCheckpointPolicy(empty), std::invalid_argument);

  std::unordered_map<std::string, std::string> diskOnly{
      {"cache_checkpoint_storage", "disk"}};
  try {
    (void)cache::parseCheckpointPolicy(diskOnly);
    ADD_FAILURE() << "disk storage without cache_checkpoint_dir was accepted";
  } catch (const std::invalid_argument& e) {
    EXPECT_NE(
        std::string(e.what()).find("cache_checkpoint_dir"), std::string::npos)
        << e.what();
  }
}

// Every untrimmable model, DeepSeek V4 included, snapshots only the state a
// tail trim cannot rebuild.
TEST(ModelMemoryPolicy, UntrimmableModelsSnapshotPartially) {
  namespace utils = qvac_lib_inference_addon_llama::utils;
  EXPECT_TRUE(utils::needsFullStateSnapshot(false, false, true));
  EXPECT_FALSE(utils::needsFullStateSnapshot(false, false, false));
  EXPECT_EQ(utils::untrimmableSnapshotScope(), utils::SnapshotScope::Partial);
}
