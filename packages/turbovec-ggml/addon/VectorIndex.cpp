#include "VectorIndex.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <new>
#include <stdexcept>
#include <utility>
#include <vector>

namespace turbovec_ggml {

namespace {

constexpr int F32_BIT_WIDTH = 32;
constexpr int Q8_BIT_WIDTH = 8;
constexpr int Q4_BIT_WIDTH = 4;
// Fabric rejects a TurboVec add with any component at or above this.
constexpr float TURBOVEC_MAX_ABS = 1e16F;

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

// True when fabric's add will take this batch on an empty index: no reserved
// or repeated id, and every component finite with abs below 1e16 (fabric's
// TurboVec input bound). Calibration only sees a sample of the batch, so
// without this a batch add rejects could still leave its calibration
// behind. False when the id check cannot allocate, so the caller skips the
// optional work that depends on it.
bool firstBatchAddable(
    const float* vectors, const uint64_t* ids, int n, size_t dim) noexcept {
  const size_t values = static_cast<size_t>(n) * dim;
  for (size_t i = 0; i < values; ++i) {
    // Written negated so NaN fails too.
    if (!(std::fabs(vectors[i]) < TURBOVEC_MAX_ABS)) {
      return false;
    }
  }
  try {
    std::vector<uint64_t> sorted(ids, ids + n);
    std::sort(sorted.begin(), sorted.end());
    return sorted.back() != UINT64_MAX &&
           std::adjacent_find(sorted.begin(), sorted.end()) == sorted.end();
  } catch (...) {
    return false;
  }
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
  autoCalibrate_ = isTurboVec(storage);
  if (autoCalibrate_) {
    (void)ggml_vec_index_turbovec_set_staged(handle_, 0);
  }
}

VectorIndex::VectorIndex(ggml_vec_index_t* handle) noexcept : handle_(handle) {
  // load() already loads with staged search off, so this is a no-op there;
  // it keeps any other adopted TurboVec handle off too. Fabric rejects the
  // call for a non-TurboVec index, which has no staged search to turn off.
  if (handle_ != nullptr) {
    (void)ggml_vec_index_turbovec_set_staged(handle_, 0);
  }
}

VectorIndex::~VectorIndex() {
  if (handle_ != nullptr) {
    ggml_vec_index_free(handle_);
    handle_ = nullptr;
  }
}

VectorIndex::VectorIndex(VectorIndex&& other) noexcept
    : handle_(other.handle_), autoCalibrate_(other.autoCalibrate_),
      staged_(other.staged_) {
  other.handle_ = nullptr;
  other.autoCalibrate_ = false;
  other.staged_ = false;
}

VectorIndex& VectorIndex::operator=(VectorIndex&& other) noexcept {
  if (this != &other) {
    if (handle_ != nullptr) {
      ggml_vec_index_free(handle_);
    }
    handle_ = other.handle_;
    autoCalibrate_ = other.autoCalibrate_;
    staged_ = other.staged_;
    other.handle_ = nullptr;
    other.autoCalibrate_ = false;
    other.staged_ = false;
  }
  return *this;
}

int VectorIndex::add(
    const float* vectors, int n, const uint64_t* ids) noexcept {
  // The calibration commits before the add, so it runs only for a batch the
  // add will take: a rejected add leaves the index unchanged, and a
  // calibration fit from that batch would outlive it.
  if (autoCalibrate_ && n >= AUTO_CALIBRATE_MIN_ROWS && vectors != nullptr &&
      ids != nullptr && ggml_vec_index_len(handle_) == 0 &&
      ggml_vec_index_turbovec_is_calibrated(handle_) == 0 &&
      firstBatchAddable(
          vectors, ids, n, static_cast<size_t>(ggml_vec_index_dim(handle_)))) {
    // Best effort: a sample fabric cannot fit (for example one whose fit is
    // the identity) leaves the index uncalibrated, and the add goes ahead.
    const int dimInt = ggml_vec_index_dim(handle_);
    const auto dim = static_cast<size_t>(dimInt);
    const int sampleRowsInt = autoCalibrateSampleRows(dimInt);
    if (n <= sampleRowsInt) {
      (void)ggml_vec_index_turbovec_calibrate(handle_, vectors, n);
    } else {
      // A batch can arrive in source order (documents, chunks), so take
      // rows across all of it rather than its first ones. Every element is
      // written below, so the buffer is not zero-filled first.
      const auto sampleRows = static_cast<size_t>(sampleRowsInt);
      const std::unique_ptr<float[]> sample(
          new (std::nothrow) float[sampleRows * dim]);
      if (sample != nullptr) {
        for (size_t i = 0; i < sampleRows; ++i) {
          const size_t row = i * static_cast<size_t>(n) / sampleRows;
          std::copy_n(vectors + row * dim, dim, sample.get() + i * dim);
        }
        (void)ggml_vec_index_turbovec_calibrate(
            handle_, sample.get(), sampleRowsInt);
      }
    }
  }
  const int rc = ggml_vec_index_add(handle_, vectors, n, ids);
  // An empty batch adds no rows, so the index is still fresh after it.
  if (rc == GGML_VEC_INDEX_OK && n > 0) {
    autoCalibrate_ = false;
  }
  return rc;
}

bool VectorIndex::calibrated() const noexcept {
  return ggml_vec_index_turbovec_is_calibrated(handle_) == 1;
}

int VectorIndex::setStaged(bool enabled) noexcept {
  const int rc = ggml_vec_index_turbovec_set_staged(handle_, enabled ? 1 : 0);
  if (rc == GGML_VEC_INDEX_OK) {
    staged_ = enabled;
  }
  return rc;
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
  // Loaded with staged search already off: turning it off after a plain load
  // would first build the staged-search caches of a large index for nothing.
  *status = ggml_vec_index_load_with_flags(
      path.c_str(), GGML_VEC_INDEX_LOAD_TURBOVEC_STAGED_OFF, &raw);
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
