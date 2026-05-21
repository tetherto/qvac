#include "VisionPrefixCache.hpp"

#include <array>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <utility>

#include <openssl/evp.h>

namespace qvac_lib_inference_addon_llama {

VisionPrefixCache::VisionPrefixCache(std::size_t capacity)
    : capacity_(capacity == 0 ? 1 : capacity) {}

const VisionCacheEntry* VisionPrefixCache::get(const std::string& key) {
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
  it->second.first.lastAccess = std::chrono::steady_clock::now();
  touch(it->second.second);
  return &it->second.first;
}

bool VisionPrefixCache::put(std::string key, VisionCacheEntry entry) {
  if (key.empty()) {
    return false;
  }
  auto existing = entries_.find(key);
  if (existing != entries_.end()) {
    existing->second.first = std::move(entry);
    existing->second.first.lastAccess = std::chrono::steady_clock::now();
    touch(existing->second.second);
    return true;
  }
  while (entries_.size() >= capacity_) {
    if (order_.empty()) {
      // capacity_ guaranteed > 0 by ctor, so order_ should never be empty
      // here, but defensively bail out instead of looping.
      break;
    }
    const std::string& victim = order_.back();
    entries_.erase(victim);
    order_.pop_back();
    ++evictions_;
  }
  order_.push_front(key);
  entry.lastAccess = std::chrono::steady_clock::now();
  entries_.emplace(
      std::move(key), std::make_pair(std::move(entry), order_.begin()));
  return true;
}

void VisionPrefixCache::clear() {
  order_.clear();
  entries_.clear();
  hits_ = 0;
  misses_ = 0;
  evictions_ = 0;
}

void VisionPrefixCache::touch(std::list<std::string>::iterator it) {
  if (it == order_.begin()) {
    return;
  }
  order_.splice(order_.begin(), order_, it);
}

namespace {

std::string digestToHex(const unsigned char* digest, unsigned int len) {
  std::ostringstream oss;
  oss << std::hex << std::setfill('0');
  for (unsigned int i = 0; i < len; ++i) {
    oss << std::setw(2) << static_cast<unsigned>(digest[i]);
  }
  return oss.str();
}

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
    EVP_MD_CTX* ctx = EVP_MD_CTX_new();
    if (ctx == nullptr) {
      return {};
    }
    if (EVP_DigestInit_ex(ctx, EVP_sha256(), nullptr) != 1) {
      EVP_MD_CTX_free(ctx);
      return {};
    }
    std::array<char, 8192> buf{};
    while (fin.read(buf.data(), buf.size()) || fin.gcount() > 0) {
      if (EVP_DigestUpdate(ctx, buf.data(),
                           static_cast<std::size_t>(fin.gcount())) != 1) {
        EVP_MD_CTX_free(ctx);
        return {};
      }
    }
    unsigned char digest[EVP_MAX_MD_SIZE];
    unsigned int digestLen = 0;
    if (EVP_DigestFinal_ex(ctx, digest, &digestLen) != 1) {
      EVP_MD_CTX_free(ctx);
      return {};
    }
    EVP_MD_CTX_free(ctx);
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
  // Compose with delimiter unlikely to appear in paths or hex digests.
  std::string scoped;
  scoped.reserve(modelPath.size() + mmprojPath.size() + imageHash.size() + 2);
  scoped.append(modelPath);
  scoped.push_back('|');
  scoped.append(mmprojPath);
  scoped.push_back('|');
  scoped.append(imageHash);
  return scoped;
}

} // namespace qvac_lib_inference_addon_llama
