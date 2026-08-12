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

constexpr uint64_t kExternalMagic = UINT64_C(0x515649444d415058);

enum class ExternalKind : uint32_t {
  index = 1,
  filter = 2,
};

struct ExternalHeader {
  uint64_t magic = kExternalMagic;
  ExternalKind kind;
};

struct VectorIndexExternal {
  explicit VectorIndexExternal(VectorIndex* index) noexcept
      : header{kExternalMagic, ExternalKind::index}, idx(index) {}

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
      : header{kExternalMagic, ExternalKind::filter}, filter(value) {}

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
void finalize_vector_index(js_env_t* /*env*/, void* data, void* /*hint*/) {
  auto* external = static_cast<VectorIndexExternal*>(data);
  delete external;
}

void finalize_vector_index_filter(
    js_env_t* /*env*/, void* data, void* /*hint*/) {
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
          env, holder, finalize_vector_index, nullptr, &external) != 0) {
    delete holder;
    js_throw_error(env, "InternalError", "failed to create external");
    return nullptr;
  }
  return external;
}

js_value_t* wrap_filter(js_env_t* env, VectorIndexFilter* filter) {
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
          env, holder, finalize_vector_index_filter, nullptr, &external) != 0) {
    delete holder;
    js_throw_error(env, "InternalError", "failed to create external");
    return nullptr;
  }
  return external;
}

VectorIndexExternal* unwrap_external(js_env_t* env, js_value_t* handle) {
  void* data = nullptr;
  if (js_get_value_external(env, handle, &data) != 0 || data == nullptr) {
    js_throw_error(env, "InvalidArgument", "expected IdMapIndex handle");
    return nullptr;
  }
  const auto* header = static_cast<const ExternalHeader*>(data);
  if (header->magic != kExternalMagic || header->kind != ExternalKind::index) {
    js_throw_error(env, "InvalidArgument", "expected IdMapIndex handle");
    return nullptr;
  }
  return static_cast<VectorIndexExternal*>(data);
}

// Get a borrowed pointer out of a JS external handle. Throws and returns
// null on failure.
VectorIndex* unwrap(js_env_t* env, js_value_t* handle) {
  VectorIndexExternal* external = unwrap_external(env, handle);
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
unwrap_filter_external(js_env_t* env, js_value_t* handle) {
  void* data = nullptr;
  if (js_get_value_external(env, handle, &data) != 0 || data == nullptr) {
    js_throw_error(env, "InvalidArgument", "expected IdMapIndexFilter handle");
    return nullptr;
  }
  const auto* header = static_cast<const ExternalHeader*>(data);
  if (header->magic != kExternalMagic || header->kind != ExternalKind::filter) {
    js_throw_error(env, "InvalidArgument", "expected IdMapIndexFilter handle");
    return nullptr;
  }
  return static_cast<VectorIndexFilterExternal*>(data);
}

VectorIndexFilter* unwrap_filter(js_env_t* env, js_value_t* handle) {
  VectorIndexFilterExternal* external = unwrap_filter_external(env, handle);
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
bool read_int_prop(
    js_env_t* env, js_value_t* obj, const char* name, int32_t* out) {
  js_value_t* val = nullptr;
  if (js_get_named_property(env, obj, name, &val) != 0) {
    return false;
  }
  bool is_undefined = false;
  if (js_is_undefined(env, val, &is_undefined) == 0 && is_undefined) {
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

bool read_int_value(js_env_t* env, js_value_t* val, int32_t* out) {
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

void throw_status(js_env_t* env, int code) {
  const char* name = verrors::toString(code);
  js_throw_error(env, name, name);
}

js_value_t* make_undefined(js_env_t* env) {
  js_value_t* value = nullptr;
  if (js_get_undefined(env, &value) != 0) {
    js_throw_error(env, "InternalError", "create undefined");
    return nullptr;
  }
  return value;
}

js_value_t* make_boolean(js_env_t* env, bool value) {
  js_value_t* result = nullptr;
  if (js_get_boolean(env, value, &result) != 0) {
    js_throw_error(env, "InternalError", "create boolean");
    return nullptr;
  }
  return result;
}

js_value_t* make_int32(js_env_t* env, int32_t value) {
  js_value_t* result = nullptr;
  if (js_create_int32(env, value, &result) != 0) {
    js_throw_error(env, "InternalError", "create int32");
    return nullptr;
  }
  return result;
}

bool get_optional_property(
    js_env_t* env, js_value_t* obj, const char* name, js_value_t** out,
    bool* has_value) {
  *out = nullptr;
  *has_value = false;
  if (js_get_named_property(env, obj, name, out) != 0) {
    js_throw_error(env, "InternalError", "failed to read option");
    return false;
  }
  bool is_undefined = false;
  if (js_is_undefined(env, *out, &is_undefined) != 0) {
    js_throw_error(env, "InternalError", "failed to inspect option");
    return false;
  }
  *has_value = !is_undefined;
  return true;
}

bool read_optional_int_prop(
    js_env_t* env, js_value_t* obj, const char* name, int32_t* out,
    bool* has_value) {
  js_value_t* val = nullptr;
  if (!get_optional_property(env, obj, name, &val, has_value)) {
    return false;
  }
  if (!*has_value) {
    return true;
  }
  if (!read_int_value(env, val, out)) {
    js_throw_type_error(env, "InvalidArgument", "invalid integer option");
    return false;
  }
  return true;
}

bool read_utf8_string(
    js_env_t* env, js_value_t* value, const char* type_error,
    const char* read_error, std::string* out) {
  size_t len = 0;
  if (js_get_value_string_utf8(env, value, nullptr, 0, &len) != 0) {
    js_throw_type_error(env, "InvalidArgument", type_error);
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
      js_throw_error(env, "InternalError", read_error);
      return false;
    }

    out->assign(reinterpret_cast<const char*>(buffer.data()), copied);
  } catch (const std::bad_alloc&) {
    js_throw_error(env, "OutOfMemory", "allocation failure");
    return false;
  }
  return true;
}

bool read_utf8_string_prop(
    js_env_t* env, js_value_t* obj, const char* name, std::string* out) {
  js_value_t* val = nullptr;
  bool has_value = false;
  if (!get_optional_property(env, obj, name, &val, &has_value)) {
    return false;
  }
  if (!has_value) {
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
      return false;
    }
    out->assign(reinterpret_cast<const char*>(buffer.data()), copied);
  } catch (const std::bad_alloc&) {
    js_throw_error(env, "OutOfMemory", "allocation failure");
    return false;
  }
  return true;
}

bool read_float32_array(
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

bool read_biguint64_array(
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

bool read_positive_int32(
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

bool read_nonnegative_int32(
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

bool read_vector_batch(
    js_env_t* env, const VectorIndex* idx, js_value_t* vectorsValue,
    js_value_t* idsValue, VectorBatchInput* out) {
  const float* vectors = nullptr;
  size_t vlen = 0;
  if (!read_float32_array(env, vectorsValue, "vectors", &vectors, &vlen)) {
    return false;
  }

  const uint64_t* ids = nullptr;
  size_t ilen = 0;
  if (!read_biguint64_array(env, idsValue, "ids", &ids, &ilen)) {
    return false;
  }

  const int dim = idx->dim();
  if (dim <= 0) {
    js_throw_error(env, "InternalError", "index has invalid dim");
    return false;
  }
  const size_t dim_size = static_cast<size_t>(dim);
  if (ilen > std::numeric_limits<size_t>::max() / dim_size ||
      vlen != ilen * dim_size) {
    js_throw_range_error(
        env, "InvalidArgument", "vectors.length must equal ids.length * dim");
    return false;
  }
  if (ilen > static_cast<size_t>(INT32_MAX)) {
    js_throw_range_error(env, "InvalidArgument", "too many vectors in batch");
    return false;
  }
  const uint64_t padding_id = std::numeric_limits<uint64_t>::max();
  for (size_t i = 0; i < ilen; i++) {
    if (ids[i] == padding_id) {
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

bool create_search_output(
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

  const size_t k_size = static_cast<size_t>(k);
  const size_t max_size = std::numeric_limits<size_t>::max();
  if (m != 0 && k_size > max_size / m) {
    js_throw_range_error(env, "InvalidArgument", "search result is too large");
    return false;
  }

  const size_t total = m * k_size;
  if (total > max_size / sizeof(uint64_t)) {
    js_throw_range_error(env, "InvalidArgument", "search result is too large");
    return false;
  }

  void* scores_data = nullptr;
  js_value_t* scores_ab = nullptr;
  if (js_create_arraybuffer(
          env, total * sizeof(float), &scores_data, &scores_ab) != 0) {
    js_throw_error(env, "OutOfMemory", "scores arraybuffer");
    return false;
  }

  void* ids_data = nullptr;
  js_value_t* ids_ab = nullptr;
  if (js_create_arraybuffer(
          env, total * sizeof(uint64_t), &ids_data, &ids_ab) != 0) {
    js_throw_error(env, "OutOfMemory", "ids arraybuffer");
    return false;
  }

  *outM = static_cast<int>(m);
  out->total = total;
  out->scoresData = scores_data;
  out->scoresBuffer = scores_ab;
  out->idsData = ids_data;
  out->idsBuffer = ids_ab;
  return true;
}

struct SearchInput {
  const float* queries = nullptr;
  int m = 0;
  int32_t k = 0;
  SearchOutput output;
};

bool read_search_input(
    js_env_t* env, const VectorIndex* idx, js_value_t* queriesValue,
    js_value_t* kValue, SearchInput* out) {
  size_t qlen = 0;
  if (!read_float32_array(env, queriesValue, "queries", &out->queries, &qlen)) {
    return false;
  }

  if (!read_positive_int32(env, kValue, "k", &out->k)) {
    return false;
  }

  return create_search_output(env, idx, qlen, out->k, &out->m, &out->output);
}

js_value_t* finish_search_result(
    js_env_t* env, const SearchOutput& output, int m, int32_t k) {
  js_value_t* scores_ta = nullptr;
  if (js_create_typedarray(
          env,
          js_float32array,
          output.total,
          output.scoresBuffer,
          0,
          &scores_ta) != 0) {
    js_throw_error(env, "InternalError", "create scores typedarray");
    return nullptr;
  }

  js_value_t* ids_ta = nullptr;
  if (js_create_typedarray(
          env, js_biguint64array, output.total, output.idsBuffer, 0, &ids_ta) !=
      0) {
    js_throw_error(env, "InternalError", "create ids typedarray");
    return nullptr;
  }

  js_value_t* result = nullptr;
  if (js_create_object(env, &result) != 0) {
    js_throw_error(env, "InternalError", "create result object");
    return nullptr;
  }
  if (js_set_named_property(env, result, "scores", scores_ta) != 0 ||
      js_set_named_property(env, result, "ids", ids_ta) != 0) {
    js_throw_error(env, "InternalError", "set result fields");
    return nullptr;
  }

  js_value_t* m_val = nullptr;
  js_value_t* k_val = nullptr;
  if (js_create_uint32(env, static_cast<uint32_t>(m), &m_val) != 0 ||
      js_create_int32(env, k, &k_val) != 0 ||
      js_set_named_property(env, result, "m", m_val) != 0 ||
      js_set_named_property(env, result, "k", k_val) != 0) {
    js_throw_error(env, "InternalError", "set result dimensions");
    return nullptr;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

// idx_create({ dim, bitWidth }) -> external handle
js_value_t* idx_create(js_env_t* env, js_callback_info_t* info) {
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
  int32_t bit_width = 8;
  if (!read_int_prop(env, argv[0], "dim", &dim)) {
    js_throw_type_error(env, "InvalidArgument", "missing or invalid `dim`");
    return nullptr;
  }
  bool has_bit_width = false;
  if (!read_optional_int_prop(
          env, argv[0], "bitWidth", &bit_width, &has_bit_width)) {
    return nullptr;
  }
  std::string storage;
  if (!read_utf8_string_prop(env, argv[0], "storage", &storage)) {
    return nullptr;
  }

  if (!storage.empty()) {
    int32_t storage_bit_width = 0;
    if (storage == "f32") {
      storage_bit_width = 32;
    } else if (storage == "q8") {
      storage_bit_width = 8;
    } else if (storage == "q4" || storage == "turbovec-q4") {
      storage_bit_width = 4;
    } else if (storage == "turbovec-q2") {
      storage_bit_width = 2;
    } else {
      js_throw_type_error(env, "InvalidArgument", "invalid storage");
      return nullptr;
    }
    if (!has_bit_width) {
      bit_width = storage_bit_width;
    } else if (bit_width != storage_bit_width) {
      js_throw_type_error(
          env, "InvalidArgument", "bitWidth does not match storage");
      return nullptr;
    }
  }

  VectorIndex* idx = nullptr;
  try {
    idx = new VectorIndex(dim, bit_width, storage);
  } catch (const std::invalid_argument& e) {
    js_throw_error(env, "InvalidArgument", e.what());
    return nullptr;
  } catch (const std::bad_alloc&) {
    js_throw_error(env, "OutOfMemory", "allocation failure");
    return nullptr;
  }
  return wrap(env, idx);
}

// idx_load(path) -> external handle (throws on file errors).
js_value_t* idx_load(js_env_t* env, js_callback_info_t* info) {
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
  if (!read_utf8_string(
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
    throw_status(env, status);
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

// idx_load_mmap(path) -> external handle (throws on file errors).
js_value_t* idx_load_mmap(js_env_t* env, js_callback_info_t* info) {
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
  if (!read_utf8_string(
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
    throw_status(env, status);
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

// idx_load_with_delta(snapshotPath, deltaPath) -> external handle.
js_value_t* idx_load_with_delta(js_env_t* env, js_callback_info_t* info) {
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

  std::string snapshot_path;
  if (!read_utf8_string(
          env,
          argv[0],
          "snapshotPath must be a string",
          "failed to read snapshot path string",
          &snapshot_path)) {
    return nullptr;
  }
  std::string delta_path;
  if (!read_utf8_string(
          env,
          argv[1],
          "deltaPath must be a string",
          "failed to read delta path string",
          &delta_path)) {
    return nullptr;
  }

  int status = 0;
  VectorIndex loaded =
      VectorIndex::loadWithDelta(snapshot_path, delta_path, &status);
  if (status != 0) {
    throw_status(env, status);
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

// idx_add(handle, Float32Array vectors, BigUint64Array ids) -> undefined
js_value_t* idx_add(js_env_t* env, js_callback_info_t* info) {
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
  if (!read_vector_batch(env, idx, argv[1], argv[2], &batch)) {
    return nullptr;
  }

  const int rc = idx->add(batch.vectors, batch.n, batch.ids);
  if (rc != 0) {
    throw_status(env, rc);
    return nullptr;
  }
  return make_undefined(env);
}

// idx_add_logged(handle, Float32Array vectors, BigUint64Array ids, deltaPath)
//   -> undefined
js_value_t* idx_add_logged(js_env_t* env, js_callback_info_t* info) {
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
  if (!read_vector_batch(env, idx, argv[1], argv[2], &batch)) {
    return nullptr;
  }

  std::string delta_path;
  if (!read_utf8_string(
          env,
          argv[3],
          "deltaPath must be a string",
          "failed to read delta path",
          &delta_path)) {
    return nullptr;
  }

  const int rc = idx->addLogged(batch.vectors, batch.n, batch.ids, delta_path);
  if (rc != 0) {
    throw_status(env, rc);
    return nullptr;
  }
  return make_undefined(env);
}

// idx_search(handle, Float32Array queries, int k)
//   -> { scores: Float32Array(m*k), ids: BigUint64Array(m*k), m, k }
js_value_t* idx_search(js_env_t* env, js_callback_info_t* info) {
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
  if (!read_search_input(env, idx, argv[1], argv[2], &input)) {
    return nullptr;
  }

  const int rc = idx->search(
      input.queries,
      input.m,
      input.k,
      static_cast<float*>(input.output.scoresData),
      static_cast<uint64_t*>(input.output.idsData));
  if (rc != 0) {
    throw_status(env, rc);
    return nullptr;
  }

  return finish_search_result(env, input.output, input.m, input.k);
}

// idx_search_filtered(handle, Float32Array queries, int k, BigUint64Array ids)
//   -> { scores: Float32Array(m*k), ids: BigUint64Array(m*k), m, k }
js_value_t* idx_search_filtered(js_env_t* env, js_callback_info_t* info) {
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
  if (!read_search_input(env, idx, argv[1], argv[2], &input)) {
    return nullptr;
  }

  const uint64_t* allowed_ids = nullptr;
  size_t alen = 0;
  if (!read_biguint64_array(env, argv[3], "allowedIds", &allowed_ids, &alen)) {
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
      alen == 0 ? nullptr : allowed_ids,
      static_cast<int>(alen),
      static_cast<float*>(input.output.scoresData),
      static_cast<uint64_t*>(input.output.idsData));
  if (rc != 0) {
    throw_status(env, rc);
    return nullptr;
  }

  return finish_search_result(env, input.output, input.m, input.k);
}

// idx_filter_create(handle, BigUint64Array allowedIds) -> external filter
js_value_t* idx_filter_create(js_env_t* env, js_callback_info_t* info) {
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

  const uint64_t* allowed_ids = nullptr;
  size_t alen = 0;
  if (!read_biguint64_array(env, argv[1], "allowedIds", &allowed_ids, &alen)) {
    return nullptr;
  }
  if (alen > static_cast<size_t>(INT32_MAX)) {
    js_throw_range_error(env, "InvalidArgument", "too many allowed ids");
    return nullptr;
  }

  VectorIndexFilter filter = idx->createFilter(
      alen == 0 ? nullptr : allowed_ids, static_cast<int>(alen));
  if (!filter.valid()) {
    js_throw_error(
        env, "InvalidArgument", "ggml_vec_index_filter_create returned null");
    return nullptr;
  }

  try {
    auto* heap = new VectorIndexFilter(std::move(filter));
    return wrap_filter(env, heap);
  } catch (const std::bad_alloc&) {
    js_throw_error(env, "OutOfMemory", "allocation failure");
    return nullptr;
  }
}

// idx_search_prepared_filtered(handle, filter, Float32Array queries, int k)
//   -> { scores: Float32Array(m*k), ids: BigUint64Array(m*k), m, k }
js_value_t*
idx_search_prepared_filtered(js_env_t* env, js_callback_info_t* info) {
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
  VectorIndexFilter* filter = unwrap_filter(env, argv[1]);
  if (filter == nullptr) {
    return nullptr;
  }

  SearchInput input;
  if (!read_search_input(env, idx, argv[2], argv[3], &input)) {
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
    throw_status(env, rc);
    return nullptr;
  }

  return finish_search_result(env, input.output, input.m, input.k);
}

// idx_build_ivf(handle, nLists:number, nIter:number) -> undefined
js_value_t* idx_build_ivf(js_env_t* env, js_callback_info_t* info) {
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

  int32_t n_lists = 0;
  if (!read_positive_int32(env, argv[1], "nLists", &n_lists)) {
    return nullptr;
  }

  int32_t n_iter = 0;
  if (!read_nonnegative_int32(env, argv[2], "nIter", &n_iter)) {
    return nullptr;
  }

  const int rc = idx->buildIvf(n_lists, n_iter);
  if (rc != 0) {
    throw_status(env, rc);
    return nullptr;
  }

  return make_undefined(env);
}

// idx_search_ivf(handle, Float32Array queries, int k, int nProbe)
//   -> { scores: Float32Array(m*k), ids: BigUint64Array(m*k), m, k }
js_value_t* idx_search_ivf(js_env_t* env, js_callback_info_t* info) {
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
  if (!read_search_input(env, idx, argv[1], argv[2], &input)) {
    return nullptr;
  }

  int32_t n_probe = 0;
  if (!read_positive_int32(env, argv[3], "nProbe", &n_probe)) {
    return nullptr;
  }

  const int rc = idx->searchIvf(
      input.queries,
      input.m,
      input.k,
      n_probe,
      static_cast<float*>(input.output.scoresData),
      static_cast<uint64_t*>(input.output.idsData));
  if (rc != 0) {
    throw_status(env, rc);
    return nullptr;
  }

  return finish_search_result(env, input.output, input.m, input.k);
}

// idx_remove(handle, id:bigint) -> boolean
js_value_t* idx_remove(js_env_t* env, js_callback_info_t* info) {
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
  if (rc < 0) {
    throw_status(env, rc);
    return nullptr;
  }
  return make_boolean(env, rc == 1);
}

// idx_remove_logged(handle, id:bigint, deltaPath) -> boolean
js_value_t* idx_remove_logged(js_env_t* env, js_callback_info_t* info) {
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

  std::string delta_path;
  if (!read_utf8_string(
          env,
          argv[2],
          "deltaPath must be a string",
          "failed to read delta path",
          &delta_path)) {
    return nullptr;
  }

  const int rc = idx->removeLogged(id, delta_path);
  if (rc < 0) {
    throw_status(env, rc);
    return nullptr;
  }
  return make_boolean(env, rc == 1);
}

// idx_compact(handle) -> undefined
js_value_t* idx_compact(js_env_t* env, js_callback_info_t* info) {
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
    throw_status(env, rc);
    return nullptr;
  }
  return make_undefined(env);
}

// idx_contains(handle, id:bigint) -> boolean
js_value_t* idx_contains(js_env_t* env, js_callback_info_t* info) {
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
  return make_boolean(env, idx->contains(id));
}

// idx_prepare(handle) -> undefined (warms storage-specific native caches).
js_value_t* idx_prepare(js_env_t* env, js_callback_info_t* info) {
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
  return make_undefined(env);
}

// idx_write(handle, path) -> undefined; throws on IO error.
js_value_t* idx_write(js_env_t* env, js_callback_info_t* info) {
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
  if (!read_utf8_string(
          env,
          argv[1],
          "path must be a string",
          "failed to read path",
          &path)) {
    return nullptr;
  }

  const int rc = idx->write(path);
  if (rc != 0) {
    throw_status(env, rc);
    return nullptr;
  }
  return make_undefined(env);
}

// idx_compact_delta(handle, snapshotPath, deltaPath) -> undefined.
js_value_t* idx_compact_delta(js_env_t* env, js_callback_info_t* info) {
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

  std::string snapshot_path;
  if (!read_utf8_string(
          env,
          argv[1],
          "snapshotPath must be a string",
          "failed to read snapshot path",
          &snapshot_path)) {
    return nullptr;
  }
  std::string delta_path;
  if (!read_utf8_string(
          env,
          argv[2],
          "deltaPath must be a string",
          "failed to read delta path",
          &delta_path)) {
    return nullptr;
  }

  const int rc = idx->compactDelta(snapshot_path, delta_path);
  if (rc != 0) {
    throw_status(env, rc);
    return nullptr;
  }

  return make_undefined(env);
}

// idx_dispose(handle) -> undefined. Frees the native index immediately; the
// JS external finalizer remains safe and becomes a no-op for the index.
js_value_t* idx_dispose(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 1;
  js_value_t* argv[1] = {nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 1) {
    js_throw_type_error(env, "InvalidArgument", "expected handle");
    return nullptr;
  }
  VectorIndexExternal* external = unwrap_external(env, argv[0]);
  if (external == nullptr) {
    return nullptr;
  }

  delete external->idx;
  external->idx = nullptr;

  return make_undefined(env);
}

// idx_filter_dispose(filter) -> undefined.
js_value_t* idx_filter_dispose(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 1;
  js_value_t* argv[1] = {nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  if (argc < 1) {
    js_throw_type_error(env, "InvalidArgument", "expected filter handle");
    return nullptr;
  }
  VectorIndexFilterExternal* external = unwrap_filter_external(env, argv[0]);
  if (external == nullptr) {
    return nullptr;
  }

  delete external->filter;
  external->filter = nullptr;

  return make_undefined(env);
}

// Generic int32 getter for len/dim/bitWidth.
template <int (VectorIndex::*Fn)() const noexcept>
js_value_t* idx_int_getter(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 1;
  js_value_t* argv[1] = {nullptr};
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) != 0) {
    return nullptr;
  }
  VectorIndex* idx = unwrap(env, argv[0]);
  if (idx == nullptr) {
    return nullptr;
  }
  return make_int32(env, (idx->*Fn)());
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

  V("idx_create", idx_create);
  V("idx_load", idx_load);
  V("idx_load_mmap", idx_load_mmap);
  V("idx_load_with_delta", idx_load_with_delta);
  V("idx_add", idx_add);
  V("idx_add_logged", idx_add_logged);
  V("idx_search", idx_search);
  V("idx_search_filtered", idx_search_filtered);
  V("idx_filter_create", idx_filter_create);
  V("idx_search_prepared_filtered", idx_search_prepared_filtered);
  V("idx_build_ivf", idx_build_ivf);
  V("idx_search_ivf", idx_search_ivf);
  V("idx_remove", idx_remove);
  V("idx_remove_logged", idx_remove_logged);
  V("idx_compact", idx_compact);
  V("idx_contains", idx_contains);
  V("idx_prepare", idx_prepare);
  V("idx_write", idx_write);
  V("idx_compact_delta", idx_compact_delta);
  V("idx_dispose", idx_dispose);
  V("idx_filter_dispose", idx_filter_dispose);
  V("idx_len", (idx_int_getter<&VectorIndex::len>));
  V("idx_dim", (idx_int_getter<&VectorIndex::dim>));
  V("idx_bit_width", (idx_int_getter<&VectorIndex::bitWidth>));
#undef V
  // NOLINTEND(cppcoreguidelines-macro-usage)
  return true;
}

} // namespace qvac_lib_inference_addon_embed::vector_index
