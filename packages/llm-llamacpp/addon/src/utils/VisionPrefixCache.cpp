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

const VisionCacheEntry* VisionPrefixCache::get(const std::string& key) {
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
  return &it->second.first;
}

bool VisionPrefixCache::put(std::string key, VisionCacheEntry entry) {
  std::lock_guard<std::mutex> lock(mtx_);
  if (key.empty() || budgetBytes_ == 0) {
    return false;
  }
  auto existing = entries_.find(key);
  if (existing != entries_.end()) {
    currentBytes_ -= existing->second.first.sizeBytes();
    existing->second.first = std::move(entry);
    currentBytes_ += existing->second.first.sizeBytes();
    touch(existing->second.second);
    while (currentBytes_ > budgetBytes_ && !order_.empty()) {
      const std::string& victim = order_.back();
      auto vIt = entries_.find(victim);
      if (vIt != entries_.end()) {
        currentBytes_ -= vIt->second.first.sizeBytes();
        entries_.erase(vIt);
      }
      order_.pop_back();
      ++evictions_;
    }
    if (currentBytes_ > peakBytes_) peakBytes_ = currentBytes_;
    return true;
  }
  const std::size_t entrySize = entry.sizeBytes();
  if (entrySize > budgetBytes_) {
    return false;
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

void VisionPrefixCache::clearData() {
  std::lock_guard<std::mutex> lock(mtx_);
  order_.clear();
  entries_.clear();
  currentBytes_ = 0;
}

void VisionPrefixCache::clearStats() {
  std::lock_guard<std::mutex> lock(mtx_);
  hits_ = 0;
  misses_ = 0;
  evictions_ = 0;
}

void VisionPrefixCache::clear() {
  std::lock_guard<std::mutex> lock(mtx_);
  order_.clear();
  entries_.clear();
  currentBytes_ = 0;
  hits_ = 0;
  misses_ = 0;
  evictions_ = 0;
}

void VisionPrefixCache::onMemoryWarning() {
  std::lock_guard<std::mutex> lock(mtx_);
  order_.clear();
  entries_.clear();
  currentBytes_ = 0;
}

std::size_t VisionPrefixCache::size() const {
  std::lock_guard<std::mutex> lock(mtx_);
  return order_.size();
}

std::size_t VisionPrefixCache::hits() const {
  std::lock_guard<std::mutex> lock(mtx_);
  return hits_;
}

std::size_t VisionPrefixCache::misses() const {
  std::lock_guard<std::mutex> lock(mtx_);
  return misses_;
}

std::size_t VisionPrefixCache::evictions() const {
  std::lock_guard<std::mutex> lock(mtx_);
  return evictions_;
}

std::size_t VisionPrefixCache::currentBytes() const {
  std::lock_guard<std::mutex> lock(mtx_);
  return currentBytes_;
}

std::size_t VisionPrefixCache::peakBytes() const {
  std::lock_guard<std::mutex> lock(mtx_);
  return peakBytes_;
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

std::string makeVisionCacheKey(
    const std::string& modelPath, const std::string& mmprojPath,
    const std::string& imageHash) {
  if (imageHash.empty()) {
    return {};
  }
  // Length-prefixed encoding prevents delimiter collisions when paths contain
  // special characters. Format: "len:value|len:value|hash"
  std::string scoped;
  scoped.reserve(
      20 + modelPath.size() + mmprojPath.size() + imageHash.size());
  scoped.append(std::to_string(modelPath.size()));
  scoped.push_back(':');
  scoped.append(modelPath);
  scoped.push_back('|');
  scoped.append(std::to_string(mmprojPath.size()));
  scoped.push_back(':');
  scoped.append(mmprojPath);
  scoped.push_back('|');
  scoped.append(imageHash);
  return scoped;
}

} // namespace qvac_lib_inference_addon_llama
