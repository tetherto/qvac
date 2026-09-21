#include <deque>
#include <stdexcept>
#include <string>
#include <unordered_map>

#include <gtest/gtest.h>

#include "model-interface/CacheLedger.hpp"

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
  for (int i = 0; i < 35; ++i) {
    cache::appendProcessCheckpoint(
        checkpoints, FakeCheckpoint{i, 1}, cache::CheckpointPolicy{}, kBytesOf);
  }

  ASSERT_EQ(checkpoints.size(), cache::DEFAULT_PROCESS_CHECKPOINTS);
  EXPECT_EQ(checkpoints.front().id, 3);
  EXPECT_EQ(checkpoints.back().id, 34);
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
  EXPECT_EQ(policy.storage, SnapshotStorage::Disk);
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
      {"cache-checkpoints", "0"}, {"cache-checkpoint-storage", "disk"}};
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
