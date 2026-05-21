#pragma once

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <list>
#include <string>
#include <unordered_map>
#include <vector>

#include <llama.h>

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
  // Deep copy of mtmd_get_output_embd() — its underlying buffer is overwritten
  // on the next mtmd_encode_chunk() call, so we MUST copy before any further
  // encode runs.
  std::vector<float> embeddings;

  // Token count for this image chunk; required for sizing the embeddings
  // buffer (n_tokens * n_embd) when calling mtmd_helper_decode_image_chunk.
  std::size_t n_tokens = 0;

  // Number of temporal positions the chunk advances n_past by. For most
  // models n_pos == n_tokens; for M-RoPE (Qwen3VL) it can differ. We don't
  // hand n_pos to mtmd_helper_decode_image_chunk directly (it computes its
  // own from the chunk metadata), but storing it lets future hooks compare.
  llama_pos n_pos = 0;

  // Spatial dims, populated from mtmd_image_tokens_get_nx/ny when available.
  // Used by M-RoPE position assembly inside libmtmd; we keep them so the
  // cached entry is self-describing and unit tests can exercise round-trip.
  std::size_t nx = 0;
  std::size_t ny = 0;

  std::chrono::steady_clock::time_point lastAccess{};
};

class VisionPrefixCache {
public:
  static constexpr std::size_t kDefaultCapacity = 5;

  explicit VisionPrefixCache(std::size_t capacity = kDefaultCapacity);

  // Look up a cached entry. Returns nullptr if the key is absent or empty.
  // On hit, marks the entry MRU (moves to front of LRU list and updates
  // lastAccess) and increments hit-count. The returned pointer is stable
  // until the next put()/clear()/evict in the same thread.
  const VisionCacheEntry* get(const std::string& key);

  // Insert / overwrite. If at capacity, evicts the least-recently-used entry
  // first. Empty key is rejected (no-op + returns false) — callers should
  // skip the cache when no SHA-256 was computed (e.g. zero-byte image).
  bool put(std::string key, VisionCacheEntry entry);

  void clear();

  // Capacity is fixed at construction; expose for tests.
  std::size_t capacity() const { return capacity_; }
  std::size_t size() const { return order_.size(); }

  // Stats (cumulative, reset by clear()).
  std::size_t hits() const { return hits_; }
  std::size_t misses() const { return misses_; }
  std::size_t evictions() const { return evictions_; }

private:
  void touch(typename std::list<std::string>::iterator it);

  std::size_t capacity_;
  std::list<std::string> order_; // front = MRU, back = LRU
  std::unordered_map<
      std::string,
      std::pair<VisionCacheEntry, std::list<std::string>::iterator>>
      entries_;

  std::size_t hits_ = 0;
  std::size_t misses_ = 0;
  std::size_t evictions_ = 0;
};

// Compute SHA-256(bytes) and return as lowercase hex (64 chars). Returns the
// empty string when bytes is empty so callers can skip the cache cleanly.
std::string sha256OfBytes(const std::uint8_t* data, std::size_t len);

// Convenience overload for the addon's media buffer type.
std::string sha256OfBytes(const std::vector<std::uint8_t>& bytes);

// Stream-hash a file. Returns empty string if the file is missing /
// unreadable / empty — callers should treat that as "no cache key" and
// skip caching, not as a hard error (caching is an optimisation).
std::string sha256OfFile(const std::string& path);

// Build a scope-qualified cache key. Different model+mmproj pairs with the
// same image bytes must NOT collide — the embeddings are model-specific.
std::string makeVisionCacheKey(
    const std::string& modelPath, const std::string& mmprojPath,
    const std::string& imageHash);

} // namespace qvac_lib_inference_addon_llama
