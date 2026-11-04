#include "VectorIndex.hpp"

#include <cstddef>
#include <stdexcept>
#include <utility>

namespace turbovec_ggml {

namespace {

constexpr int F32_BIT_WIDTH = 32;
constexpr int Q8_BIT_WIDTH = 8;
constexpr int Q4_BIT_WIDTH = 4;

constexpr bool isTurboVec(VectorStorage storage) noexcept {
  return storage == VectorStorage::TurboVecQ4 ||
         storage == VectorStorage::TurboVecQ2;
}

ggml_vec_index_t* createIndex(int dim, VectorStorage storage) {
  switch (storage) {
  case VectorStorage::F32:
    return ggml_vec_index_create(dim, F32_BIT_WIDTH);
  case VectorStorage::Q8:
    return ggml_vec_index_create(dim, Q8_BIT_WIDTH);
  case VectorStorage::Q4:
    return ggml_vec_index_create(dim, Q4_BIT_WIDTH);
  case VectorStorage::TurboVecQ4:
    return ggml_vec_index_create_turbovec_q4(dim);
  case VectorStorage::TurboVecQ2:
    return ggml_vec_index_create_turbovec_q2(dim);
  }
  return nullptr;
}

} // namespace

std::optional<VectorStorage>
parseVectorStorage(std::string_view storage) noexcept {
  if (storage == "f32") {
    return VectorStorage::F32;
  }
  if (storage == "q8") {
    return VectorStorage::Q8;
  }
  if (storage == "q4") {
    return VectorStorage::Q4;
  }
  if (storage == "turbovec-q4") {
    return VectorStorage::TurboVecQ4;
  }
  if (storage == "turbovec-q2") {
    return VectorStorage::TurboVecQ2;
  }
  return std::nullopt;
}

VectorIndexFilter::VectorIndexFilter(ggml_vec_index_filter_t* handle) noexcept
    : handle_(handle) {}

VectorIndexFilter::~VectorIndexFilter() {
  if (handle_ != nullptr) {
    ggml_vec_index_filter_free(handle_);
    handle_ = nullptr;
  }
}

VectorIndexFilter::VectorIndexFilter(VectorIndexFilter&& other) noexcept
    : handle_(other.handle_) {
  other.handle_ = nullptr;
}

VectorIndexFilter&
VectorIndexFilter::operator=(VectorIndexFilter&& other) noexcept {
  if (this != &other) {
    if (handle_ != nullptr) {
      ggml_vec_index_filter_free(handle_);
    }
    handle_ = other.handle_;
    other.handle_ = nullptr;
  }
  return *this;
}

VectorIndex::VectorIndex(int dim, VectorStorage storage) : handle_(nullptr) {
  if constexpr (sizeof(size_t) < 8) {
    if (isTurboVec(storage)) {
      throw std::invalid_argument("TurboVec requires a 64-bit target");
    }
  }
  handle_ = createIndex(dim, storage);
  if (handle_ == nullptr) {
    throw std::invalid_argument("ggml_vec_index_create rejected dim/storage");
  }
}

VectorIndex::VectorIndex(ggml_vec_index_t* handle) noexcept : handle_(handle) {}

VectorIndex::~VectorIndex() {
  if (handle_ != nullptr) {
    ggml_vec_index_free(handle_);
    handle_ = nullptr;
  }
}

VectorIndex::VectorIndex(VectorIndex&& other) noexcept
    : handle_(other.handle_) {
  other.handle_ = nullptr;
}

VectorIndex& VectorIndex::operator=(VectorIndex&& other) noexcept {
  if (this != &other) {
    if (handle_ != nullptr) {
      ggml_vec_index_free(handle_);
    }
    handle_ = other.handle_;
    other.handle_ = nullptr;
  }
  return *this;
}

int VectorIndex::add(
    const float* vectors, int n, const uint64_t* ids) noexcept {
  return ggml_vec_index_add(handle_, vectors, n, ids);
}

int VectorIndex::addLogged(
    const float* vectors, int n, const uint64_t* ids,
    const std::string& deltaPath) noexcept {
  return ggml_vec_index_add_logged(handle_, vectors, n, ids, deltaPath.c_str());
}

int VectorIndex::remove(uint64_t id) noexcept {
  return ggml_vec_index_remove(handle_, id);
}

int VectorIndex::removeLogged(
    uint64_t id, const std::string& deltaPath) noexcept {
  return ggml_vec_index_remove_logged(handle_, id, deltaPath.c_str());
}

int VectorIndex::compact() noexcept { return ggml_vec_index_compact(handle_); }

bool VectorIndex::contains(uint64_t id) const noexcept {
  return ggml_vec_index_contains(handle_, id) != 0;
}

void VectorIndex::prepare() noexcept { ggml_vec_index_prepare(handle_); }

int VectorIndex::buildIvf(int nLists, int nIter) noexcept {
  return ggml_vec_index_build_ivf(handle_, nLists, nIter);
}

int VectorIndex::search(
    const float* queries, int nQ, int k, float* outScores,
    uint64_t* outIds) const noexcept {
  return ggml_vec_index_search(handle_, queries, nQ, k, outScores, outIds);
}

int VectorIndex::searchFiltered(
    const float* queries, int nQ, int k, const uint64_t* allowedIds,
    int nAllowed, float* outScores, uint64_t* outIds) const noexcept {
  return ggml_vec_index_search_filtered(
      handle_, queries, nQ, k, allowedIds, nAllowed, outScores, outIds);
}

VectorIndexFilter VectorIndex::createFilter(
    const uint64_t* allowedIds, int nAllowed) const noexcept {
  ggml_vec_index_filter_t* raw =
      ggml_vec_index_filter_create(handle_, allowedIds, nAllowed);
  return VectorIndexFilter(raw);
}

int VectorIndex::searchPreparedFiltered(
    const VectorIndexFilter& filter, const float* queries, int nQ, int k,
    float* outScores, uint64_t* outIds) const noexcept {
  return ggml_vec_index_search_prepared_filtered(
      handle_, filter.raw(), queries, nQ, k, outScores, outIds);
}

int VectorIndex::searchIvf(
    const float* queries, int nQ, int k, int nProbe, float* outScores,
    uint64_t* outIds) const noexcept {
  return ggml_vec_index_search_ivf(
      handle_, queries, nQ, k, nProbe, outScores, outIds);
}

int VectorIndex::write(const std::string& path) noexcept {
  return ggml_vec_index_write(handle_, path.c_str());
}

int VectorIndex::compactDelta(
    const std::string& snapshotPath, const std::string& deltaPath) noexcept {
  return ggml_vec_index_compact_delta(
      handle_, snapshotPath.c_str(), deltaPath.c_str());
}

VectorIndex VectorIndex::load(const std::string& path, int* status) noexcept {
  ggml_vec_index_t* raw = nullptr;
  *status = ggml_vec_index_load_ex(path.c_str(), &raw);
  return VectorIndex(raw);
}

VectorIndex VectorIndex::loadWithDelta(
    const std::string& snapshotPath, const std::string& deltaPath,
    int* status) noexcept {
  ggml_vec_index_t* raw = nullptr;
  *status = ggml_vec_index_load_with_delta_ex(
      snapshotPath.c_str(), deltaPath.c_str(), &raw);
  return VectorIndex(raw);
}

VectorIndex
VectorIndex::loadMmap(const std::string& path, int* status) noexcept {
  ggml_vec_index_t* raw = nullptr;
  *status = ggml_vec_index_load_mmap_ex(path.c_str(), &raw);
  return VectorIndex(raw);
}

int VectorIndex::len() const noexcept { return ggml_vec_index_len(handle_); }

int VectorIndex::dim() const noexcept { return ggml_vec_index_dim(handle_); }

int VectorIndex::bitWidth() const noexcept {
  return ggml_vec_index_bit_width(handle_);
}

} // namespace turbovec_ggml
