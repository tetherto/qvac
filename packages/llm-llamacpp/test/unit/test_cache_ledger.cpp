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

TEST(CacheLedger, ProcessCheckpointCollectionEvictsOldestFirst) {
  std::deque<int> checkpoints;
  for (int i = 0; i < 35; ++i) {
    cache::appendProcessCheckpoint(checkpoints, i);
  }

  ASSERT_EQ(checkpoints.size(), cache::MAX_PROCESS_CHECKPOINTS);
  EXPECT_EQ(checkpoints.front(), 3);
  EXPECT_EQ(checkpoints.back(), 34);
}
