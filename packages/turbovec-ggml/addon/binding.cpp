// Bare surface for the `IdMapIndex` JS class. Exports a small set of free
// functions; the JS wrapper in `src/index.ts` ties them into a class shape.
// Depends only on the VectorIndex C++ wrapper, which in turn depends only on
// fabric's ggml-vector-index C API.

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <initializer_list>
#include <limits>
#include <memory>
#include <new>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include <bare.h>
#include <qvac-addon/fabric-bind.h>

#include "AsyncJob.hpp"
#include "VectorIndex.hpp"
#include "VectorIndexErrors.hpp"

namespace {

using turbovec_ggml::VectorIndex;
using turbovec_ggml::VectorIndexFilter;
namespace verrors = turbovec_ggml::vector_index_errors;

constexpr uint64_t EXTERNAL_MAGIC = UINT64_C(0x515649444d415058);

enum class ExternalKind : uint32_t {
  Index = 1,
  Filter = 2,
};

struct ExternalHeader {
  uint64_t magic = EXTERNAL_MAGIC;
  ExternalKind kind;
};

struct VectorIndexExternal {
  explicit VectorIndexExternal(VectorIndex* index) noexcept
      : header{EXTERNAL_MAGIC, ExternalKind::Index}, idx(index) {}

  ~VectorIndexExternal() {
    delete idx;
    idx = nullptr;
  }

  VectorIndexExternal(const VectorIndexExternal&) = delete;
  VectorIndexExternal& operator=(const VectorIndexExternal&) = delete;

  ExternalHeader header;
  VectorIndex* idx;
  // JS thread only. True while an async job runs on this index. Every other
  // call, including dispose and the getters, is rejected meanwhile: fabric
  // would block the JS thread on the index lock until the job finished.
  bool busy = false;
};

struct SearchOutput {
  size_t total = 0;
  void* scoresData = nullptr;
  js_value_t* scoresBuffer = nullptr;
  void* idsData = nullptr;
  js_value_t* idsBuffer = nullptr;
};

struct VectorIndexFilterExternal {
  explicit VectorIndexFilterExternal(VectorIndexFilter* value) noexcept
      : header{EXTERNAL_MAGIC, ExternalKind::Filter}, filter(value) {}

  ~VectorIndexFilterExternal() {
    delete filter;
    filter = nullptr;
  }

  VectorIndexFilterExternal(const VectorIndexFilterExternal&) = delete;
  VectorIndexFilterExternal&
  operator=(const VectorIndexFilterExternal&) = delete;

  ExternalHeader header;
  VectorIndexFilter* filter;
  // JS thread only. True while an async search uses this filter.
  bool busy = false;
};

// Finalizer: invoked by the JS engine when the external handle is GC'd.
// Tears down the native C handle via VectorIndex's RAII dtor.
void finalizeVectorIndex(js_env_t* /*env*/, void* data, void* /*hint*/) {
  auto* external = static_cast<VectorIndexExternal*>(data);
  delete external;
}

void finalizeVectorIndexFilter(js_env_t* /*env*/, void* data, void* /*hint*/) {
  auto* external = static_cast<VectorIndexFilterExternal*>(data);
  delete external;
}

// Wrap an already-constructed VectorIndex into a JS external. Takes
// ownership of `idx`; the JS engine will delete it via finalize on GC.
js_value_t* wrap(js_env_t* env, VectorIndex* idx) {
  VectorIndexExternal* holder = nullptr;
  try {
    holder = new VectorIndexExternal(idx);
  } catch (const std::bad_alloc&) {
    delete idx;
    js_throw_error(env, "OutOfMemory", "allocation failure");
    return nullptr;
  }

  js_value_t* external = nullptr;
  if (js_create_external(
          env, holder, finalizeVectorIndex, nullptr, &external) != 0) {
    delete holder;
    js_throw_error(env, "InternalError", "failed to create external");
    return nullptr;
  }
  return external;
}

js_value_t* wrapFilter(js_env_t* env, VectorIndexFilter* filter) {
  VectorIndexFilterExternal* holder = nullptr;
  try {
    holder = new VectorIndexFilterExternal(filter);
  } catch (const std::bad_alloc&) {
    delete filter;
    js_throw_error(env, "OutOfMemory", "allocation failure");
    return nullptr;
  }

  js_value_t* external = nullptr;
  if (js_create_external(
          env, holder, finalizeVectorIndexFilter, nullptr, &external) != 0) {
    delete holder;
    js_throw_error(env, "InternalError", "failed to create external");
    return nullptr;
  }
  return external;
}

// Bare's typed getters do no type checking and may crash on a value of the
// wrong type, so every argument read checks the type first.
template <int (*IsType)(js_env_t*, js_value_t*, bool*)>
bool hasType(js_env_t* env, js_value_t* value) {
  bool result = false;
  return IsType(env, value, &result) == 0 && result;
}

VectorIndexExternal* unwrapExternal(js_env_t* env, js_value_t* handle) {
  void* data = nullptr;
  if (!hasType<js_is_external>(env, handle) ||
      js_get_value_external(env, handle, &data) != 0 || data == nullptr) {
    js_throw_error(env, "InvalidArgument", "expected IdMapIndex handle");
    return nullptr;
  }
  const auto* header = static_cast<const ExternalHeader*>(data);
  if (header->magic != EXTERNAL_MAGIC || header->kind != ExternalKind::Index) {
    js_throw_error(env, "InvalidArgument", "expected IdMapIndex handle");
    return nullptr;
  }
  return static_cast<VectorIndexExternal*>(data);
}

void throwBusy(js_env_t* env, const char* what) {
  const std::string message =
      std::string(what) + " has an async operation in progress";
  js_throw_error(env, "Busy", message.c_str());
}

// Like unwrap(), but returns the external of a live, idle index.
VectorIndexExternal* unwrapLiveExternal(js_env_t* env, js_value_t* handle) {
  VectorIndexExternal* external = unwrapExternal(env, handle);
  if (external == nullptr) {
    return nullptr;
  }
  if (external->idx == nullptr) {
    js_throw_error(env, "InvalidArgument", "IdMapIndex has been disposed");
    return nullptr;
  }
  if (external->busy) {
    throwBusy(env, "IdMapIndex");
    return nullptr;
  }
  return external;
}

// Get a borrowed pointer out of a JS external handle. Throws and returns
// null on failure, or while an async job runs on the index.
VectorIndex* unwrap(js_env_t* env, js_value_t* handle) {
  VectorIndexExternal* external = unwrapLiveExternal(env, handle);
  return external == nullptr ? nullptr : external->idx;
}

VectorIndexFilterExternal*
unwrapFilterExternal(js_env_t* env, js_value_t* handle) {
  void* data = nullptr;
  if (!hasType<js_is_external>(env, handle) ||
      js_get_value_external(env, handle, &data) != 0 || data == nullptr) {
    js_throw_error(env, "InvalidArgument", "expected IdMapIndexFilter handle");
    return nullptr;
  }
  const auto* header = static_cast<const ExternalHeader*>(data);
  if (header->magic != EXTERNAL_MAGIC || header->kind != ExternalKind::Filter) {
    js_throw_error(env, "InvalidArgument", "expected IdMapIndexFilter handle");
    return nullptr;
  }
  return static_cast<VectorIndexFilterExternal*>(data);
}

VectorIndexFilter* unwrapFilter(js_env_t* env, js_value_t* handle) {
  VectorIndexFilterExternal* external = unwrapFilterExternal(env, handle);
  if (external == nullptr) {
    return nullptr;
  }
  if (external->filter == nullptr) {
    js_throw_error(
        env, "InvalidArgument", "IdMapIndexFilter has been disposed");
    return nullptr;
  }
  return external->filter;
}

// Read a JS object property and parse it as int32. Returns false if the
// property is missing, non-numeric, fractional, or outside int32 range.
bool readIntProp(
    js_env_t* env, js_value_t* obj, const char* name, int32_t* out) {
  js_value_t* val = nullptr;
  if (js_get_named_property(env, obj, name, &val) != 0) {
    return false;
  }
  bool isUndefined = false;
  if (js_is_undefined(env, val, &isUndefined) == 0 && isUndefined) {
    return false;
  }
  double raw = 0.0;
  if (!hasType<js_is_number>(env, val) ||
      js_get_value_double(env, val, &raw) != 0 || !std::isfinite(raw) ||
      raw != std::trunc(raw) ||
      raw < static_cast<double>(std::numeric_limits<int32_t>::min()) ||
      raw > static_cast<double>(std::numeric_limits<int32_t>::max())) {
    return false;
  }
  *out = static_cast<int32_t>(raw);
  return true;
}

void throwStatus(js_env_t* env, int code) {
  const char* name =
      verrors::toString(static_cast<verrors::VecIndexError>(code));
  js_throw_error(env, name, name);
}

js_value_t* makeUndefined(js_env_t* env) {
  js_value_t* value = nullptr;
  if (js_get_undefined(env, &value) != 0) {
    js_throw_error(env, "InternalError", "create undefined");
    return nullptr;
  }
  return value;
}

js_value_t* makeBoolean(js_env_t* env, bool value) {
  js_value_t* result = nullptr;
  if (js_get_boolean(env, value, &result) != 0) {
    js_throw_error(env, "InternalError", "create boolean");
    return nullptr;
  }
  return result;
}

js_value_t* makeInt32(js_env_t* env, int32_t value) {
  js_value_t* result = nullptr;
  if (js_create_int32(env, value, &result) != 0) {
    js_throw_error(env, "InternalError", "create int32");
    return nullptr;
  }
  return result;
}

bool getOptionalProperty(
    js_env_t* env, js_value_t* obj, const char* name, js_value_t** out,
    bool* hasValue) {
  *out = nullptr;
  *hasValue = false;
  if (js_get_named_property(env, obj, name, out) != 0) {
    js_throw_error(env, "InternalError", "failed to read option");
    return false;
  }
  bool isUndefined = false;
  if (js_is_undefined(env, *out, &isUndefined) != 0) {
    js_throw_error(env, "InternalError", "failed to inspect option");
    return false;
  }
  *hasValue = !isUndefined;
  return true;
}

bool readUtf8String(
    js_env_t* env, js_value_t* value, const char* typeError,
    const char* readError, std::string* out) {
  size_t len = 0;
  if (!hasType<js_is_string>(env, value) ||
      js_get_value_string_utf8(env, value, nullptr, 0, &len) != 0) {
    js_throw_type_error(env, "InvalidArgument", typeError);
    return false;
  }
  if (len == std::numeric_limits<size_t>::max()) {
    js_throw_range_error(env, "InvalidArgument", "string is too large");
    return false;
  }

  try {
    std::vector<utf8_t> buffer(len + 1);
    size_t copied = 0;
    if (js_get_value_string_utf8(
            env, value, buffer.data(), buffer.size(), &copied) != 0) {
      js_throw_error(env, "InternalError", readError);
      return false;
    }

    out->assign(reinterpret_cast<const char*>(buffer.data()), copied);
  } catch (const std::bad_alloc&) {
    js_throw_error(env, "OutOfMemory", "allocation failure");
    return false;
  }
  // Strings reach the C API NUL-terminated, so an embedded NUL would
  // silently cut a path short.
  if (out->find('\0') != std::string::npos) {
    js_throw_type_error(
        env, "InvalidArgument", "string must not contain NUL characters");
    return false;
  }
  return true;
}

bool readFloat32Array(
    js_env_t* env, js_value_t* value, const char* name, const float** outData,
    size_t* outLen) {
  js_typedarray_type_t type{};
  void* data = nullptr;
  size_t len = 0;
  if (!hasType<js_is_typedarray>(env, value) ||
      js_get_typedarray_info(
          env, value, &type, &data, &len, nullptr, nullptr) != 0 ||
      type != js_float32array) {
    const std::string message = std::string(name) + " must be a Float32Array";
    js_throw_type_error(env, "InvalidArgument", message.c_str());
    return false;
  }

  *outData = static_cast<const float*>(data);
  *outLen = len;
  return true;
}

bool readBigUint64Array(
    js_env_t* env, js_value_t* value, const char* name,
    const uint64_t** outData, size_t* outLen) {
  js_typedarray_type_t type{};
  void* data = nullptr;
  size_t len = 0;
  if (!hasType<js_is_typedarray>(env, value) ||
      js_get_typedarray_info(
          env, value, &type, &data, &len, nullptr, nullptr) != 0 ||
      type != js_biguint64array) {
    const std::string message = std::string(name) + " must be a BigUint64Array";
    js_throw_type_error(env, "InvalidArgument", message.c_str());
    return false;
  }

  *outData = static_cast<const uint64_t*>(data);
  *outLen = len;
  return true;
}

bool readPositiveInt32(
    js_env_t* env, js_value_t* value, const char* name, int32_t* out) {
  double raw = 0.0;
  if (!hasType<js_is_number>(env, value) ||
      js_get_value_double(env, value, &raw) != 0 || !std::isfinite(raw) ||
      raw != std::trunc(raw) || raw <= 0.0 ||
      raw > static_cast<double>(std::numeric_limits<int32_t>::max())) {
    const std::string message = std::string(name) + " must be a positive int";
    js_throw_type_error(env, "InvalidArgument", message.c_str());
    return false;
  }
  *out = static_cast<int32_t>(raw);
  return true;
}

bool readNonnegativeInt32(
    js_env_t* env, js_value_t* value, const char* name, int32_t* out) {
  double raw = 0.0;
  if (!hasType<js_is_number>(env, value) ||
      js_get_value_double(env, value, &raw) != 0 || !std::isfinite(raw) ||
      raw != std::trunc(raw) || raw < 0.0 ||
      raw > static_cast<double>(std::numeric_limits<int32_t>::max())) {
    const std::string message =
        std::string(name) + " must be a non-negative int";
    js_throw_type_error(env, "InvalidArgument", message.c_str());
    return false;
  }
  *out = static_cast<int32_t>(raw);
  return true;
}

bool readId(js_env_t* env, js_value_t* value, uint64_t* out) {
  bool lossless = false;
  if (!hasType<js_is_bigint>(env, value) ||
      js_get_value_bigint_uint64(env, value, out, &lossless) != 0 ||
      !lossless) {
    js_throw_type_error(
        env,
        "InvalidArgument",
        "id must be an unsigned BigInt fitting in 64 bits");
    return false;
  }
  return true;
}

// Reads an allow-list. An empty list comes back as (nullptr, 0), which is
// what fabric expects.
bool readAllowedIds(
    js_env_t* env, js_value_t* value, const uint64_t** outIds, int* outCount) {
  const uint64_t* ids = nullptr;
  size_t len = 0;
  if (!readBigUint64Array(env, value, "allowed_ids", &ids, &len)) {
    return false;
  }
  if (len > static_cast<size_t>(INT32_MAX)) {
    js_throw_range_error(env, "InvalidArgument", "too many allowed ids");
    return false;
  }
  *outIds = len == 0 ? nullptr : ids;
  *outCount = static_cast<int>(len);
  return true;
}

struct VectorBatchInput {
  const float* vectors = nullptr;
  const uint64_t* ids = nullptr;
  int n = 0;
};

bool readVectorBatch(
    js_env_t* env, const VectorIndex* idx, js_value_t* vectorsValue,
    js_value_t* idsValue, VectorBatchInput* out) {
  const float* vectors = nullptr;
  size_t vlen = 0;
  if (!readFloat32Array(env, vectorsValue, "vectors", &vectors, &vlen)) {
    return false;
  }

  const uint64_t* ids = nullptr;
  size_t ilen = 0;
  if (!readBigUint64Array(env, idsValue, "ids", &ids, &ilen)) {
    return false;
  }

  const int dim = idx->dim();
  if (dim <= 0) {
    js_throw_error(env, "InternalError", "index has invalid dim");
    return false;
  }
  const size_t dimSize = static_cast<size_t>(dim);
  if (ilen > std::numeric_limits<size_t>::max() / dimSize ||
      vlen != ilen * dimSize) {
    js_throw_range_error(
        env, "InvalidArgument", "vectors.length must equal ids.length * dim");
    return false;
  }
  if (ilen > static_cast<size_t>(INT32_MAX)) {
    js_throw_range_error(env, "InvalidArgument", "too many vectors in batch");
    return false;
  }
  const uint64_t paddingId = std::numeric_limits<uint64_t>::max();
  for (size_t i = 0; i < ilen; i++) {
    if (ids[i] == paddingId) {
      js_throw_range_error(
          env,
          "InvalidArgument",
          "UINT64_MAX is reserved for search result padding");
      return false;
    }
  }

  out->vectors = vectors;
  out->ids = ids;
  out->n = static_cast<int>(ilen);
  return true;
}

bool createSearchOutput(
    js_env_t* env, const VectorIndex* idx, size_t qlen, int32_t k, int* outM,
    SearchOutput* out) {
  const int dim = idx->dim();
  if (dim <= 0 || qlen % static_cast<size_t>(dim) != 0) {
    js_throw_range_error(
        env, "InvalidArgument", "queries.length must be a multiple of dim");
    return false;
  }

  const size_t m = qlen / static_cast<size_t>(dim);
  if (m > static_cast<size_t>(INT32_MAX)) {
    js_throw_range_error(env, "InvalidArgument", "too many queries");
    return false;
  }

  const size_t kSize = static_cast<size_t>(k);
  const size_t maxSize = std::numeric_limits<size_t>::max();
  if (m != 0 && kSize > maxSize / m) {
    js_throw_range_error(env, "InvalidArgument", "search result is too large");
    return false;
  }

  const size_t total = m * kSize;
  if (total > maxSize / sizeof(uint64_t)) {
    js_throw_range_error(env, "InvalidArgument", "search result is too large");
    return false;
  }

  void* scoresData = nullptr;
  js_value_t* scoresAb = nullptr;
  if (js_create_arraybuffer(
          env, total * sizeof(float), &scoresData, &scoresAb) != 0) {
    js_throw_error(env, "OutOfMemory", "scores arraybuffer");
    return false;
  }

  void* idsData = nullptr;
  js_value_t* idsAb = nullptr;
  if (js_create_arraybuffer(env, total * sizeof(uint64_t), &idsData, &idsAb) !=
      0) {
    js_throw_error(env, "OutOfMemory", "ids arraybuffer");
    return false;
  }

  *outM = static_cast<int>(m);
  out->total = total;
  out->scoresData = scoresData;
  out->scoresBuffer = scoresAb;
  out->idsData = idsData;
  out->idsBuffer = idsAb;
  return true;
}

struct SearchInput {
  const float* queries = nullptr;
  int m = 0;
  int32_t k = 0;
  SearchOutput output;
};

bool readSearchInput(
    js_env_t* env, const VectorIndex* idx, js_value_t* queriesValue,
    js_value_t* kValue, SearchInput* out) {
  size_t qlen = 0;
  if (!readFloat32Array(env, queriesValue, "queries", &out->queries, &qlen)) {
    return false;
  }

  if (!readPositiveInt32(env, kValue, "k", &out->k)) {
    return false;
  }

  return createSearchOutput(env, idx, qlen, out->k, &out->m, &out->output);
}

js_value_t* finishSearchResult(
    js_env_t* env, const SearchOutput& output, int m, int32_t k) {
  js_value_t* scoresTa = nullptr;
  if (js_create_typedarray(
          env,
          js_float32array,
          output.total,
          output.scoresBuffer,
          0,
          &scoresTa) != 0) {
    js_throw_error(env, "InternalError", "create scores typedarray");
    return nullptr;
  }

  js_value_t* idsTa = nullptr;
  if (js_create_typedarray(
          env, js_biguint64array, output.total, output.idsBuffer, 0, &idsTa) !=
      0) {
    js_throw_error(env, "InternalError", "create ids typedarray");
    return nullptr;
  }

  js_value_t* result = nullptr;
  if (js_create_object(env, &result) != 0) {
    js_throw_error(env, "InternalError", "create result object");
    return nullptr;
  }
  if (js_set_named_property(env, result, "scores", scoresTa) != 0 ||
      js_set_named_property(env, result, "ids", idsTa) != 0) {
    js_throw_error(env, "InternalError", "set result fields");
    return nullptr;
  }

  js_value_t* mVal = nullptr;
  js_value_t* kVal = nullptr;
  if (js_create_uint32(env, static_cast<uint32_t>(m), &mVal) != 0 ||
      js_create_int32(env, k, &kVal) != 0 ||
      js_set_named_property(env, result, "m", mVal) != 0 ||
      js_set_named_property(env, result, "k", kVal) != 0) {
    js_throw_error(env, "InternalError", "set result dimensions");
    return nullptr;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

// idxCreate({ dim, storage }) -> external handle. The JS wrapper resolves
// `bitWidth` to a storage name before calling in.
js_value_t* idxCreate(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 1;
  js_value_t* argv[1] = {nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 1 || !hasType<js_is_object>(env, argv[0])) {
    js_throw_type_error(env, "InvalidArgument", "expected { dim, storage }");
    return nullptr;
  }
  int32_t dim = 0;
  if (!readIntProp(env, argv[0], "dim", &dim)) {
    js_throw_type_error(env, "InvalidArgument", "missing or invalid `dim`");
    return nullptr;
  }
  js_value_t* storageValue = nullptr;
  bool hasStorage = false;
  if (!getOptionalProperty(
          env, argv[0], "storage", &storageValue, &hasStorage)) {
    return nullptr;
  }
  if (!hasStorage) {
    js_throw_type_error(env, "InvalidArgument", "missing `storage`");
    return nullptr;
  }
  std::string storageName;
  if (!readUtf8String(
          env,
          storageValue,
          "storage must be a string",
          "failed to read storage string",
          &storageName)) {
    return nullptr;
  }
  const auto storage = turbovec_ggml::parseVectorStorage(storageName);
  if (!storage.has_value()) {
    js_throw_type_error(env, "InvalidArgument", "invalid `storage`");
    return nullptr;
  }

  VectorIndex* idx = nullptr;
  try {
    idx = new VectorIndex(dim, *storage);
  } catch (const std::invalid_argument& e) {
    js_throw_error(env, "InvalidArgument", e.what());
    return nullptr;
  } catch (const std::bad_alloc&) {
    js_throw_error(env, "OutOfMemory", "allocation failure");
    return nullptr;
  }
  return wrap(env, idx);
}

// idxLoad(path) -> external handle (throws on file errors).
js_value_t* idxLoad(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 1;
  js_value_t* argv[1] = {nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 1) {
    js_throw_type_error(env, "InvalidArgument", "expected path string");
    return nullptr;
  }
  std::string path;
  if (!readUtf8String(
          env,
          argv[0],
          "path must be a string",
          "failed to read path string",
          &path)) {
    return nullptr;
  }

  int status = 0;
  VectorIndex loaded = VectorIndex::load(path, &status);
  if (status != 0) {
    throwStatus(env, status);
    return nullptr;
  }
  if (!loaded.valid()) {
    js_throw_error(env, "InternalError", "load succeeded without an index");
    return nullptr;
  }
  try {
    // Move the wrapper onto the heap so we can hand JS an owning external.
    auto* heap = new VectorIndex(std::move(loaded));
    return wrap(env, heap);
  } catch (const std::bad_alloc&) {
    js_throw_error(env, "OutOfMemory", "allocation failure");
    return nullptr;
  }
}

// idxLoadMmap(path) -> external handle (throws on file errors).
js_value_t* idxLoadMmap(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 1;
  js_value_t* argv[1] = {nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 1) {
    js_throw_type_error(env, "InvalidArgument", "expected path string");
    return nullptr;
  }
  std::string path;
  if (!readUtf8String(
          env,
          argv[0],
          "path must be a string",
          "failed to read path string",
          &path)) {
    return nullptr;
  }

  int status = 0;
  VectorIndex loaded = VectorIndex::loadMmap(path, &status);
  if (status != 0) {
    throwStatus(env, status);
    return nullptr;
  }
  if (!loaded.valid()) {
    js_throw_error(
        env, "InternalError", "mmap load succeeded without an index");
    return nullptr;
  }
  try {
    // Move the wrapper onto the heap so we can hand JS an owning external.
    auto* heap = new VectorIndex(std::move(loaded));
    return wrap(env, heap);
  } catch (const std::bad_alloc&) {
    js_throw_error(env, "OutOfMemory", "allocation failure");
    return nullptr;
  }
}

// idxLoadWithDelta(snapshotPath, deltaPath) -> external handle.
js_value_t* idxLoadWithDelta(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 2;
  js_value_t* argv[2] = {nullptr, nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 2) {
    js_throw_type_error(
        env, "InvalidArgument", "expected (snapshotPath, deltaPath)");
    return nullptr;
  }

  std::string snapshotPath;
  if (!readUtf8String(
          env,
          argv[0],
          "snapshotPath must be a string",
          "failed to read snapshot path string",
          &snapshotPath)) {
    return nullptr;
  }
  std::string deltaPath;
  if (!readUtf8String(
          env,
          argv[1],
          "deltaPath must be a string",
          "failed to read delta path string",
          &deltaPath)) {
    return nullptr;
  }

  int status = 0;
  VectorIndex loaded =
      VectorIndex::loadWithDelta(snapshotPath, deltaPath, &status);
  if (status != 0) {
    throwStatus(env, status);
    return nullptr;
  }
  if (!loaded.valid()) {
    js_throw_error(
        env, "InternalError", "delta load succeeded without an index");
    return nullptr;
  }
  try {
    auto* heap = new VectorIndex(std::move(loaded));
    return wrap(env, heap);
  } catch (const std::bad_alloc&) {
    js_throw_error(env, "OutOfMemory", "allocation failure");
    return nullptr;
  }
}

// idxAdd(handle, Float32Array vectors, BigUint64Array ids) -> undefined
js_value_t* idxAdd(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 3;
  js_value_t* argv[3] = {nullptr, nullptr, nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 3) {
    js_throw_type_error(
        env,
        "InvalidArgument",
        "expected (handle, vectors:Float32Array, ids:BigUint64Array)");
    return nullptr;
  }
  VectorIndex* idx = unwrap(env, argv[0]);
  if (idx == nullptr) {
    return nullptr;
  }

  VectorBatchInput batch;
  if (!readVectorBatch(env, idx, argv[1], argv[2], &batch)) {
    return nullptr;
  }

  const int rc = idx->add(batch.vectors, batch.n, batch.ids);
  if (rc != 0) {
    throwStatus(env, rc);
    return nullptr;
  }
  return makeUndefined(env);
}

// idxAddLogged(handle, Float32Array vectors, BigUint64Array ids, deltaPath)
//   -> undefined
js_value_t* idxAddLogged(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 4;
  js_value_t* argv[4] = {nullptr, nullptr, nullptr, nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 4) {
    js_throw_type_error(
        env,
        "InvalidArgument",
        "expected (handle, vectors:Float32Array, ids:BigUint64Array, "
        "deltaPath)");
    return nullptr;
  }
  VectorIndex* idx = unwrap(env, argv[0]);
  if (idx == nullptr) {
    return nullptr;
  }

  VectorBatchInput batch;
  if (!readVectorBatch(env, idx, argv[1], argv[2], &batch)) {
    return nullptr;
  }

  std::string deltaPath;
  if (!readUtf8String(
          env,
          argv[3],
          "deltaPath must be a string",
          "failed to read delta path",
          &deltaPath)) {
    return nullptr;
  }

  const int rc = idx->addLogged(batch.vectors, batch.n, batch.ids, deltaPath);
  if (rc != 0) {
    throwStatus(env, rc);
    return nullptr;
  }
  return makeUndefined(env);
}

// idxSearch(handle, Float32Array queries, int k)
//   -> { scores: Float32Array(m*k), ids: BigUint64Array(m*k), m, k }
js_value_t* idxSearch(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 3;
  js_value_t* argv[3] = {nullptr, nullptr, nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 3) {
    js_throw_type_error(
        env,
        "InvalidArgument",
        "expected (handle, queries:Float32Array, k:number)");
    return nullptr;
  }
  VectorIndex* idx = unwrap(env, argv[0]);
  if (idx == nullptr) {
    return nullptr;
  }

  SearchInput input;
  if (!readSearchInput(env, idx, argv[1], argv[2], &input)) {
    return nullptr;
  }

  const int rc = idx->search(
      input.queries,
      input.m,
      input.k,
      static_cast<float*>(input.output.scoresData),
      static_cast<uint64_t*>(input.output.idsData));
  if (rc != 0) {
    throwStatus(env, rc);
    return nullptr;
  }

  return finishSearchResult(env, input.output, input.m, input.k);
}

// idxSearchFiltered(handle, Float32Array queries, int k, BigUint64Array ids)
//   -> { scores: Float32Array(m*k), ids: BigUint64Array(m*k), m, k }
js_value_t* idxSearchFiltered(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 4;
  js_value_t* argv[4] = {nullptr, nullptr, nullptr, nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 4) {
    js_throw_type_error(
        env,
        "InvalidArgument",
        "expected (handle, queries:Float32Array, k:number, "
        "allowedIds:BigUint64Array)");
    return nullptr;
  }
  VectorIndex* idx = unwrap(env, argv[0]);
  if (idx == nullptr) {
    return nullptr;
  }

  SearchInput input;
  if (!readSearchInput(env, idx, argv[1], argv[2], &input)) {
    return nullptr;
  }

  const uint64_t* allowedIds = nullptr;
  int nAllowed = 0;
  if (!readAllowedIds(env, argv[3], &allowedIds, &nAllowed)) {
    return nullptr;
  }

  const int rc = idx->searchFiltered(
      input.queries,
      input.m,
      input.k,
      allowedIds,
      nAllowed,
      static_cast<float*>(input.output.scoresData),
      static_cast<uint64_t*>(input.output.idsData));
  if (rc != 0) {
    throwStatus(env, rc);
    return nullptr;
  }

  return finishSearchResult(env, input.output, input.m, input.k);
}

// idxFilterCreate(handle, BigUint64Array allowedIds) -> external filter
js_value_t* idxFilterCreate(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 2;
  js_value_t* argv[2] = {nullptr, nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 2) {
    js_throw_type_error(
        env, "InvalidArgument", "expected (handle, allowedIds:BigUint64Array)");
    return nullptr;
  }
  VectorIndex* idx = unwrap(env, argv[0]);
  if (idx == nullptr) {
    return nullptr;
  }

  const uint64_t* allowedIds = nullptr;
  int nAllowed = 0;
  if (!readAllowedIds(env, argv[1], &allowedIds, &nAllowed)) {
    return nullptr;
  }

  VectorIndexFilter filter = idx->createFilter(allowedIds, nAllowed);
  if (!filter.valid()) {
    js_throw_error(
        env, "InvalidArgument", "ggml_vec_index_filter_create returned null");
    return nullptr;
  }

  try {
    auto* heap = new VectorIndexFilter(std::move(filter));
    return wrapFilter(env, heap);
  } catch (const std::bad_alloc&) {
    js_throw_error(env, "OutOfMemory", "allocation failure");
    return nullptr;
  }
}

// idxSearchPreparedFiltered(handle, filter, Float32Array queries, int k)
//   -> { scores: Float32Array(m*k), ids: BigUint64Array(m*k), m, k }
js_value_t* idxSearchPreparedFiltered(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 4;
  js_value_t* argv[4] = {nullptr, nullptr, nullptr, nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 4) {
    js_throw_type_error(
        env,
        "InvalidArgument",
        "expected (handle, filter, queries:Float32Array, k:number)");
    return nullptr;
  }
  VectorIndex* idx = unwrap(env, argv[0]);
  if (idx == nullptr) {
    return nullptr;
  }
  VectorIndexFilter* filter = unwrapFilter(env, argv[1]);
  if (filter == nullptr) {
    return nullptr;
  }

  SearchInput input;
  if (!readSearchInput(env, idx, argv[2], argv[3], &input)) {
    return nullptr;
  }

  const int rc = idx->searchPreparedFiltered(
      *filter,
      input.queries,
      input.m,
      input.k,
      static_cast<float*>(input.output.scoresData),
      static_cast<uint64_t*>(input.output.idsData));
  if (rc != 0) {
    throwStatus(env, rc);
    return nullptr;
  }

  return finishSearchResult(env, input.output, input.m, input.k);
}

// idxBuildIvf(handle, nLists:number, nIter:number) -> undefined
js_value_t* idxBuildIvf(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 3;
  js_value_t* argv[3] = {nullptr, nullptr, nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 3) {
    js_throw_type_error(
        env,
        "InvalidArgument",
        "expected (handle, nLists:number, nIter:number)");
    return nullptr;
  }
  VectorIndex* idx = unwrap(env, argv[0]);
  if (idx == nullptr) {
    return nullptr;
  }

  int32_t nLists = 0;
  if (!readPositiveInt32(env, argv[1], "n_lists", &nLists)) {
    return nullptr;
  }

  int32_t nIter = 0;
  if (!readNonnegativeInt32(env, argv[2], "n_iter", &nIter)) {
    return nullptr;
  }

  const int rc = idx->buildIvf(nLists, nIter);
  if (rc != 0) {
    throwStatus(env, rc);
    return nullptr;
  }

  return makeUndefined(env);
}

// idxSearchIvf(handle, Float32Array queries, int k, int nProbe)
//   -> { scores: Float32Array(m*k), ids: BigUint64Array(m*k), m, k }
js_value_t* idxSearchIvf(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 4;
  js_value_t* argv[4] = {nullptr, nullptr, nullptr, nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 4) {
    js_throw_type_error(
        env,
        "InvalidArgument",
        "expected (handle, queries:Float32Array, k:number, nProbe:number)");
    return nullptr;
  }
  VectorIndex* idx = unwrap(env, argv[0]);
  if (idx == nullptr) {
    return nullptr;
  }

  SearchInput input;
  if (!readSearchInput(env, idx, argv[1], argv[2], &input)) {
    return nullptr;
  }

  int32_t nProbe = 0;
  if (!readPositiveInt32(env, argv[3], "n_probe", &nProbe)) {
    return nullptr;
  }

  const int rc = idx->searchIvf(
      input.queries,
      input.m,
      input.k,
      nProbe,
      static_cast<float*>(input.output.scoresData),
      static_cast<uint64_t*>(input.output.idsData));
  if (rc != 0) {
    throwStatus(env, rc);
    return nullptr;
  }

  return finishSearchResult(env, input.output, input.m, input.k);
}

// idxRemove(handle, id:bigint) -> boolean
js_value_t* idxRemove(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 2;
  js_value_t* argv[2] = {nullptr, nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 2) {
    js_throw_type_error(env, "InvalidArgument", "expected (handle, id:bigint)");
    return nullptr;
  }
  VectorIndex* idx = unwrap(env, argv[0]);
  if (idx == nullptr) {
    return nullptr;
  }

  uint64_t id = 0;
  if (!readId(env, argv[1], &id)) {
    return nullptr;
  }

  const int rc = idx->remove(id);
  if (rc == GGML_VEC_INDEX_E_NOT_FOUND) {
    return makeBoolean(env, false);
  }
  if (rc != GGML_VEC_INDEX_OK) {
    throwStatus(env, rc);
    return nullptr;
  }
  return makeBoolean(env, true);
}

// idxRemoveLogged(handle, id:bigint, deltaPath) -> boolean
js_value_t* idxRemoveLogged(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 3;
  js_value_t* argv[3] = {nullptr, nullptr, nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 3) {
    js_throw_type_error(
        env, "InvalidArgument", "expected (handle, id:bigint, deltaPath)");
    return nullptr;
  }
  VectorIndex* idx = unwrap(env, argv[0]);
  if (idx == nullptr) {
    return nullptr;
  }

  uint64_t id = 0;
  if (!readId(env, argv[1], &id)) {
    return nullptr;
  }

  std::string deltaPath;
  if (!readUtf8String(
          env,
          argv[2],
          "deltaPath must be a string",
          "failed to read delta path",
          &deltaPath)) {
    return nullptr;
  }

  const int rc = idx->removeLogged(id, deltaPath);
  if (rc == GGML_VEC_INDEX_E_NOT_FOUND) {
    return makeBoolean(env, false);
  }
  if (rc != GGML_VEC_INDEX_OK) {
    throwStatus(env, rc);
    return nullptr;
  }
  return makeBoolean(env, true);
}

// idxCompact(handle) -> undefined
js_value_t* idxCompact(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 1;
  js_value_t* argv[1] = {nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  VectorIndex* idx = unwrap(env, argv[0]);
  if (idx == nullptr) {
    return nullptr;
  }

  const int rc = idx->compact();
  if (rc != 0) {
    throwStatus(env, rc);
    return nullptr;
  }
  return makeUndefined(env);
}

// idxContains(handle, id:bigint) -> boolean
js_value_t* idxContains(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 2;
  js_value_t* argv[2] = {nullptr, nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 2) {
    js_throw_type_error(env, "InvalidArgument", "expected (handle, id:bigint)");
    return nullptr;
  }
  VectorIndex* idx = unwrap(env, argv[0]);
  if (idx == nullptr) {
    return nullptr;
  }

  uint64_t id = 0;
  if (!readId(env, argv[1], &id)) {
    return nullptr;
  }
  return makeBoolean(env, idx->contains(id));
}

// idxPrepare(handle) -> undefined (warms storage-specific native caches).
js_value_t* idxPrepare(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 1;
  js_value_t* argv[1] = {nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  VectorIndex* idx = unwrap(env, argv[0]);
  if (idx == nullptr) {
    return nullptr;
  }
  idx->prepare();
  return makeUndefined(env);
}

// idxWrite(handle, path) -> undefined; throws on IO error.
js_value_t* idxWrite(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 2;
  js_value_t* argv[2] = {nullptr, nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 2) {
    js_throw_type_error(env, "InvalidArgument", "expected (handle, path)");
    return nullptr;
  }
  VectorIndex* idx = unwrap(env, argv[0]);
  if (idx == nullptr) {
    return nullptr;
  }

  std::string path;
  if (!readUtf8String(
          env,
          argv[1],
          "path must be a string",
          "failed to read path",
          &path)) {
    return nullptr;
  }

  const int rc = idx->write(path);
  if (rc != 0) {
    throwStatus(env, rc);
    return nullptr;
  }
  return makeUndefined(env);
}

// idxCompactDelta(handle, snapshotPath, deltaPath) -> undefined.
js_value_t* idxCompactDelta(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 3;
  js_value_t* argv[3] = {nullptr, nullptr, nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 3) {
    js_throw_type_error(
        env, "InvalidArgument", "expected (handle, snapshotPath, deltaPath)");
    return nullptr;
  }
  VectorIndex* idx = unwrap(env, argv[0]);
  if (idx == nullptr) {
    return nullptr;
  }

  std::string snapshotPath;
  if (!readUtf8String(
          env,
          argv[1],
          "snapshotPath must be a string",
          "failed to read snapshot path",
          &snapshotPath)) {
    return nullptr;
  }
  std::string deltaPath;
  if (!readUtf8String(
          env,
          argv[2],
          "deltaPath must be a string",
          "failed to read delta path",
          &deltaPath)) {
    return nullptr;
  }

  const int rc = idx->compactDelta(snapshotPath, deltaPath);
  if (rc != 0) {
    throwStatus(env, rc);
    return nullptr;
  }

  return makeUndefined(env);
}

// idxDispose(handle) -> undefined. Frees the native index immediately; the
// JS external finalizer remains safe and becomes a no-op for the index.
js_value_t* idxDispose(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 1;
  js_value_t* argv[1] = {nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 1) {
    js_throw_type_error(env, "InvalidArgument", "expected handle");
    return nullptr;
  }
  VectorIndexExternal* external = unwrapExternal(env, argv[0]);
  if (external == nullptr) {
    return nullptr;
  }
  if (external->busy) {
    throwBusy(env, "IdMapIndex");
    return nullptr;
  }

  delete external->idx;
  external->idx = nullptr;

  return makeUndefined(env);
}

// idxFilterDispose(filter) -> undefined.
js_value_t* idxFilterDispose(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 1;
  js_value_t* argv[1] = {nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 1) {
    js_throw_type_error(env, "InvalidArgument", "expected filter handle");
    return nullptr;
  }
  VectorIndexFilterExternal* external = unwrapFilterExternal(env, argv[0]);
  if (external == nullptr) {
    return nullptr;
  }
  if (external->busy) {
    throwBusy(env, "IdMapIndexFilter");
    return nullptr;
  }

  delete external->filter;
  external->filter = nullptr;

  return makeUndefined(env);
}

// Generic int32 getter for len/dim/bitWidth.
template <int (VectorIndex::*Fn)() const noexcept>
js_value_t* idxIntGetter(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 1;
  js_value_t* argv[1] = {nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  VectorIndex* idx = unwrap(env, argv[0]);
  if (idx == nullptr) {
    return nullptr;
  }
  return makeInt32(env, (idx->*Fn)());
}

js_value_t* idxCalibrated(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 1;
  js_value_t* argv[1] = {nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  VectorIndex* idx = unwrap(env, argv[0]);
  if (idx == nullptr) {
    return nullptr;
  }
  return makeBoolean(env, idx->calibrated());
}

// idxSetStaged(handle, enabled:boolean) -> undefined
js_value_t* idxSetStaged(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 2;
  js_value_t* argv[2] = {nullptr, nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 2) {
    js_throw_type_error(
        env, "InvalidArgument", "expected (handle, enabled:boolean)");
    return nullptr;
  }
  VectorIndex* idx = unwrap(env, argv[0]);
  if (idx == nullptr) {
    return nullptr;
  }
  bool enabled = false;
  if (js_get_value_bool(env, argv[1], &enabled) != 0) {
    js_throw_type_error(env, "InvalidArgument", "enabled must be a boolean");
    return nullptr;
  }
  const int rc = idx->setStaged(enabled);
  if (rc != 0) {
    throwStatus(env, rc);
    return nullptr;
  }
  return makeUndefined(env);
}

js_value_t* idxStaged(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 1;
  js_value_t* argv[1] = {nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  VectorIndex* idx = unwrap(env, argv[0]);
  if (idx == nullptr) {
    return nullptr;
  }
  return makeBoolean(env, idx->staged());
}

// ---------------------------------------------------------------------------
// Async bindings
// ---------------------------------------------------------------------------
//
// Each reads and checks its arguments on the JS thread exactly as its sync
// twin does, copies the input arrays, then runs the native call on a job
// lane and returns a promise that settles with the same value or error. The
// copies matter: JS can change or detach an array (`buffer.transfer()`) while
// a worker thread runs, so a job never reads JS memory. The index, and the
// filter for a prepared search, is busy until the promise settles: one job
// runs on an index at a time and every other call on it is rejected, so the
// JS thread never waits on fabric's index lock. The JS wrapper queues calls
// per index to keep their order.

namespace async_job = turbovec_ggml::async_job;
using async_job::Lane;

using JobKept = std::vector<js_value_t*>;
using JobSettle = std::function<js_value_t*(js_env_t*, int, const JobKept&)>;

template <typename T> using Owned = std::shared_ptr<const std::vector<T>>;

// Copies `len` elements for a job. Throws OutOfMemory and returns false on
// allocation failure.
template <typename T>
bool copyInput(js_env_t* env, const T* data, size_t len, Owned<T>* out) {
  try {
    *out = len == 0 ? std::make_shared<const std::vector<T>>()
                    : std::make_shared<const std::vector<T>>(data, data + len);
  } catch (const std::bad_alloc&) {
    js_throw_error(env, "OutOfMemory", "allocation failure");
    return false;
  }
  return true;
}

// The copy's data, or nullptr for an empty one, as fabric expects for an
// empty allow-list.
template <typename T> const T* dataOrNull(const Owned<T>& owned) {
  return owned->empty() ? nullptr : owned->data();
}

js_value_t*
settleUndefined(js_env_t* env, int status, const JobKept& /*kept*/) {
  if (status != GGML_VEC_INDEX_OK) {
    throwStatus(env, status);
    return nullptr;
  }
  return makeUndefined(env);
}

js_value_t* settleRemoved(js_env_t* env, int status, const JobKept& /*kept*/) {
  if (status == GGML_VEC_INDEX_E_NOT_FOUND) {
    return makeBoolean(env, false);
  }
  if (status != GGML_VEC_INDEX_OK) {
    throwStatus(env, status);
    return nullptr;
  }
  return makeBoolean(env, true);
}

// Starts a job on a live, idle index. `keepAlive` must hold the index handle,
// and the filter handle when `filter` is set, so neither external can be
// collected before the job settles and clears its busy flag.
js_value_t* startIndexJob(
    js_env_t* env, Lane lane, VectorIndexExternal* external,
    VectorIndexFilterExternal* filter,
    std::initializer_list<js_value_t*> keepAlive, async_job::Work work,
    JobSettle settle) {
  external->busy = true;
  if (filter != nullptr) {
    filter->busy = true;
  }
  js_value_t* promise = nullptr;
  try {
    promise = async_job::start(
        env,
        lane,
        keepAlive,
        std::move(work),
        [external, filter, settle = std::move(settle)](
            js_env_t* jobEnv, int status, const JobKept& kept) {
          external->busy = false;
          if (filter != nullptr) {
            filter->busy = false;
          }
          return settle(jobEnv, status, kept);
        });
  } catch (const std::bad_alloc&) {
    js_throw_error(env, "OutOfMemory", "allocation failure");
  }
  if (promise == nullptr) {
    external->busy = false;
    if (filter != nullptr) {
      filter->busy = false;
    }
  }
  return promise;
}

// Search jobs keep (handle, scores buffer, ids buffer, filter handle) alive.
// The result buffers are created here and handed to JS only on success, so
// no JS code can reach them while the job writes them.
constexpr size_t SEARCH_KEPT_SCORES = 1;
constexpr size_t SEARCH_KEPT_IDS = 2;

struct SearchJob {
  Owned<float> queries;
  int m = 0;
  int32_t k = 0;
  SearchOutput output;
};

using SearchCall = std::function<int(const SearchJob&)>;

// Reads queries and k like readSearchInput(), but copies the queries.
bool readSearchJob(
    js_env_t* env, const VectorIndex* idx, js_value_t* queriesValue,
    js_value_t* kValue, SearchJob* out) {
  SearchInput input;
  if (!readSearchInput(env, idx, queriesValue, kValue, &input)) {
    return false;
  }
  const size_t qlen =
      static_cast<size_t>(input.m) * static_cast<size_t>(idx->dim());
  if (!copyInput(env, input.queries, qlen, &out->queries)) {
    return false;
  }
  out->m = input.m;
  out->k = input.k;
  out->output = input.output;
  return true;
}

js_value_t* startSearchJob(
    js_env_t* env, VectorIndexExternal* external,
    VectorIndexFilterExternal* filter, js_value_t* handle,
    js_value_t* filterHandle, const SearchJob& job, SearchCall call) {
  return startIndexJob(
      env,
      Lane::Search,
      external,
      filter,
      {handle, job.output.scoresBuffer, job.output.idsBuffer, filterHandle},
      [job, call = std::move(call)]() { return call(job); },
      [job](js_env_t* jobEnv, int status, const JobKept& kept) {
        if (status != GGML_VEC_INDEX_OK) {
          throwStatus(jobEnv, status);
          return static_cast<js_value_t*>(nullptr);
        }
        SearchOutput output = job.output;
        output.scoresBuffer = kept[SEARCH_KEPT_SCORES];
        output.idsBuffer = kept[SEARCH_KEPT_IDS];
        return finishSearchResult(jobEnv, output, job.m, job.k);
      });
}

// Runs a load on the bulk lane and resolves with a new index handle.
js_value_t* startLoadJob(js_env_t* env, std::function<VectorIndex(int*)> load) {
  std::shared_ptr<std::unique_ptr<VectorIndex>> loaded;
  try {
    loaded = std::make_shared<std::unique_ptr<VectorIndex>>();
    return async_job::start(
        env,
        Lane::Bulk,
        {},
        [loaded, load = std::move(load)]() {
          int status = GGML_VEC_INDEX_OK;
          VectorIndex index = load(&status);
          if (status != GGML_VEC_INDEX_OK) {
            return status;
          }
          if (!index.valid()) {
            return static_cast<int>(GGML_VEC_INDEX_E_INTERNAL);
          }
          *loaded = std::make_unique<VectorIndex>(std::move(index));
          return static_cast<int>(GGML_VEC_INDEX_OK);
        },
        [loaded](js_env_t* jobEnv, int status, const JobKept& /*kept*/) {
          if (status != GGML_VEC_INDEX_OK) {
            throwStatus(jobEnv, status);
            return static_cast<js_value_t*>(nullptr);
          }
          // wrap() takes ownership, and frees the index if it fails.
          return wrap(jobEnv, loaded->release());
        });
  } catch (const std::bad_alloc&) {
    js_throw_error(env, "OutOfMemory", "allocation failure");
    return nullptr;
  }
}

// Reads one UTF-8 string argument per name, starting at argv[first].
bool readPathArgs(
    js_env_t* env, js_value_t* const* argv, size_t first,
    std::initializer_list<const char*> names, std::vector<std::string>* out) {
  size_t i = first;
  for (const char* name : names) {
    std::string value;
    const std::string typeError = std::string(name) + " must be a string";
    const std::string readError = std::string("failed to read ") + name;
    if (!readUtf8String(
            env, argv[i], typeError.c_str(), readError.c_str(), &value)) {
      return false;
    }
    out->push_back(std::move(value));
    ++i;
  }
  return true;
}

// Reads and copies an add batch, checked as the sync add checks it.
struct BatchJob {
  Owned<float> vectors;
  Owned<uint64_t> ids;
  int n = 0;
};

bool readBatchJob(
    js_env_t* env, const VectorIndex* idx, js_value_t* vectorsValue,
    js_value_t* idsValue, BatchJob* out) {
  VectorBatchInput batch;
  if (!readVectorBatch(env, idx, vectorsValue, idsValue, &batch)) {
    return false;
  }
  const size_t n = static_cast<size_t>(batch.n);
  const size_t dim = static_cast<size_t>(idx->dim());
  if (!copyInput(env, batch.vectors, n * dim, &out->vectors) ||
      !copyInput(env, batch.ids, n, &out->ids)) {
    return false;
  }
  out->n = batch.n;
  return true;
}

// idxLoadAsync(path) -> Promise<handle>
js_value_t* idxLoadAsync(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 1;
  js_value_t* argv[1] = {nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 1) {
    js_throw_type_error(env, "InvalidArgument", "expected path string");
    return nullptr;
  }
  std::vector<std::string> paths;
  if (!readPathArgs(env, argv, 0, {"path"}, &paths)) {
    return nullptr;
  }
  return startLoadJob(env, [path = paths[0]](int* status) {
    return VectorIndex::load(path, status);
  });
}

// idxLoadMmapAsync(path) -> Promise<handle>
js_value_t* idxLoadMmapAsync(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 1;
  js_value_t* argv[1] = {nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 1) {
    js_throw_type_error(env, "InvalidArgument", "expected path string");
    return nullptr;
  }
  std::vector<std::string> paths;
  if (!readPathArgs(env, argv, 0, {"path"}, &paths)) {
    return nullptr;
  }
  return startLoadJob(env, [path = paths[0]](int* status) {
    return VectorIndex::loadMmap(path, status);
  });
}

// idxLoadWithDeltaAsync(snapshotPath, deltaPath) -> Promise<handle>
js_value_t* idxLoadWithDeltaAsync(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 2;
  js_value_t* argv[2] = {nullptr, nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 2) {
    js_throw_type_error(
        env, "InvalidArgument", "expected (snapshotPath, deltaPath)");
    return nullptr;
  }
  std::vector<std::string> paths;
  if (!readPathArgs(env, argv, 0, {"snapshotPath", "deltaPath"}, &paths)) {
    return nullptr;
  }
  return startLoadJob(
      env, [snapshot = paths[0], delta = paths[1]](int* status) {
        return VectorIndex::loadWithDelta(snapshot, delta, status);
      });
}

// idxAddAsync(handle, vectors, ids) -> Promise<undefined>
js_value_t* idxAddAsync(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 3;
  js_value_t* argv[3] = {nullptr, nullptr, nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 3) {
    js_throw_type_error(
        env,
        "InvalidArgument",
        "expected (handle, vectors:Float32Array, ids:BigUint64Array)");
    return nullptr;
  }
  VectorIndexExternal* external = unwrapLiveExternal(env, argv[0]);
  if (external == nullptr) {
    return nullptr;
  }
  VectorIndex* idx = external->idx;
  BatchJob batch;
  if (!readBatchJob(env, idx, argv[1], argv[2], &batch)) {
    return nullptr;
  }
  return startIndexJob(
      env,
      Lane::Bulk,
      external,
      nullptr,
      {argv[0]},
      [idx, batch]() {
        return idx->add(batch.vectors->data(), batch.n, batch.ids->data());
      },
      settleUndefined);
}

// idxAddLoggedAsync(handle, vectors, ids, deltaPath) -> Promise<undefined>
js_value_t* idxAddLoggedAsync(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 4;
  js_value_t* argv[4] = {nullptr, nullptr, nullptr, nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 4) {
    js_throw_type_error(
        env,
        "InvalidArgument",
        "expected (handle, vectors:Float32Array, ids:BigUint64Array, "
        "deltaPath)");
    return nullptr;
  }
  VectorIndexExternal* external = unwrapLiveExternal(env, argv[0]);
  if (external == nullptr) {
    return nullptr;
  }
  VectorIndex* idx = external->idx;
  BatchJob batch;
  if (!readBatchJob(env, idx, argv[1], argv[2], &batch)) {
    return nullptr;
  }
  std::vector<std::string> paths;
  if (!readPathArgs(env, argv, 3, {"deltaPath"}, &paths)) {
    return nullptr;
  }
  return startIndexJob(
      env,
      Lane::Bulk,
      external,
      nullptr,
      {argv[0]},
      [idx, batch, deltaPath = paths[0]]() {
        return idx->addLogged(
            batch.vectors->data(), batch.n, batch.ids->data(), deltaPath);
      },
      settleUndefined);
}

// idxRemoveAsync(handle, id) -> Promise<boolean>
js_value_t* idxRemoveAsync(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 2;
  js_value_t* argv[2] = {nullptr, nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 2) {
    js_throw_type_error(env, "InvalidArgument", "expected (handle, id:bigint)");
    return nullptr;
  }
  VectorIndexExternal* external = unwrapLiveExternal(env, argv[0]);
  if (external == nullptr) {
    return nullptr;
  }
  uint64_t id = 0;
  if (!readId(env, argv[1], &id)) {
    return nullptr;
  }
  VectorIndex* idx = external->idx;
  return startIndexJob(
      env,
      Lane::Search,
      external,
      nullptr,
      {argv[0]},
      [idx, id]() { return idx->remove(id); },
      settleRemoved);
}

// idxRemoveLoggedAsync(handle, id, deltaPath) -> Promise<boolean>
js_value_t* idxRemoveLoggedAsync(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 3;
  js_value_t* argv[3] = {nullptr, nullptr, nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 3) {
    js_throw_type_error(
        env, "InvalidArgument", "expected (handle, id:bigint, deltaPath)");
    return nullptr;
  }
  VectorIndexExternal* external = unwrapLiveExternal(env, argv[0]);
  if (external == nullptr) {
    return nullptr;
  }
  uint64_t id = 0;
  if (!readId(env, argv[1], &id)) {
    return nullptr;
  }
  std::vector<std::string> paths;
  if (!readPathArgs(env, argv, 2, {"deltaPath"}, &paths)) {
    return nullptr;
  }
  VectorIndex* idx = external->idx;
  return startIndexJob(
      env,
      Lane::Bulk,
      external,
      nullptr,
      {argv[0]},
      [idx, id, deltaPath = paths[0]]() {
        return idx->removeLogged(id, deltaPath);
      },
      settleRemoved);
}

// idxSearchAsync(handle, queries, k) -> Promise<result>
js_value_t* idxSearchAsync(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 3;
  js_value_t* argv[3] = {nullptr, nullptr, nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 3) {
    js_throw_type_error(
        env,
        "InvalidArgument",
        "expected (handle, queries:Float32Array, k:number)");
    return nullptr;
  }
  VectorIndexExternal* external = unwrapLiveExternal(env, argv[0]);
  if (external == nullptr) {
    return nullptr;
  }
  VectorIndex* idx = external->idx;
  SearchJob job;
  if (!readSearchJob(env, idx, argv[1], argv[2], &job)) {
    return nullptr;
  }
  return startSearchJob(
      env,
      external,
      nullptr,
      argv[0],
      nullptr,
      job,
      [idx](const SearchJob& in) {
        return idx->search(
            in.queries->data(),
            in.m,
            in.k,
            static_cast<float*>(in.output.scoresData),
            static_cast<uint64_t*>(in.output.idsData));
      });
}

// idxSearchFilteredAsync(handle, queries, k, allowedIds) -> Promise<result>
js_value_t* idxSearchFilteredAsync(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 4;
  js_value_t* argv[4] = {nullptr, nullptr, nullptr, nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 4) {
    js_throw_type_error(
        env,
        "InvalidArgument",
        "expected (handle, queries:Float32Array, k:number, "
        "allowedIds:BigUint64Array)");
    return nullptr;
  }
  VectorIndexExternal* external = unwrapLiveExternal(env, argv[0]);
  if (external == nullptr) {
    return nullptr;
  }
  VectorIndex* idx = external->idx;
  SearchJob job;
  if (!readSearchJob(env, idx, argv[1], argv[2], &job)) {
    return nullptr;
  }
  const uint64_t* allowedIds = nullptr;
  int nAllowed = 0;
  Owned<uint64_t> allowed;
  if (!readAllowedIds(env, argv[3], &allowedIds, &nAllowed) ||
      !copyInput(env, allowedIds, static_cast<size_t>(nAllowed), &allowed)) {
    return nullptr;
  }
  return startSearchJob(
      env,
      external,
      nullptr,
      argv[0],
      nullptr,
      job,
      [idx, allowed, nAllowed](const SearchJob& in) {
        return idx->searchFiltered(
            in.queries->data(),
            in.m,
            in.k,
            dataOrNull(allowed),
            nAllowed,
            static_cast<float*>(in.output.scoresData),
            static_cast<uint64_t*>(in.output.idsData));
      });
}

// idxFilterCreateAsync(handle, allowedIds) -> Promise<filter handle>
js_value_t* idxFilterCreateAsync(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 2;
  js_value_t* argv[2] = {nullptr, nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 2) {
    js_throw_type_error(
        env, "InvalidArgument", "expected (handle, allowedIds:BigUint64Array)");
    return nullptr;
  }
  VectorIndexExternal* external = unwrapLiveExternal(env, argv[0]);
  if (external == nullptr) {
    return nullptr;
  }
  const uint64_t* allowedIds = nullptr;
  int nAllowed = 0;
  Owned<uint64_t> allowed;
  if (!readAllowedIds(env, argv[1], &allowedIds, &nAllowed) ||
      !copyInput(env, allowedIds, static_cast<size_t>(nAllowed), &allowed)) {
    return nullptr;
  }

  std::shared_ptr<std::unique_ptr<VectorIndexFilter>> created;
  try {
    created = std::make_shared<std::unique_ptr<VectorIndexFilter>>();
  } catch (const std::bad_alloc&) {
    js_throw_error(env, "OutOfMemory", "allocation failure");
    return nullptr;
  }
  VectorIndex* idx = external->idx;
  return startIndexJob(
      env,
      Lane::Search,
      external,
      nullptr,
      {argv[0]},
      [idx, allowed, nAllowed, created]() {
        VectorIndexFilter filter =
            idx->createFilter(dataOrNull(allowed), nAllowed);
        if (filter.valid()) {
          *created = std::make_unique<VectorIndexFilter>(std::move(filter));
        }
        return static_cast<int>(GGML_VEC_INDEX_OK);
      },
      [created](js_env_t* jobEnv, int status, const JobKept& /*kept*/) {
        if (status != GGML_VEC_INDEX_OK) {
          throwStatus(jobEnv, status);
          return static_cast<js_value_t*>(nullptr);
        }
        if (!*created) {
          js_throw_error(
              jobEnv,
              "InvalidArgument",
              "ggml_vec_index_filter_create returned null");
          return static_cast<js_value_t*>(nullptr);
        }
        // wrapFilter() takes ownership, and frees the filter if it fails.
        return wrapFilter(jobEnv, created->release());
      });
}

// idxSearchPreparedFilteredAsync(handle, filter, queries, k)
//   -> Promise<result>
js_value_t*
idxSearchPreparedFilteredAsync(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 4;
  js_value_t* argv[4] = {nullptr, nullptr, nullptr, nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 4) {
    js_throw_type_error(
        env,
        "InvalidArgument",
        "expected (handle, filter, queries:Float32Array, k:number)");
    return nullptr;
  }
  VectorIndexExternal* external = unwrapLiveExternal(env, argv[0]);
  if (external == nullptr) {
    return nullptr;
  }
  VectorIndexFilterExternal* filterExternal =
      unwrapFilterExternal(env, argv[1]);
  if (filterExternal == nullptr) {
    return nullptr;
  }
  if (filterExternal->filter == nullptr) {
    js_throw_error(
        env, "InvalidArgument", "IdMapIndexFilter has been disposed");
    return nullptr;
  }
  if (filterExternal->busy) {
    throwBusy(env, "IdMapIndexFilter");
    return nullptr;
  }
  VectorIndex* idx = external->idx;
  SearchJob job;
  if (!readSearchJob(env, idx, argv[2], argv[3], &job)) {
    return nullptr;
  }
  const VectorIndexFilter* filter = filterExternal->filter;
  return startSearchJob(
      env,
      external,
      filterExternal,
      argv[0],
      argv[1],
      job,
      [idx, filter](const SearchJob& in) {
        return idx->searchPreparedFiltered(
            *filter,
            in.queries->data(),
            in.m,
            in.k,
            static_cast<float*>(in.output.scoresData),
            static_cast<uint64_t*>(in.output.idsData));
      });
}

// idxBuildIvfAsync(handle, nLists, nIter) -> Promise<undefined>
js_value_t* idxBuildIvfAsync(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 3;
  js_value_t* argv[3] = {nullptr, nullptr, nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 3) {
    js_throw_type_error(
        env,
        "InvalidArgument",
        "expected (handle, nLists:number, nIter:number)");
    return nullptr;
  }
  VectorIndexExternal* external = unwrapLiveExternal(env, argv[0]);
  if (external == nullptr) {
    return nullptr;
  }
  int32_t nLists = 0;
  if (!readPositiveInt32(env, argv[1], "n_lists", &nLists)) {
    return nullptr;
  }
  int32_t nIter = 0;
  if (!readNonnegativeInt32(env, argv[2], "n_iter", &nIter)) {
    return nullptr;
  }
  VectorIndex* idx = external->idx;
  return startIndexJob(
      env,
      Lane::Bulk,
      external,
      nullptr,
      {argv[0]},
      [idx, nLists, nIter]() { return idx->buildIvf(nLists, nIter); },
      settleUndefined);
}

// idxSearchIvfAsync(handle, queries, k, nProbe) -> Promise<result>
js_value_t* idxSearchIvfAsync(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 4;
  js_value_t* argv[4] = {nullptr, nullptr, nullptr, nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 4) {
    js_throw_type_error(
        env,
        "InvalidArgument",
        "expected (handle, queries:Float32Array, k:number, nProbe:number)");
    return nullptr;
  }
  VectorIndexExternal* external = unwrapLiveExternal(env, argv[0]);
  if (external == nullptr) {
    return nullptr;
  }
  VectorIndex* idx = external->idx;
  SearchJob job;
  if (!readSearchJob(env, idx, argv[1], argv[2], &job)) {
    return nullptr;
  }
  int32_t nProbe = 0;
  if (!readPositiveInt32(env, argv[3], "n_probe", &nProbe)) {
    return nullptr;
  }
  return startSearchJob(
      env,
      external,
      nullptr,
      argv[0],
      nullptr,
      job,
      [idx, nProbe](const SearchJob& in) {
        return idx->searchIvf(
            in.queries->data(),
            in.m,
            in.k,
            nProbe,
            static_cast<float*>(in.output.scoresData),
            static_cast<uint64_t*>(in.output.idsData));
      });
}

// Shared shape of the async calls that take only the handle.
js_value_t* startHandleOnlyJob(
    js_env_t* env, js_callback_info_t* info, Lane lane,
    const std::function<int(VectorIndex*)>& call) {
  size_t argc = 1;
  js_value_t* argv[1] = {nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 1) {
    js_throw_type_error(env, "InvalidArgument", "expected handle");
    return nullptr;
  }
  VectorIndexExternal* external = unwrapLiveExternal(env, argv[0]);
  if (external == nullptr) {
    return nullptr;
  }
  VectorIndex* idx = external->idx;
  return startIndexJob(
      env,
      lane,
      external,
      nullptr,
      {argv[0]},
      [idx, call]() { return call(idx); },
      settleUndefined);
}

// idxCompactAsync(handle) -> Promise<undefined>
js_value_t* idxCompactAsync(js_env_t* env, js_callback_info_t* info) {
  return startHandleOnlyJob(
      env, info, Lane::Bulk, [](VectorIndex* idx) { return idx->compact(); });
}

// idxPrepareAsync(handle) -> Promise<undefined>
js_value_t* idxPrepareAsync(js_env_t* env, js_callback_info_t* info) {
  return startHandleOnlyJob(env, info, Lane::Bulk, [](VectorIndex* idx) {
    idx->prepare();
    return static_cast<int>(GGML_VEC_INDEX_OK);
  });
}

// idxWriteAsync(handle, path) -> Promise<undefined>
js_value_t* idxWriteAsync(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 2;
  js_value_t* argv[2] = {nullptr, nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 2) {
    js_throw_type_error(env, "InvalidArgument", "expected (handle, path)");
    return nullptr;
  }
  VectorIndexExternal* external = unwrapLiveExternal(env, argv[0]);
  if (external == nullptr) {
    return nullptr;
  }
  std::vector<std::string> paths;
  if (!readPathArgs(env, argv, 1, {"path"}, &paths)) {
    return nullptr;
  }
  VectorIndex* idx = external->idx;
  return startIndexJob(
      env,
      Lane::Bulk,
      external,
      nullptr,
      {argv[0]},
      [idx, path = paths[0]]() { return idx->write(path); },
      settleUndefined);
}

// idxCompactDeltaAsync(handle, snapshotPath, deltaPath) -> Promise<undefined>
js_value_t* idxCompactDeltaAsync(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 3;
  js_value_t* argv[3] = {nullptr, nullptr, nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 3) {
    js_throw_type_error(
        env, "InvalidArgument", "expected (handle, snapshotPath, deltaPath)");
    return nullptr;
  }
  VectorIndexExternal* external = unwrapLiveExternal(env, argv[0]);
  if (external == nullptr) {
    return nullptr;
  }
  std::vector<std::string> paths;
  if (!readPathArgs(env, argv, 1, {"snapshotPath", "deltaPath"}, &paths)) {
    return nullptr;
  }
  VectorIndex* idx = external->idx;
  return startIndexJob(
      env,
      Lane::Bulk,
      external,
      nullptr,
      {argv[0]},
      [idx, snapshot = paths[0], delta = paths[1]]() {
        return idx->compactDelta(snapshot, delta);
      },
      settleUndefined);
}

js_value_t* turbovecGgmlExports(js_env_t* env, js_value_t* exports) {
  if (!qvacAddonBindFabric()) {
    js_throw_error(env, nullptr, "failed to bind " QVAC_FABRIC_MODULE_NAME);
    return nullptr;
  }
// NOLINTBEGIN(cppcoreguidelines-macro-usage)
#define V(name, fn)                                                            \
  do {                                                                         \
    js_value_t* val = nullptr;                                                 \
    if (js_create_function(env, name, -1, fn, nullptr, &val) != 0) {           \
      return nullptr;                                                          \
    }                                                                          \
    if (js_set_named_property(env, exports, name, val) != 0) {                 \
      return nullptr;                                                          \
    }                                                                          \
  } while (0)

  V("idx_create", idxCreate);
  V("idx_load", idxLoad);
  V("idx_load_mmap", idxLoadMmap);
  V("idx_load_with_delta", idxLoadWithDelta);
  V("idx_add", idxAdd);
  V("idx_add_logged", idxAddLogged);
  V("idx_search", idxSearch);
  V("idx_search_filtered", idxSearchFiltered);
  V("idx_filter_create", idxFilterCreate);
  V("idx_search_prepared_filtered", idxSearchPreparedFiltered);
  V("idx_build_ivf", idxBuildIvf);
  V("idx_search_ivf", idxSearchIvf);
  V("idx_remove", idxRemove);
  V("idx_remove_logged", idxRemoveLogged);
  V("idx_compact", idxCompact);
  V("idx_contains", idxContains);
  V("idx_prepare", idxPrepare);
  V("idx_write", idxWrite);
  V("idx_compact_delta", idxCompactDelta);
  V("idx_dispose", idxDispose);
  V("idx_filter_dispose", idxFilterDispose);
  V("idx_len", (idxIntGetter<&VectorIndex::len>));
  V("idx_dim", (idxIntGetter<&VectorIndex::dim>));
  V("idx_bit_width", (idxIntGetter<&VectorIndex::bitWidth>));
  V("idx_calibrated", idxCalibrated);
  V("idx_set_staged", idxSetStaged);
  V("idx_staged", idxStaged);
  V("idx_load_async", idxLoadAsync);
  V("idx_load_mmap_async", idxLoadMmapAsync);
  V("idx_load_with_delta_async", idxLoadWithDeltaAsync);
  V("idx_add_async", idxAddAsync);
  V("idx_add_logged_async", idxAddLoggedAsync);
  V("idx_remove_async", idxRemoveAsync);
  V("idx_remove_logged_async", idxRemoveLoggedAsync);
  V("idx_search_async", idxSearchAsync);
  V("idx_search_filtered_async", idxSearchFilteredAsync);
  V("idx_filter_create_async", idxFilterCreateAsync);
  V("idx_search_prepared_filtered_async", idxSearchPreparedFilteredAsync);
  V("idx_build_ivf_async", idxBuildIvfAsync);
  V("idx_search_ivf_async", idxSearchIvfAsync);
  V("idx_compact_async", idxCompactAsync);
  V("idx_prepare_async", idxPrepareAsync);
  V("idx_write_async", idxWriteAsync);
  V("idx_compact_delta_async", idxCompactDeltaAsync);
#undef V
  // NOLINTEND(cppcoreguidelines-macro-usage)
  return exports;
}

} // namespace

BARE_MODULE("turbovec-ggml", turbovecGgmlExports)
