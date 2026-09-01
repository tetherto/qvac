// vector-index-binding.cpp
//
// N-API surface for the `IdMapIndex` JS class. Registers a small set of free
// functions on the embed-llamacpp addon's exports; the JS wrapper in
// `idMapIndex.js` ties them into a class shape.
//
// Lifecycle isolation: this binding deliberately depends ONLY on the
// VectorIndex C++ wrapper (which in turn depends only on fabric's
// ggml-vector-index C API). It never references BertModel,
// LlamaLazyInitializeBackend, or any other BERT-runtime symbol, so simply
// importing the addon does not boot fabric's LLM backend. The same .bare
// binary carries both class surfaces; the JS side decides which to construct.

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <new>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include <bare.h>

#include "../addon/VectorIndexErrors.hpp"
#include "../model-interface/VectorIndex.hpp"

namespace {

using qvac_lib_infer_llamacpp_embed::VectorIndex;
using qvac_lib_infer_llamacpp_embed::VectorIndexFilter;
namespace verrors = qvac_lib_infer_llamacpp_embed::vector_index_errors;

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

VectorIndexExternal* unwrapExternal(js_env_t* env, js_value_t* handle) {
  void* data = nullptr;
  if (js_get_value_external(env, handle, &data) != 0 || data == nullptr) {
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

// Get a borrowed pointer out of a JS external handle. Throws and returns
// null on failure.
VectorIndex* unwrap(js_env_t* env, js_value_t* handle) {
  VectorIndexExternal* external = unwrapExternal(env, handle);
  if (external == nullptr) {
    return nullptr;
  }
  if (external->idx == nullptr) {
    js_throw_error(env, "InvalidArgument", "IdMapIndex has been disposed");
    return nullptr;
  }
  return external->idx;
}

VectorIndexFilterExternal*
unwrapFilterExternal(js_env_t* env, js_value_t* handle) {
  void* data = nullptr;
  if (js_get_value_external(env, handle, &data) != 0 || data == nullptr) {
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
  if (js_get_value_double(env, val, &raw) != 0 || !std::isfinite(raw) ||
      raw != std::trunc(raw) ||
      raw < static_cast<double>(std::numeric_limits<int32_t>::min()) ||
      raw > static_cast<double>(std::numeric_limits<int32_t>::max())) {
    return false;
  }
  *out = static_cast<int32_t>(raw);
  return true;
}

bool readIntValue(js_env_t* env, js_value_t* val, int32_t* out) {
  double raw = 0.0;
  if (js_get_value_double(env, val, &raw) != 0 || !std::isfinite(raw) ||
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

bool readOptionalIntProp(
    js_env_t* env, js_value_t* obj, const char* name, int32_t* out,
    bool* hasValue) {
  js_value_t* val = nullptr;
  if (!getOptionalProperty(env, obj, name, &val, hasValue)) {
    return false;
  }
  if (!*hasValue) {
    return true;
  }
  if (!readIntValue(env, val, out)) {
    js_throw_type_error(env, "InvalidArgument", "invalid integer option");
    return false;
  }
  return true;
}

bool readUtf8String(
    js_env_t* env, js_value_t* value, const char* typeError,
    const char* readError, std::string* out) {
  size_t len = 0;
  if (js_get_value_string_utf8(env, value, nullptr, 0, &len) != 0) {
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
  return true;
}

bool readUtf8StringProp(
    js_env_t* env, js_value_t* obj, const char* name, std::string* out) {
  js_value_t* val = nullptr;
  bool hasValue = false;
  if (!getOptionalProperty(env, obj, name, &val, &hasValue)) {
    return false;
  }
  if (!hasValue) {
    return true;
  }
  size_t len = 0;
  if (js_get_value_string_utf8(env, val, nullptr, 0, &len) != 0 ||
      len == std::numeric_limits<size_t>::max()) {
    js_throw_type_error(env, "InvalidArgument", "invalid string option");
    return false;
  }
  try {
    std::vector<utf8_t> buffer(len + 1);
    size_t copied = 0;
    if (js_get_value_string_utf8(
            env, val, buffer.data(), buffer.size(), &copied) != 0) {
      js_throw_error(env, "InternalError", "failed to read string option");
      return false;
    }
    out->assign(reinterpret_cast<const char*>(buffer.data()), copied);
  } catch (const std::bad_alloc&) {
    js_throw_error(env, "OutOfMemory", "allocation failure");
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
  if (js_get_typedarray_info(
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
  if (js_get_typedarray_info(
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
  if (js_get_value_double(env, value, &raw) != 0 || !std::isfinite(raw) ||
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
  if (js_get_value_double(env, value, &raw) != 0 || !std::isfinite(raw) ||
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

// idxCreate({ dim, bitWidth }) -> external handle
js_value_t* idxCreate(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 1;
  js_value_t* argv[1] = {nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 1) {
    js_throw_type_error(env, "InvalidArgument", "expected { dim, bitWidth }");
    return nullptr;
  }
  int32_t dim = 0;
  int32_t bitWidth = 8;
  if (!readIntProp(env, argv[0], "dim", &dim)) {
    js_throw_type_error(env, "InvalidArgument", "missing or invalid `dim`");
    return nullptr;
  }
  bool hasBitWidth = false;
  if (!readOptionalIntProp(
          env, argv[0], "bit_width", &bitWidth, &hasBitWidth)) {
    return nullptr;
  }
  std::string storage;
  if (!readUtf8StringProp(env, argv[0], "storage", &storage)) {
    return nullptr;
  }

  if (!storage.empty()) {
    int32_t storageBitWidth = 0;
    if (storage == "f32") {
      storageBitWidth = 32;
    } else if (storage == "q8") {
      storageBitWidth = 8;
    } else if (storage == "q4" || storage == "turbovec-q4") {
      storageBitWidth = 4;
    } else if (storage == "turbovec-q2") {
      storageBitWidth = 2;
    } else {
      js_throw_type_error(env, "InvalidArgument", "invalid storage");
      return nullptr;
    }
    if (!hasBitWidth) {
      bitWidth = storageBitWidth;
    } else if (bitWidth != storageBitWidth) {
      js_throw_type_error(
          env, "InvalidArgument", "bitWidth does not match storage");
      return nullptr;
    }
  }

  const bool usesTurbovec = storage == "turbovec-q4" ||
                            storage == "turbovec-q2" ||
                            (storage.empty() && bitWidth == 2);
  if (usesTurbovec && sizeof(size_t) < 8) {
    js_throw_error(env, "InvalidArgument", "TurboVec requires a 64-bit target");
    return nullptr;
  }

  VectorIndex* idx = nullptr;
  try {
    idx = new VectorIndex(dim, bitWidth, storage);
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
  size_t alen = 0;
  if (!readBigUint64Array(env, argv[3], "allowed_ids", &allowedIds, &alen)) {
    return nullptr;
  }
  if (alen > static_cast<size_t>(INT32_MAX)) {
    js_throw_range_error(env, "InvalidArgument", "too many allowed ids");
    return nullptr;
  }

  const int rc = idx->searchFiltered(
      input.queries,
      input.m,
      input.k,
      alen == 0 ? nullptr : allowedIds,
      static_cast<int>(alen),
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
  size_t alen = 0;
  if (!readBigUint64Array(env, argv[1], "allowed_ids", &allowedIds, &alen)) {
    return nullptr;
  }
  if (alen > static_cast<size_t>(INT32_MAX)) {
    js_throw_range_error(env, "InvalidArgument", "too many allowed ids");
    return nullptr;
  }

  VectorIndexFilter filter = idx->createFilter(
      alen == 0 ? nullptr : allowedIds, static_cast<int>(alen));
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
  bool lossless = false;
  if (js_get_value_bigint_uint64(env, argv[1], &id, &lossless) != 0 ||
      !lossless) {
    js_throw_type_error(
        env,
        "InvalidArgument",
        "id must be an unsigned BigInt fitting in 64 bits");
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
  bool lossless = false;
  if (js_get_value_bigint_uint64(env, argv[1], &id, &lossless) != 0 ||
      !lossless) {
    js_throw_type_error(
        env,
        "InvalidArgument",
        "id must be an unsigned BigInt fitting in 64 bits");
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
  bool lossless = false;
  if (js_get_value_bigint_uint64(env, argv[1], &id, &lossless) != 0 ||
      !lossless) {
    js_throw_type_error(
        env,
        "InvalidArgument",
        "id must be an unsigned BigInt fitting in 64 bits");
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

} // namespace

namespace qvac_lib_inference_addon_embed::vector_index {

bool registerBindings(js_env_t* env, js_value_t* exports) {
// NOLINTBEGIN(cppcoreguidelines-macro-usage)
#define V(name, fn)                                                            \
  do {                                                                         \
    js_value_t* val = nullptr;                                                 \
    if (js_create_function(env, name, -1, fn, nullptr, &val) != 0) {           \
      return false;                                                            \
    }                                                                          \
    if (js_set_named_property(env, exports, name, val) != 0) {                 \
      return false;                                                            \
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
#undef V
  // NOLINTEND(cppcoreguidelines-macro-usage)
  return true;
}

} // namespace qvac_lib_inference_addon_embed::vector_index
