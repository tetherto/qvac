#pragma once

#include <cstddef>
#include <cstdint>
#include <list>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace qvac_lib_inference_addon_llama {

// QVAC-19118 A2: post-projection vision embedding cache.
//
// Stores the float embeddings produced by the mmproj projection layer for an
// image chunk, keyed by SHA-256(image bytes). On cache hit the addon's chunk
// eval path skips both CLIP encode and projection and feeds the cached
// embeddings directly into mtmd_helper_decode_image_chunk(), which only sets
// up KV positions and runs llama_decode().
//
// Why post-projection (and not post-CLIP only): on iPhone 16e the Qwen3VL
// merger projection costs 183ms (vs 2ms on Mac M4) — caching after CLIP would
// still pay that 183ms on every repeat query. Post-projection caches both.
//
// Memory: each entry stores ~n_tokens * llama_model_n_embd(model) floats
// (typically ~2 MB for E2B-class models at 256 tokens × 2048 dims). Default
// capacity 5 entries (~10 MB) is well under the iPhone 16e ~5.7 GB headroom
// reported in metal-baseline.md. Entries live in CPU memory and are copied
// to GPU buffers transiently inside mtmd_helper_decode_image_chunk().
struct VisionCacheEntry {
  std::vector<float> embeddings;

  std::size_t nTokens = 0;

  // Number of temporal positions the chunk advances n_past by. For most
  // models nPos == nTokens; for M-RoPE (Qwen3VL) it can differ.
  int32_t nPos = 0;

  // Spatial dims, populated from mtmd_image_tokens_get_nx/ny when available.
  std::size_t nx = 0;
  std::size_t ny = 0;

  // Cannot overflow: the byte product is bounded where entries are built
  // (MtmdLlmContext guards nTokensChunk * nEmbd > SIZE_MAX / sizeof(float)
  // before assigning embeddings), so size() * sizeof(float) always fits.
  std::size_t sizeBytes() const { return embeddings.size() * sizeof(float); }
};

struct VisionCacheStats {
  std::size_t hits = 0;
  std::size_t misses = 0;
  std::size_t evictions = 0;
  std::size_t distinctImages = 0;
  std::size_t currentBytes = 0;
  std::size_t peakBytes = 0;
};

class VisionPrefixCache {
public:
  static constexpr std::size_t DEFAULT_BUDGET_BYTES = 100ULL * 1024 * 1024;

  explicit VisionPrefixCache(std::size_t budgetBytes = DEFAULT_BUDGET_BYTES);

  // Look up a cached entry. Returns a shared_ptr to an immutable entry
  // (thread-safe, zero-copy). Returns nullptr on miss.
  std::shared_ptr<const VisionCacheEntry> get(const std::string& key);

  // Insert / overwrite. Evicts least-recently-used entries while total byte
  // usage exceeds budgetBytes. Empty key or zero budget is rejected (no-op +
  // returns false).
  bool put(std::string key, VisionCacheEntry entry);

  // Drop all cached entries and reset currentBytes. Does NOT reset stats.
  void clearData();

  // Reset hit/miss/eviction counters. peakBytes persists.
  void clearStats();

  // Drop all entries AND reset stats (except peakBytes).
  void clear();

  // Called from OS low-memory callbacks (potentially on a different thread).
  void onMemoryWarning();

  std::size_t budgetBytes() const { return budgetBytes_; }

  // Snapshot all counters under a single lock acquisition.
  VisionCacheStats stats() const;

private:
  void touch(typename std::list<std::string>::iterator it);
  void clearDataLocked();
  void clearStatsLocked();

  mutable std::mutex mtx_;
  std::size_t budgetBytes_;
  std::size_t currentBytes_ = 0;
  std::size_t peakBytes_ = 0;
  std::list<std::string> order_; // front = MRU, back = LRU
  // Entries are held behind a shared_ptr so get() can copy out the pointer
  // under the lock (cheap) and deep-copy the embeddings after releasing it.
  std::unordered_map<
      std::string, std::pair<
                       std::shared_ptr<const VisionCacheEntry>,
                       std::list<std::string>::iterator>>
      entries_;

  std::size_t hits_ = 0;
  std::size_t misses_ = 0;
  std::size_t evictions_ = 0;
  std::size_t distinctImages_ = 0;
};

std::string sha256OfBytes(const std::uint8_t* data, std::size_t len);

std::string sha256OfBytes(const std::vector<std::uint8_t>& bytes);

std::string sha256OfFile(const std::string& path);

// Build the model+mmproj portion of a cache key using length-prefixed
// encoding. Append the image hash to produce the full key.
std::string makeVisionCacheKeyPrefix(
    const std::string& modelPath, const std::string& mmprojPath);

} // namespace qvac_lib_inference_addon_llama
