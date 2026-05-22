#include "VisionPrefixCache.hpp"

#include <array>
#include <fstream>
#include <memory>
#include <string>
#include <utility>

#include <openssl/evp.h>

namespace qvac_lib_inference_addon_llama {

VisionPrefixCache::VisionPrefixCache(std::size_t budgetBytes)
    : budgetBytes_(budgetBytes) {}

std::optional<VisionCacheEntry>
VisionPrefixCache::get(const std::string& key) {
  std::lock_guard<std::mutex> lock(mtx_);
  if (key.empty()) {
    ++misses_;
    return std::nullopt;
  }
  auto it = entries_.find(key);
  if (it == entries_.end()) {
    ++misses_;
    return std::nullopt;
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
    currentBytes_ -= existing->second.first.sizeBytes();
    existing->second.first = std::move(entry);
    currentBytes_ += existing->second.first.sizeBytes();
    touch(existing->second.second);
    if (currentBytes_ > peakBytes_) peakBytes_ = currentBytes_;
    return true;
  }
  while (currentBytes_ + entrySize > budgetBytes_ && !order_.empty()) {
    const std::string& victim = order_.back();
    auto vIt = entries_.find(victim);
    if (vIt != entries_.end()) {
      currentBytes_ -= vIt->second.first.sizeBytes();
      entries_.erase(vIt);
    }
    order_.pop_back();
    ++evictions_;
  }
  order_.push_front(key);
  currentBytes_ += entrySize;
  if (currentBytes_ > peakBytes_) peakBytes_ = currentBytes_;
  entries_.emplace(
      std::move(key), std::make_pair(std::move(entry), order_.begin()));
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
  return {hits_, misses_, evictions_, currentBytes_, peakBytes_};
}

void VisionPrefixCache::touch(std::list<std::string>::iterator it) {
  if (it == order_.begin()) {
    return;
  }
  order_.splice(order_.begin(), order_, it);
}

namespace {

std::string digestToHex(const unsigned char* digest, unsigned int len) {
  static constexpr char kHexChars[] = "0123456789abcdef";
  std::string result(len * 2, '\0');
  for (unsigned int i = 0; i < len; ++i) {
    result[i * 2] = kHexChars[(digest[i] >> 4) & 0x0F];
    result[i * 2 + 1] = kHexChars[digest[i] & 0x0F];
  }
  return result;
}

struct EvpMdCtxDeleter {
  void operator()(EVP_MD_CTX* ctx) const {
    if (ctx != nullptr) EVP_MD_CTX_free(ctx);
  }
};
using EvpMdCtxPtr = std::unique_ptr<EVP_MD_CTX, EvpMdCtxDeleter>;

} // namespace

std::string sha256OfBytes(const std::uint8_t* data, std::size_t len) {
  if (data == nullptr || len == 0) {
    return {};
  }
  unsigned char digest[EVP_MAX_MD_SIZE];
  unsigned int digestLen = 0;
  if (EVP_Digest(data, len, digest, &digestLen, EVP_sha256(), nullptr) != 1) {
    return {};
  }
  return digestToHex(digest, digestLen);
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
    EvpMdCtxPtr ctx(EVP_MD_CTX_new());
    if (!ctx) {
      return {};
    }
    if (EVP_DigestInit_ex(ctx.get(), EVP_sha256(), nullptr) != 1) {
      return {};
    }
    std::array<char, 65536> buf{};
    while (fin.read(buf.data(), buf.size()) || fin.gcount() > 0) {
      if (EVP_DigestUpdate(ctx.get(), buf.data(),
                           static_cast<std::size_t>(fin.gcount())) != 1) {
        return {};
      }
    }
    unsigned char digest[EVP_MAX_MD_SIZE];
    unsigned int digestLen = 0;
    if (EVP_DigestFinal_ex(ctx.get(), digest, &digestLen) != 1) {
      return {};
    }
    return digestToHex(digest, digestLen);
  } catch (...) {
    return {};
  }
}

std::string makeVisionCacheKeyPrefix(
    const std::string& modelPath, const std::string& mmprojPath) {
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
