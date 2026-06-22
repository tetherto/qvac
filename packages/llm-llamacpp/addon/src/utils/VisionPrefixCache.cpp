#include "VisionPrefixCache.hpp"

#include <array>
#include <cstring>
#include <fstream>
#include <string>
#include <utility>

namespace qvac_lib_inference_addon_llama {

VisionPrefixCache::VisionPrefixCache(std::size_t budgetBytes)
    : budgetBytes_(budgetBytes) {}

std::shared_ptr<const VisionCacheEntry>
VisionPrefixCache::get(const std::string& key) {
  std::lock_guard<std::mutex> lock(mtx_);
  if (key.empty()) {
    ++misses_;
    return nullptr;
  }
  auto it = entries_.find(key);
  if (it == entries_.end()) {
    ++misses_;
    return nullptr;
  }
  ++hits_;
  touch(it->second.second);
  return it->second.first;
}

bool VisionPrefixCache::put(std::string key, VisionCacheEntry entry) {
  std::lock_guard<std::mutex> lock(mtx_);
  if (key.empty() || budgetBytes_ == 0) {
    return false;
  }
  const std::size_t entrySize = entry.sizeBytes();
  if (entrySize > budgetBytes_) {
    return false;
  }
  auto existing = entries_.find(key);
  if (existing != entries_.end()) {
    currentBytes_ -= existing->second.first->sizeBytes();
    existing->second.first =
        std::make_shared<const VisionCacheEntry>(std::move(entry));
    currentBytes_ += existing->second.first->sizeBytes();
    touch(existing->second.second);
    while (currentBytes_ > budgetBytes_ && !order_.empty()) {
      const std::string& victim = order_.back();
      auto vIt = entries_.find(victim);
      if (vIt != entries_.end()) {
        currentBytes_ -= vIt->second.first->sizeBytes();
        entries_.erase(vIt);
      }
      order_.pop_back();
      ++evictions_;
    }
    if (currentBytes_ > peakBytes_)
      peakBytes_ = currentBytes_;
    return true;
  }
  while (currentBytes_ + entrySize > budgetBytes_ && !order_.empty()) {
    const std::string& victim = order_.back();
    auto vIt = entries_.find(victim);
    if (vIt != entries_.end()) {
      currentBytes_ -= vIt->second.first->sizeBytes();
      entries_.erase(vIt);
    }
    order_.pop_back();
    ++evictions_;
  }
  order_.push_front(std::move(key));
  currentBytes_ += entrySize;
  if (currentBytes_ > peakBytes_)
    peakBytes_ = currentBytes_;
  entries_.emplace(
      order_.front(),
      std::make_pair(
          std::make_shared<const VisionCacheEntry>(std::move(entry)),
          order_.begin()));
  ++distinctImages_;
  return true;
}

void VisionPrefixCache::clearDataLocked() {
  order_.clear();
  entries_.clear();
  currentBytes_ = 0;
}

void VisionPrefixCache::clearStatsLocked() {
  hits_ = 0;
  misses_ = 0;
  evictions_ = 0;
  distinctImages_ = 0;
}

void VisionPrefixCache::clearData() {
  std::lock_guard<std::mutex> lock(mtx_);
  clearDataLocked();
}

void VisionPrefixCache::clearStats() {
  std::lock_guard<std::mutex> lock(mtx_);
  clearStatsLocked();
}

void VisionPrefixCache::clear() {
  std::lock_guard<std::mutex> lock(mtx_);
  clearDataLocked();
  clearStatsLocked();
}

void VisionPrefixCache::onMemoryWarning() {
  std::lock_guard<std::mutex> lock(mtx_);
  clearDataLocked();
}

VisionCacheStats VisionPrefixCache::stats() const {
  std::lock_guard<std::mutex> lock(mtx_);
  return {
      hits_, misses_, evictions_, distinctImages_, currentBytes_, peakBytes_};
}

void VisionPrefixCache::touch(std::list<std::string>::iterator it) {
  if (it == order_.begin()) {
    return;
  }
  order_.splice(order_.begin(), order_, it);
}

// ---------------------------------------------------------------------------
// Minimal self-contained SHA-256 (no OpenSSL dependency).
// Based on the FIPS 180-4 specification. Public domain.
// ---------------------------------------------------------------------------
namespace {

static constexpr uint32_t SHA256_K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};

inline uint32_t rotr(uint32_t x, unsigned n) {
  return (x >> n) | (x << (32 - n));
}

struct Sha256Ctx {
  uint32_t state[8]{
      0x6a09e667,
      0xbb67ae85,
      0x3c6ef372,
      0xa54ff53a,
      0x510e527f,
      0x9b05688c,
      0x1f83d9ab,
      0x5be0cd19};
  uint8_t block[64]{};
  std::size_t blockLen = 0;
  uint64_t totalBits = 0;

  void transform() {
    uint32_t w[64];
    for (int i = 0; i < 16; ++i) {
      w[i] = (uint32_t(block[i * 4]) << 24) |
             (uint32_t(block[i * 4 + 1]) << 16) |
             (uint32_t(block[i * 4 + 2]) << 8) | uint32_t(block[i * 4 + 3]);
    }
    for (int i = 16; i < 64; ++i) {
      uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
      uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = state[0], b = state[1], c = state[2], d = state[3];
    uint32_t e = state[4], f = state[5], g = state[6], h = state[7];
    for (int i = 0; i < 64; ++i) {
      uint32_t sigma1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      uint32_t ch = (e & f) ^ (~e & g);
      uint32_t temp1 = h + sigma1 + ch + SHA256_K[i] + w[i];
      uint32_t sigma0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
      uint32_t temp2 = sigma0 + maj;
      h = g;
      g = f;
      f = e;
      e = d + temp1;
      d = c;
      c = b;
      b = a;
      a = temp1 + temp2;
    }
    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
    state[4] += e;
    state[5] += f;
    state[6] += g;
    state[7] += h;
  }

  void update(const uint8_t* data, std::size_t len) {
    std::size_t i = 0;
    // Top off a partial block first, then run full 64-byte blocks straight
    // from the input, then buffer the remainder. Bulk memcpy is ~10x faster
    // than the byte-at-a-time loop on multi-MB images. The (block, blockLen,
    // totalBits) state evolves identically, so finalize() and the digest are
    // byte-for-byte identical to the scalar version.
    if (blockLen > 0) {
      const std::size_t need = 64 - blockLen;
      const std::size_t take = (len < need) ? len : need;
      std::memcpy(block + blockLen, data, take);
      blockLen += take;
      i += take;
      if (blockLen == 64) {
        transform();
        totalBits += 512;
        blockLen = 0;
      }
    }
    while (len - i >= 64) {
      std::memcpy(block, data + i, 64);
      transform();
      totalBits += 512;
      i += 64;
    }
    if (i < len) {
      std::memcpy(block + blockLen, data + i, len - i);
      blockLen += len - i;
    }
  }

  std::array<uint8_t, 32> finalize() {
    uint64_t msgBits = totalBits + blockLen * 8;
    block[blockLen++] = 0x80;
    if (blockLen > 56) {
      while (blockLen < 64)
        block[blockLen++] = 0;
      transform();
      blockLen = 0;
    }
    while (blockLen < 56)
      block[blockLen++] = 0;
    for (int i = 7; i >= 0; --i) {
      block[blockLen++] = static_cast<uint8_t>(msgBits >> (i * 8));
    }
    transform();
    std::array<uint8_t, 32> digest{};
    for (int i = 0; i < 8; ++i) {
      digest[i * 4] = static_cast<uint8_t>(state[i] >> 24);
      digest[i * 4 + 1] = static_cast<uint8_t>(state[i] >> 16);
      digest[i * 4 + 2] = static_cast<uint8_t>(state[i] >> 8);
      digest[i * 4 + 3] = static_cast<uint8_t>(state[i]);
    }
    return digest;
  }
};

std::string digestToHex(const uint8_t* digest, std::size_t len) {
  static constexpr char kHexChars[] = "0123456789abcdef";
  std::string result(len * 2, '\0');
  for (std::size_t i = 0; i < len; ++i) {
    result[i * 2] = kHexChars[(digest[i] >> 4) & 0x0F];
    result[i * 2 + 1] = kHexChars[digest[i] & 0x0F];
  }
  return result;
}

} // namespace

std::string sha256OfBytes(const std::uint8_t* data, std::size_t len) {
  if (data == nullptr || len == 0) {
    return {};
  }
  Sha256Ctx ctx;
  ctx.update(data, len);
  auto digest = ctx.finalize();
  return digestToHex(digest.data(), digest.size());
}

std::string sha256OfBytes(const std::vector<std::uint8_t>& bytes) {
  return sha256OfBytes(bytes.data(), bytes.size());
}

std::string sha256OfFile(const std::string& path) {
  if (path.empty()) {
    return {};
  }
  try {
    std::ifstream fin(path, std::ios::binary);
    if (!fin) {
      return {};
    }
    // Cap the bytes hashed. Without this, a special file such as /dev/zero or
    // a FIFO never reaches EOF and the read loop runs forever; a stat()-based
    // check would miss those (they report size 0). Any genuine image is far
    // below this bound, so exceeding it means the path is not a real media
    // file — return empty (the caller then skips caching and re-encodes
    // normally) instead of hashing unbounded input.
    constexpr std::size_t kMaxFileBytes = 512ULL * 1024 * 1024;
    Sha256Ctx ctx;
    std::array<char, 65536> buf{};
    std::size_t total = 0;
    while (fin.read(buf.data(), buf.size()) || fin.gcount() > 0) {
      const auto n = static_cast<std::size_t>(fin.gcount());
      total += n;
      if (total > kMaxFileBytes) {
        return {};
      }
      ctx.update(reinterpret_cast<const uint8_t*>(buf.data()), n);
    }
    auto digest = ctx.finalize();
    return digestToHex(digest.data(), digest.size());
  } catch (...) {
    return {};
  }
}

std::string makeVisionCacheKeyPrefix(
    const std::string& modelPath, const std::string& mmprojPath) {
  if (modelPath.empty() && mmprojPath.empty()) {
    return {};
  }
  std::string prefix;
  prefix.reserve(20 + modelPath.size() + mmprojPath.size());
  prefix.append(std::to_string(modelPath.size()));
  prefix.push_back(':');
  prefix.append(modelPath);
  prefix.push_back('|');
  prefix.append(std::to_string(mmprojPath.size()));
  prefix.push_back(':');
  prefix.append(mmprojPath);
  prefix.push_back('|');
  return prefix;
}

} // namespace qvac_lib_inference_addon_llama
