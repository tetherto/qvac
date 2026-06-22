#include <string>
#include <thread>
#include <vector>

#include <gtest/gtest.h>

#include "utils/VisionPrefixCache.hpp"

using namespace qvac_lib_inference_addon_llama;

namespace {

VisionCacheEntry makeEntry(std::size_t nFloats) {
  VisionCacheEntry e;
  e.embeddings.resize(nFloats, 1.0f);
  e.nTokens = nFloats / 64;
  e.nPos = static_cast<int32_t>(e.nTokens);
  return e;
}

std::size_t bytesOf(std::size_t nFloats) { return nFloats * sizeof(float); }

} // namespace

class VisionPrefixCacheTest : public ::testing::Test {
protected:
  static constexpr std::size_t k1MB = 1024 * 1024;
};

TEST_F(VisionPrefixCacheTest, PutAndGetBasic) {
  VisionPrefixCache cache(k1MB);
  auto entry = makeEntry(256);
  ASSERT_TRUE(cache.put("img1", std::move(entry)));

  auto result = cache.get("img1");
  ASSERT_TRUE(result != nullptr);
  EXPECT_EQ(result->embeddings.size(), 256u);
  EXPECT_EQ(result->nTokens, 4u);
}

TEST_F(VisionPrefixCacheTest, GetMissReturnsNullopt) {
  VisionPrefixCache cache(k1MB);
  auto result = cache.get("nonexistent");
  EXPECT_FALSE(result != nullptr);
}

TEST_F(VisionPrefixCacheTest, GetEmptyKeyReturnsNullopt) {
  VisionPrefixCache cache(k1MB);
  auto result = cache.get("");
  EXPECT_FALSE(result != nullptr);
}

TEST_F(VisionPrefixCacheTest, PutEmptyKeyRejected) {
  VisionPrefixCache cache(k1MB);
  EXPECT_FALSE(cache.put("", makeEntry(256)));
}

TEST_F(VisionPrefixCacheTest, PutZeroBudgetRejected) {
  VisionPrefixCache cache(0);
  EXPECT_FALSE(cache.put("img1", makeEntry(256)));
}

TEST_F(VisionPrefixCacheTest, PutOversizedEntryRejected) {
  VisionPrefixCache cache(100);
  auto entry = makeEntry(256);
  EXPECT_GT(entry.sizeBytes(), 100u);
  EXPECT_FALSE(cache.put("img1", std::move(entry)));
}

TEST_F(VisionPrefixCacheTest, UpdateOversizedEntryRejectedKeepsExisting) {
  const std::size_t budget = bytesOf(512);
  VisionPrefixCache cache(budget);
  ASSERT_TRUE(cache.put("a", makeEntry(256)));
  const auto before = cache.stats();

  // Update existing key "a" with an entry whose size alone exceeds budget:
  // the early guard must reject it before mutating any state (the guard runs
  // before the find, so it covers the update path as well as the insert path).
  EXPECT_FALSE(cache.put("a", makeEntry(1024)));

  // Existing entry intact; byte accounting and eviction counter unchanged.
  auto got = cache.get("a");
  ASSERT_TRUE(got != nullptr);
  EXPECT_EQ(got->embeddings.size(), 256u);
  const auto after = cache.stats();
  EXPECT_EQ(after.currentBytes, bytesOf(256));
  EXPECT_EQ(after.evictions, before.evictions);
}

TEST_F(VisionPrefixCacheTest, LruEvictionOnInsert) {
  const std::size_t budget = bytesOf(512);
  VisionPrefixCache cache(budget);

  ASSERT_TRUE(cache.put("a", makeEntry(256)));
  ASSERT_TRUE(cache.put("b", makeEntry(256)));

  // Cache is full (256+256 floats = budget). Inserting "c" should evict "a".
  ASSERT_TRUE(cache.put("c", makeEntry(256)));

  EXPECT_FALSE(cache.get("a") != nullptr);
  EXPECT_TRUE(cache.get("b") != nullptr);
  EXPECT_TRUE(cache.get("c") != nullptr);
}

TEST_F(VisionPrefixCacheTest, LruTouchPromotesMru) {
  const std::size_t budget = bytesOf(512);
  VisionPrefixCache cache(budget);

  ASSERT_TRUE(cache.put("a", makeEntry(256)));
  ASSERT_TRUE(cache.put("b", makeEntry(256)));

  // Touch "a" to make it MRU.
  cache.get("a");

  // Inserting "c" should evict "b" (now LRU), not "a".
  ASSERT_TRUE(cache.put("c", makeEntry(256)));

  EXPECT_TRUE(cache.get("a") != nullptr);
  EXPECT_FALSE(cache.get("b") != nullptr);
  EXPECT_TRUE(cache.get("c") != nullptr);
}

TEST_F(VisionPrefixCacheTest, UpdatePathEvictsWhenOverBudget) {
  const std::size_t budget = bytesOf(512);
  VisionPrefixCache cache(budget);

  ASSERT_TRUE(cache.put("a", makeEntry(128)));
  ASSERT_TRUE(cache.put("b", makeEntry(128)));
  // currentBytes = bytesOf(256), budget = bytesOf(512). Room left.

  // Update "a" with a larger entry that pushes total over budget.
  ASSERT_TRUE(cache.put("a", makeEntry(448)));
  // Without eviction: 448+128 = 576 floats > 512 budget.
  // "b" should be evicted to make room.

  auto s = cache.stats();
  EXPECT_LE(s.currentBytes, budget);
  EXPECT_TRUE(cache.get("a") != nullptr);
  EXPECT_FALSE(cache.get("b") != nullptr);
  EXPECT_GT(s.evictions, 0u);
}

TEST_F(VisionPrefixCacheTest, UpdateSameSizeNoBudgetExceedance) {
  const std::size_t budget = bytesOf(512);
  VisionPrefixCache cache(budget);

  ASSERT_TRUE(cache.put("a", makeEntry(256)));
  ASSERT_TRUE(cache.put("b", makeEntry(256)));

  // Update "a" with same-size entry — no eviction needed.
  auto replacement = makeEntry(256);
  replacement.embeddings[0] = 42.0f;
  ASSERT_TRUE(cache.put("a", std::move(replacement)));

  EXPECT_TRUE(cache.get("a") != nullptr);
  EXPECT_TRUE(cache.get("b") != nullptr);
  EXPECT_EQ(cache.get("a")->embeddings[0], 42.0f);
  EXPECT_EQ(cache.stats().evictions, 0u);
}

TEST_F(VisionPrefixCacheTest, StatsCountHitsAndMisses) {
  VisionPrefixCache cache(k1MB);
  cache.put("a", makeEntry(64));

  cache.get("a");
  cache.get("a");
  cache.get("missing");

  auto s = cache.stats();
  EXPECT_EQ(s.hits, 2u);
  EXPECT_EQ(s.misses, 1u);
}

TEST_F(VisionPrefixCacheTest, DistinctImagesTracked) {
  VisionPrefixCache cache(k1MB);
  cache.put("img1", makeEntry(64));
  cache.put("img2", makeEntry(64));
  cache.put("img1", makeEntry(64)); // update, not new distinct

  EXPECT_EQ(cache.stats().distinctImages, 2u);
}

TEST_F(VisionPrefixCacheTest, DistinctImagesResetByClearStats) {
  VisionPrefixCache cache(k1MB);
  cache.put("img1", makeEntry(64));
  cache.put("img2", makeEntry(64));
  EXPECT_EQ(cache.stats().distinctImages, 2u);

  cache.clearStats();
  EXPECT_EQ(cache.stats().distinctImages, 0u);

  cache.put("img3", makeEntry(64));
  EXPECT_EQ(cache.stats().distinctImages, 1u);
}

TEST_F(VisionPrefixCacheTest, StatsCountEvictions) {
  const std::size_t budget = bytesOf(256);
  VisionPrefixCache cache(budget);

  cache.put("a", makeEntry(256));
  cache.put("b", makeEntry(256));

  auto s = cache.stats();
  EXPECT_EQ(s.evictions, 1u);
}

TEST_F(VisionPrefixCacheTest, PeakBytesTracked) {
  const std::size_t budget = bytesOf(512);
  VisionPrefixCache cache(budget);

  cache.put("a", makeEntry(256));
  cache.put("b", makeEntry(256));
  // Peak = bytesOf(512)

  auto peakBefore = cache.stats().peakBytes;
  EXPECT_EQ(peakBefore, bytesOf(512));

  // Evict all by inserting a large entry.
  cache.put("c", makeEntry(512));
  EXPECT_EQ(cache.stats().peakBytes, bytesOf(512));
}

TEST_F(VisionPrefixCacheTest, ClearDataPreservesStats) {
  VisionPrefixCache cache(k1MB);
  cache.put("a", makeEntry(64));
  cache.get("a");
  cache.get("missing");

  cache.clearData();

  EXPECT_FALSE(cache.get("a") != nullptr);
  auto s = cache.stats();
  EXPECT_EQ(s.currentBytes, 0u);
  // Before clearData: get("a")=hit, get("missing")=miss.
  // After clearData: get("a")=miss. Total: 1 hit, 2 misses.
  EXPECT_EQ(s.hits, 1u);
  EXPECT_EQ(s.misses, 2u);
}

TEST_F(VisionPrefixCacheTest, ClearStatsPreservesData) {
  VisionPrefixCache cache(k1MB);
  cache.put("a", makeEntry(64));
  cache.get("a");

  cache.clearStats();

  auto result = cache.get("a");
  ASSERT_TRUE(result != nullptr);
  auto s = cache.stats();
  EXPECT_EQ(s.hits, 1u);
  EXPECT_EQ(s.misses, 0u);
  EXPECT_EQ(s.evictions, 0u);
}

TEST_F(VisionPrefixCacheTest, ClearResetsEverythingExceptPeakBytes) {
  VisionPrefixCache cache(k1MB);
  cache.put("a", makeEntry(256));
  cache.get("a");

  std::size_t peakBefore = cache.stats().peakBytes;
  EXPECT_GT(peakBefore, 0u);

  cache.clear();

  auto s = cache.stats();
  EXPECT_EQ(s.currentBytes, 0u);
  EXPECT_EQ(s.hits, 0u);
  EXPECT_EQ(s.misses, 0u);
  EXPECT_EQ(s.evictions, 0u);
  EXPECT_EQ(s.peakBytes, peakBefore);
  EXPECT_FALSE(cache.get("a") != nullptr);
}

TEST_F(VisionPrefixCacheTest, OnMemoryWarningClearsEntries) {
  VisionPrefixCache cache(k1MB);
  cache.put("a", makeEntry(64));
  cache.put("b", makeEntry(64));

  cache.onMemoryWarning();

  EXPECT_FALSE(cache.get("a") != nullptr);
  EXPECT_FALSE(cache.get("b") != nullptr);
  EXPECT_EQ(cache.stats().currentBytes, 0u);
}

TEST_F(VisionPrefixCacheTest, OnMemoryWarningFromAnotherThread) {
  VisionPrefixCache cache(k1MB);
  cache.put("a", makeEntry(256));

  std::thread warningThread([&cache]() { cache.onMemoryWarning(); });
  warningThread.join();

  EXPECT_FALSE(cache.get("a") != nullptr);
  EXPECT_EQ(cache.stats().currentBytes, 0u);
}

TEST_F(VisionPrefixCacheTest, BudgetBytesAccessor) {
  VisionPrefixCache cache(42);
  EXPECT_EQ(cache.budgetBytes(), 42u);
}

TEST_F(VisionPrefixCacheTest, DefaultBudget) {
  VisionPrefixCache cache;
  EXPECT_EQ(cache.budgetBytes(), 100ULL * 1024 * 1024);
}

TEST_F(VisionPrefixCacheTest, GetReturnsSharedImmutableEntry) {
  VisionPrefixCache cache(k1MB);
  cache.put("a", makeEntry(64));

  auto ptr1 = cache.get("a");
  ASSERT_TRUE(ptr1 != nullptr);

  auto ptr2 = cache.get("a");
  ASSERT_TRUE(ptr2 != nullptr);

  // Both calls return shared_ptrs to the same immutable entry.
  EXPECT_EQ(ptr1.get(), ptr2.get());
  EXPECT_EQ(ptr1->embeddings.size(), 64u);
}

TEST_F(VisionPrefixCacheTest, MakeVisionCacheKeyPrefixBasic) {
  auto prefix = makeVisionCacheKeyPrefix("/model.gguf", "/proj.gguf");
  EXPECT_FALSE(prefix.empty());
  EXPECT_EQ(prefix.back(), '|');
}

TEST_F(VisionPrefixCacheTest, MakeVisionCacheKeyPrefixDistinct) {
  auto p1 = makeVisionCacheKeyPrefix("/a", "/b");
  auto p2 = makeVisionCacheKeyPrefix("/a|/b", "");
  EXPECT_NE(p1, p2);
}

TEST_F(VisionPrefixCacheTest, MakeVisionCacheKeyPrefixEmptyPaths) {
  auto prefix = makeVisionCacheKeyPrefix("", "");
  EXPECT_TRUE(prefix.empty());
}

TEST_F(VisionPrefixCacheTest, Sha256OfBytesEmpty) {
  auto result = sha256OfBytes(nullptr, 0);
  EXPECT_TRUE(result.empty());
}

TEST_F(VisionPrefixCacheTest, Sha256OfBytesProducesHex) {
  std::vector<uint8_t> data = {0x48, 0x65, 0x6C, 0x6C, 0x6F};
  auto hash = sha256OfBytes(data);
  EXPECT_EQ(hash.size(), 64u);
  for (char c : hash) {
    EXPECT_TRUE((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'));
  }
}

TEST_F(VisionPrefixCacheTest, Sha256OfBytesDeterministic) {
  std::vector<uint8_t> data = {1, 2, 3, 4, 5};
  auto hash1 = sha256OfBytes(data);
  auto hash2 = sha256OfBytes(data);
  EXPECT_EQ(hash1, hash2);
}

TEST_F(VisionPrefixCacheTest, Sha256OfBytesDifferentInputs) {
  std::vector<uint8_t> a = {1, 2, 3};
  std::vector<uint8_t> b = {4, 5, 6};
  EXPECT_NE(sha256OfBytes(a), sha256OfBytes(b));
}

// FIPS 180-4 known-answer tests (official NIST test vectors).
TEST_F(VisionPrefixCacheTest, Sha256KatAbc) {
  std::vector<uint8_t> abc = {'a', 'b', 'c'};
  EXPECT_EQ(
      sha256OfBytes(abc),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
}

TEST_F(VisionPrefixCacheTest, Sha256KatTwoBlock) {
  // "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq" (448 bits)
  std::string msg = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
  std::vector<uint8_t> data(msg.begin(), msg.end());
  EXPECT_EQ(
      sha256OfBytes(data),
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
}

TEST_F(VisionPrefixCacheTest, Sha256OfFileMissing) {
  auto result = sha256OfFile("/nonexistent/path/to/file.bin");
  EXPECT_TRUE(result.empty());
}

TEST_F(VisionPrefixCacheTest, Sha256OfFileEmptyPath) {
  auto result = sha256OfFile("");
  EXPECT_TRUE(result.empty());
}

TEST_F(VisionPrefixCacheTest, MultipleEvictionsToFitNewEntry) {
  const std::size_t budget = bytesOf(256);
  VisionPrefixCache cache(budget);

  // Fill with 4 small entries.
  cache.put("a", makeEntry(64));
  cache.put("b", makeEntry(64));
  cache.put("c", makeEntry(64));
  cache.put("d", makeEntry(64));

  // Insert one large entry that requires evicting all 4.
  ASSERT_TRUE(cache.put("big", makeEntry(256)));

  EXPECT_FALSE(cache.get("a") != nullptr);
  EXPECT_FALSE(cache.get("b") != nullptr);
  EXPECT_FALSE(cache.get("c") != nullptr);
  EXPECT_FALSE(cache.get("d") != nullptr);
  EXPECT_TRUE(cache.get("big") != nullptr);
  EXPECT_EQ(cache.stats().evictions, 4u);
}
