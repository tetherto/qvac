// Bare surface for the `IdMapIndex` JS class. Exports a small set of free
// functions; the JS wrapper in `src/index.ts` ties them into a class shape.
// Depends on the VectorIndex C++ wrapper, which depends only on fabric's
// ggml-vector-index C API, and on inference-addon-cpp for JsAsyncTask, the JS
// value helpers and StatusError.

#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <new>
#include <span>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include <bare.h>
#include <inference-addon-cpp/Errors.hpp>
#include <inference-addon-cpp/JsUtils.hpp>
#include <inference-addon-cpp/Pin.hpp>
#include <qvac-addon/fabric-bind.h>

#include "VectorIndex.hpp"
#include "VectorIndexErrors.hpp"
#include "WorkerPool.hpp"

namespace {

namespace js = qvac_lib_inference_addon_cpp::js;
namespace verrors = turbovec_ggml::vector_index_errors;
using qvac_errors::StatusError;
using turbovec_ggml::VectorIndex;
using turbovec_ggml::VectorIndexFilter;
using turbovec_ggml::WorkerPool;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
//
// Every error is a StatusError, so a JS error's `code` is
// "[ TurboVec :: <category> ]". A fabric status keeps its category name as the
// message too, so `error.message` stays e.g. "BadMagic".

[[noreturn]] void fail(const char* category, const std::string& message) {
  throw StatusError(verrors::ADDON_ID, category, message);
}

[[noreturn]] void failStatus(int status) {
  const char* name =
      verrors::toString(static_cast<verrors::VecIndexError>(status));
  throw StatusError(verrors::ADDON_ID, name, name);
}

void checkStatus(int status) {
  if (status != GGML_VEC_INDEX_OK) {
    failStatus(status);
  }
}

// Ends every binding: a StatusError throws its code and message, running out
// of memory throws OutOfMemory, and anything else INTERNAL_ERROR (JSCATCH).
// NOLINTBEGIN(cppcoreguidelines-macro-usage)
#define TURBOVEC_CATCH                                                         \
  catch (const std::bad_alloc&) {                                              \
    const StatusError outOfMemory(                                             \
        verrors::ADDON_ID, "OutOfMemory", "allocation failure");               \
    js_throw_error(env, outOfMemory.codeString().c_str(), outOfMemory.what()); \
    return nullptr;                                                            \
  }                                                                            \
  JSCATCH
// NOLINTEND(cppcoreguidelines-macro-usage)

// ---------------------------------------------------------------------------
// Native handles
// ---------------------------------------------------------------------------
//
// A JS handle is an external that holds a shared_ptr to the handle's state.
// Every job holds its own shared_ptrs to the index and filter it uses, so
// neither is freed while a job runs, whether the JS handle is disposed or
// collected meanwhile.

constexpr uint64_t EXTERNAL_MAGIC = UINT64_C(0x515649444d415058);

enum class ExternalKind : uint32_t {
  Index = 1,
  Filter = 2,
  AbortToken = 3,
};

struct ExternalBase {
  explicit ExternalBase(ExternalKind value) noexcept : kind(value) {}
  uint64_t magic = EXTERNAL_MAGIC;
  ExternalKind kind;
};

struct IndexState {
  // Null once disposed.
  std::shared_ptr<VectorIndex> idx;
  // JS thread only. True while a job runs on the index. The JS wrapper never
  // overlaps calls on one index; the flag refuses a raw binding call that
  // would, so the JS thread never waits on fabric's index lock.
  bool busy = false;
};

// Fabric needs an index to outlive its filters. Members are destroyed in
// reverse order, so the filter goes before its owner's reference.
struct FilterHandle {
  FilterHandle(std::shared_ptr<VectorIndex> index, VectorIndexFilter value)
      : owner(std::move(index)), filter(std::move(value)) {}
  std::shared_ptr<VectorIndex> owner;
  VectorIndexFilter filter;
};

struct FilterState {
  // Null once disposed.
  std::shared_ptr<FilterHandle> handle;
  // JS thread only. True while a search uses the filter.
  bool busy = false;
};

// Set by the JS wrapper when a call's AbortSignal aborts. A job checks it as
// it starts, so a call aborted while it waits in a lane is skipped.
using AbortFlag = std::atomic<bool>;

template <ExternalKind Kind, typename State> struct External : ExternalBase {
  using StateType = State;
  static constexpr ExternalKind KIND = Kind;
  External() noexcept : ExternalBase(Kind) {}
  std::shared_ptr<State> state;
};

using IndexExternal = External<ExternalKind::Index, IndexState>;
using FilterExternal = External<ExternalKind::Filter, FilterState>;
using TokenExternal = External<ExternalKind::AbortToken, AbortFlag>;

template <typename E>
void finalizeExternal(js_env_t* /*env*/, void* data, void* /*hint*/) {
  delete static_cast<E*>(static_cast<ExternalBase*>(data));
}

template <typename E>
js_value_t*
wrapExternal(js_env_t* env, std::shared_ptr<typename E::StateType> state) {
  auto holder = std::make_unique<E>();
  holder->state = std::move(state);
  js_value_t* value = nullptr;
  JS(js_create_external(
      env,
      static_cast<ExternalBase*>(holder.get()),
      &finalizeExternal<E>,
      nullptr,
      &value));
  holder.release();
  return value;
}

template <typename E>
E* unwrapExternal(js_env_t* env, js_value_t* value, const char* expected) {
  if (!js::is<js::External>(env, value)) {
    fail("InvalidArgument", expected);
  }
  void* data = nullptr;
  JS(js_get_value_external(env, value, &data));
  auto* base = static_cast<ExternalBase*>(data);
  if (base == nullptr || base->magic != EXTERNAL_MAGIC ||
      base->kind != E::KIND) {
    fail("InvalidArgument", expected);
  }
  return static_cast<E*>(base);
}

std::shared_ptr<IndexState> indexState(js_env_t* env, js_value_t* handle) {
  return unwrapExternal<IndexExternal>(
             env, handle, "expected IdMapIndex handle")
      ->state;
}

// The state of a live index that no job holds.
std::shared_ptr<IndexState> liveIndex(js_env_t* env, js_value_t* handle) {
  std::shared_ptr<IndexState> state = indexState(env, handle);
  if (!state->idx) {
    fail("InvalidArgument", "IdMapIndex has been disposed");
  }
  if (state->busy) {
    fail("Busy", "IdMapIndex has an async operation in progress");
  }
  return state;
}

std::shared_ptr<FilterState> filterState(js_env_t* env, js_value_t* handle) {
  return unwrapExternal<FilterExternal>(
             env, handle, "expected IdMapIndexFilter handle")
      ->state;
}

// Clears an index's and a filter's busy flags when a job lets go of them.
// Held by the job's work, which JsAsyncTask destroys on the JS thread on every
// path: before the promise settles, when the env is torn down, and when the
// job never runs.
class BusyGuard {
public:
  BusyGuard(
      std::shared_ptr<IndexState> index,
      std::shared_ptr<FilterState> filter) noexcept
      : index_(std::move(index)), filter_(std::move(filter)) {
    if (index_) {
      index_->busy = true;
    }
    if (filter_) {
      filter_->busy = true;
    }
  }
  ~BusyGuard() {
    if (index_) {
      index_->busy = false;
    }
    if (filter_) {
      filter_->busy = false;
    }
  }
  BusyGuard(const BusyGuard&) = delete;
  BusyGuard& operator=(const BusyGuard&) = delete;
  BusyGuard(BusyGuard&&) = delete;
  BusyGuard& operator=(BusyGuard&&) = delete;

private:
  std::shared_ptr<IndexState> index_;
  std::shared_ptr<FilterState> filter_;
};

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

using Args = std::vector<js_value_t*>;

Args readArgs(
    js_env_t* env, js_callback_info_t* info, size_t required,
    const char* usage) {
  Args argv = js::getArguments(env, info);
  if (argv.size() < required) {
    fail("InvalidArgument", std::string("expected ") + usage);
  }
  return argv;
}

bool isMissing(js_env_t* env, const Args& argv, size_t i) {
  return i >= argv.size() || js::is<js::Undefined>(env, argv[i]);
}

int32_t readInt32(
    js_env_t* env, js_value_t* value, double min, const std::string& error) {
  if (!js::is<js::Number>(env, value)) {
    fail("InvalidArgument", error);
  }
  const auto raw = js::Number(env, value).as<double>(env);
  if (!std::isfinite(raw) || raw != std::trunc(raw) || raw < min ||
      raw > static_cast<double>(INT32_MAX)) {
    fail("InvalidArgument", error);
  }
  return static_cast<int32_t>(raw);
}

int32_t readPositiveInt32(js_env_t* env, js_value_t* value, const char* name) {
  return readInt32(
      env, value, 1.0, std::string(name) + " must be a positive int");
}

int32_t
readNonnegativeInt32(js_env_t* env, js_value_t* value, const char* name) {
  return readInt32(
      env, value, 0.0, std::string(name) + " must be a non-negative int");
}

std::string readString(js_env_t* env, js_value_t* value, const char* name) {
  if (!js::is<js::String>(env, value)) {
    fail("InvalidArgument", std::string(name) + " must be a string");
  }
  std::string result = js::String(env, value).as<std::string>(env);
  // Strings reach the C API NUL-terminated, so an embedded NUL would silently
  // cut a path short.
  if (result.find('\0') != std::string::npos) {
    fail("InvalidArgument", "string must not contain NUL characters");
  }
  return result;
}

uint64_t readId(js_env_t* env, js_value_t* value) {
  uint64_t id = 0;
  bool lossless = false;
  if (!js::is<js::BigInt>(env, value) ||
      js_get_value_bigint_uint64(env, value, &id, &lossless) != 0 ||
      !lossless) {
    fail("InvalidArgument", "id must be an unsigned BigInt fitting in 64 bits");
  }
  return id;
}

template <typename T>
std::span<const T> viewTypedArray(
    js_env_t* env, js_value_t* value, const char* name, const char* type) {
  if (!js::is<js::TypedArray<T>>(env, value)) {
    fail("InvalidArgument", std::string(name) + " must be a " + type);
  }
  return js::TypedArray<T>(env, value).template as<std::span<const T>>(env);
}

std::span<const float>
viewFloat32Array(js_env_t* env, js_value_t* value, const char* name) {
  return viewTypedArray<float>(env, value, name, "Float32Array");
}

std::span<const uint64_t>
viewBigUint64Array(js_env_t* env, js_value_t* value, const char* name) {
  return viewTypedArray<uint64_t>(env, value, name, "BigUint64Array");
}

// The optional abort token argument, or null.
std::shared_ptr<const AbortFlag>
readToken(js_env_t* env, const Args& argv, size_t i) {
  if (isMissing(env, argv, i)) {
    return nullptr;
  }
  return unwrapExternal<TokenExternal>(env, argv[i], "expected abort token")
      ->state;
}

// The optional borrow argument: true when the JS wrapper passes array inputs
// that are its own private copies, made for a call queued behind others.
bool readBorrow(js_env_t* env, const Args& argv, size_t i) {
  if (isMissing(env, argv, i)) {
    return false;
  }
  if (!js::is<js::Boolean>(env, argv[i])) {
    fail("InvalidArgument", "borrow must be a boolean");
  }
  return js::Boolean(env, argv[i]).as<bool>(env);
}

// Keeps a JS value alive. Destroyed on the JS thread: jobs hold it in their
// work, which JsAsyncTask destroys there.
class JsReference {
public:
  JsReference(js_env_t* env, js_value_t* value) : env_(env) {
    JS(js_create_reference(env, value, 1, &ref_));
  }
  ~JsReference() { js_delete_reference(env_, ref_); }
  JsReference(const JsReference&) = delete;
  JsReference& operator=(const JsReference&) = delete;
  JsReference(JsReference&&) = delete;
  JsReference& operator=(JsReference&&) = delete;

private:
  js_env_t* env_;
  js_ref_t* ref_ = nullptr;
};

// An array input of a job. JS can change or detach an array (for example with
// `buffer.transfer()`) while a worker runs, so a job never reads the caller's
// memory: it reads a copy made now, or, with `borrow`, the JS wrapper's own
// private copy, kept alive here instead of being copied a second time.
template <typename T> struct Input {
  const T* data = nullptr;
  size_t size = 0;
  std::shared_ptr<const void> keep;

  // Fabric takes nullptr for an empty allow-list.
  [[nodiscard]] const T* dataOrNull() const {
    return size == 0 ? nullptr : data;
  }
};

template <typename T>
Input<T> takeInput(
    js_env_t* env, js_value_t* value, std::span<const T> view, bool borrow) {
  Input<T> input;
  input.size = view.size();
  if (borrow) {
    input.keep = std::make_shared<JsReference>(env, value);
    input.data = view.data();
    return input;
  }
  auto copy = std::make_shared<std::vector<T>>(view.begin(), view.end());
  input.data = copy->data();
  input.keep = std::move(copy);
  return input;
}

struct Batch {
  Input<float> vectors;
  Input<uint64_t> ids;
  int n = 0;
};

Batch readBatch(
    js_env_t* env, const VectorIndex& idx, js_value_t* vectorsValue,
    js_value_t* idsValue, bool borrow) {
  const std::span<const float> vectors =
      viewFloat32Array(env, vectorsValue, "vectors");
  const std::span<const uint64_t> ids =
      viewBigUint64Array(env, idsValue, "ids");

  const int dim = idx.dim();
  if (dim <= 0) {
    fail("InternalError", "index has invalid dim");
  }
  const auto dimSize = static_cast<size_t>(dim);
  if (ids.size() > std::numeric_limits<size_t>::max() / dimSize ||
      vectors.size() != ids.size() * dimSize) {
    fail("InvalidArgument", "vectors.length must equal ids.length * dim");
  }
  if (ids.size() > static_cast<size_t>(INT32_MAX)) {
    fail("InvalidArgument", "too many vectors in batch");
  }
  for (const uint64_t id : ids) {
    if (id == std::numeric_limits<uint64_t>::max()) {
      fail(
          "InvalidArgument",
          "UINT64_MAX is reserved for search result padding");
    }
  }

  Batch batch;
  batch.vectors = takeInput(env, vectorsValue, vectors, borrow);
  batch.ids = takeInput(env, idsValue, ids, borrow);
  batch.n = static_cast<int>(ids.size());
  return batch;
}

Input<uint64_t> readAllowedIds(js_env_t* env, js_value_t* value, bool borrow) {
  const std::span<const uint64_t> ids =
      viewBigUint64Array(env, value, "allowed_ids");
  if (ids.size() > static_cast<size_t>(INT32_MAX)) {
    fail("InvalidArgument", "too many allowed ids");
  }
  return takeInput(env, value, ids, borrow);
}

struct Search {
  Input<float> queries;
  int m = 0;
  int32_t k = 0;
  size_t total = 0;
};

Search readSearch(
    js_env_t* env, const VectorIndex& idx, js_value_t* queriesValue,
    js_value_t* kValue, bool borrow) {
  const std::span<const float> queries =
      viewFloat32Array(env, queriesValue, "queries");
  const int32_t k = readPositiveInt32(env, kValue, "k");

  const int dim = idx.dim();
  if (dim <= 0 || queries.size() % static_cast<size_t>(dim) != 0) {
    fail("InvalidArgument", "queries.length must be a multiple of dim");
  }
  const size_t m = queries.size() / static_cast<size_t>(dim);
  if (m > static_cast<size_t>(INT32_MAX)) {
    fail("InvalidArgument", "too many queries");
  }
  const auto kSize = static_cast<size_t>(k);
  const size_t maxSize = std::numeric_limits<size_t>::max();
  if ((m != 0 && kSize > maxSize / m) ||
      m * kSize > maxSize / sizeof(uint64_t)) {
    fail("InvalidArgument", "search result is too large");
  }

  Search search;
  search.queries = takeInput(env, queriesValue, queries, borrow);
  search.m = static_cast<int>(m);
  search.k = k;
  search.total = m * kSize;
  return search;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

struct Done {};

js_value_t* toJs(js_env_t* env, const Done& /*done*/) {
  return js::Undefined::create(env);
}

js_value_t* toJs(js_env_t* env, const bool& value) {
  return js::Boolean::create(env, value);
}

struct SearchResult {
  std::vector<float> scores;
  std::vector<uint64_t> ids;
  int m = 0;
  int32_t k = 0;
};

js_value_t* toJs(js_env_t* env, const SearchResult& result) {
  std::span<const float> scores(result.scores);
  std::span<const uint64_t> ids(result.ids);
  js::Object object = js::Object::create(env);
  object.setProperty(env, "scores", js::TypedArray<float>::create(env, scores));
  object.setProperty(env, "ids", js::TypedArray<uint64_t>::create(env, ids));
  object.setProperty(
      env, "m", js::Number::create(env, static_cast<uint32_t>(result.m)));
  object.setProperty(env, "k", js::Number::create(env, result.k));
  return object;
}

js_value_t* toJs(js_env_t* env, const std::shared_ptr<VectorIndex>& index) {
  auto state = std::make_shared<IndexState>();
  state->idx = index;
  return wrapExternal<IndexExternal>(env, std::move(state));
}

js_value_t* toJs(js_env_t* env, const std::shared_ptr<FilterHandle>& handle) {
  auto state = std::make_shared<FilterState>();
  state->handle = handle;
  return wrapExternal<FilterExternal>(env, std::move(state));
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------
//
// Every call that can take more than a moment runs as a JsAsyncTask on one of
// two process-wide lanes of worker threads, and returns a promise. Long work
// (adds, IVF builds, loads, writes, compaction, filter creation, logged
// removes) runs on the bulk lane and the rest (searches, plain removes) on the
// search lane, so a long build never holds up a search. Each fabric call runs
// on the one thread that makes it: the addon leaves fabric's per-index thread
// count at 1.

enum class Lane : uint8_t { Bulk, Search };

constexpr size_t BULK_THREADS = 1;
constexpr size_t SEARCH_THREADS = 1;

// Never destroyed, so static destruction at process exit cannot wait on a
// running job, and JsAsyncTask's executor lifetime rule always holds. The
// pools' threads outlive any one Bare environment and run code in this
// library, so the library is pinned, as the other addons pin theirs:
// unloading it when a worklet ends would leave those threads in unmapped code.
WorkerPool& pool(Lane lane) {
  static const bool pinned = [] {
    qvac_lib_inference_addon_cpp::pinAddon();
    return true;
  }();
  (void)pinned;
  static auto* bulk = new WorkerPool(BULK_THREADS);
  static auto* search = new WorkerPool(SEARCH_THREADS);
  return lane == Lane::Bulk ? *bulk : *search;
}

// Runs `work` as a job on `lane` and returns its promise, which resolves with
// toJs() of the work's result. The index and the filter are busy until the
// job lets go of them. A job whose abort token is set when it starts is
// skipped and rejects with Aborted.
template <typename Work>
js_value_t* startJob(
    js_env_t* env, Lane lane, std::shared_ptr<IndexState> index,
    std::shared_ptr<FilterState> filter, std::shared_ptr<const AbortFlag> token,
    Work work) {
  auto guard = std::make_shared<BusyGuard>(std::move(index), std::move(filter));
  return js::JsAsyncTask::runOn(
      env,
      pool(lane),
      [guard = std::move(guard),
       token = std::move(token),
       work = std::move(work)]() mutable {
        if (token != nullptr && token->load(std::memory_order_acquire)) {
          fail("Aborted", "the call was aborted before it started");
        }
        try {
          return work();
        } catch (const std::bad_alloc&) {
          fail("OutOfMemory", "allocation failure");
        }
      },
      [](js_env_t* jsEnv, const auto& result) { return toJs(jsEnv, result); });
}

// Runs a search on the search lane, writing into buffers the job owns.
template <typename Call>
js_value_t* startSearch(
    js_env_t* env, std::shared_ptr<IndexState> index,
    std::shared_ptr<FilterState> filter, std::shared_ptr<const AbortFlag> token,
    Search search, Call call) {
  return startJob(
      env,
      Lane::Search,
      std::move(index),
      std::move(filter),
      std::move(token),
      [search = std::move(search), call = std::move(call)]() {
        SearchResult result;
        result.scores.resize(search.total);
        result.ids.resize(search.total);
        result.m = search.m;
        result.k = search.k;
        checkStatus(call(
            search.queries.data,
            search.m,
            search.k,
            result.scores.data(),
            result.ids.data()));
        return result;
      });
}

// Runs a load on the bulk lane and resolves with a new index handle.
template <typename Load>
js_value_t*
startLoad(js_env_t* env, std::shared_ptr<const AbortFlag> token, Load load) {
  return startJob(
      env,
      Lane::Bulk,
      nullptr,
      nullptr,
      std::move(token),
      [load = std::move(load)]() {
        int status = GGML_VEC_INDEX_OK;
        VectorIndex index = load(&status);
        checkStatus(status);
        if (!index.valid()) {
          failStatus(GGML_VEC_INDEX_E_INTERNAL);
        }
        return std::make_shared<VectorIndex>(std::move(index));
      });
}

// Runs a call on the bulk lane that resolves with undefined.
template <typename Call>
js_value_t* startBulk(
    js_env_t* env, std::shared_ptr<IndexState> index,
    std::shared_ptr<const AbortFlag> token, Call call) {
  std::shared_ptr<VectorIndex> idx = index->idx;
  return startJob(
      env,
      Lane::Bulk,
      std::move(index),
      nullptr,
      std::move(token),
      [idx = std::move(idx), call = std::move(call)]() {
        checkStatus(call(*idx));
        return Done{};
      });
}

// Runs a remove on `lane` and resolves to whether the id was present.
template <typename Call>
js_value_t* startRemove(
    js_env_t* env, Lane lane, std::shared_ptr<IndexState> index,
    std::shared_ptr<const AbortFlag> token, Call call) {
  std::shared_ptr<VectorIndex> idx = index->idx;
  return startJob(
      env,
      lane,
      std::move(index),
      nullptr,
      std::move(token),
      [idx = std::move(idx), call = std::move(call)]() {
        const int status = call(*idx);
        if (status == GGML_VEC_INDEX_E_NOT_FOUND) {
          return false;
        }
        checkStatus(status);
        return true;
      });
}

// ---------------------------------------------------------------------------
// Sync bindings
// ---------------------------------------------------------------------------
//
// Cheap reads and frees. The JS wrapper makes them only at a call's turn in
// the index's queue, when no job holds the index.

// idxCreate({ dim, storage }) -> handle. The JS wrapper resolves `bitWidth`
// to a storage name before calling in.
js_value_t* idxCreate(js_env_t* env, js_callback_info_t* info) try {
  const Args argv = readArgs(env, info, 1, "{ dim, storage }");
  if (!js::is<js::Object>(env, argv[0])) {
    fail("InvalidArgument", "expected { dim, storage }");
  }
  js::Object options(env, argv[0]);
  js_value_t* dimValue = options.getProperty(env, "dim");
  if (js::is<js::Undefined>(env, dimValue)) {
    fail("InvalidArgument", "missing or invalid `dim`");
  }
  const int32_t dim = readInt32(
      env,
      dimValue,
      static_cast<double>(INT32_MIN),
      "missing or invalid `dim`");
  js_value_t* storageValue = options.getProperty(env, "storage");
  if (js::is<js::Undefined>(env, storageValue)) {
    fail("InvalidArgument", "missing `storage`");
  }
  const auto storage = turbovec_ggml::parseVectorStorage(
      readString(env, storageValue, "storage"));
  if (!storage.has_value()) {
    fail("InvalidArgument", "invalid `storage`");
  }

  auto state = std::make_shared<IndexState>();
  try {
    state->idx = std::make_shared<VectorIndex>(dim, *storage);
  } catch (const std::invalid_argument& e) {
    fail("InvalidArgument", e.what());
  }
  return wrapExternal<IndexExternal>(env, std::move(state));
}
TURBOVEC_CATCH

// idxContains(handle, id:bigint) -> boolean
js_value_t* idxContains(js_env_t* env, js_callback_info_t* info) try {
  const Args argv = readArgs(env, info, 2, "(handle, id:bigint)");
  const std::shared_ptr<IndexState> state = liveIndex(env, argv[0]);
  return js::Boolean::create(env, state->idx->contains(readId(env, argv[1])));
}
TURBOVEC_CATCH

// idxDispose(handle) -> undefined. Drops the handle's reference to the native
// index, which is freed now unless a prepared filter still holds it.
js_value_t* idxDispose(js_env_t* env, js_callback_info_t* info) try {
  const Args argv = readArgs(env, info, 1, "handle");
  const std::shared_ptr<IndexState> state = indexState(env, argv[0]);
  if (state->busy) {
    fail("Busy", "IdMapIndex has an async operation in progress");
  }
  state->idx.reset();
  return js::Undefined::create(env);
}
TURBOVEC_CATCH

// idxFilterDispose(filter) -> undefined.
js_value_t* idxFilterDispose(js_env_t* env, js_callback_info_t* info) try {
  const Args argv = readArgs(env, info, 1, "filter handle");
  const std::shared_ptr<FilterState> state = filterState(env, argv[0]);
  if (state->busy) {
    fail("Busy", "IdMapIndexFilter has an async operation in progress");
  }
  state->handle.reset();
  return js::Undefined::create(env);
}
TURBOVEC_CATCH

// Generic int32 getter for len/dim/bitWidth.
template <int (VectorIndex::*Fn)() const noexcept>
js_value_t* idxIntGetter(js_env_t* env, js_callback_info_t* info) try {
  const Args argv = readArgs(env, info, 1, "handle");
  const std::shared_ptr<IndexState> state = liveIndex(env, argv[0]);
  return js::Number::create(env, ((*state->idx).*Fn)());
}
TURBOVEC_CATCH

js_value_t* idxCalibrated(js_env_t* env, js_callback_info_t* info) try {
  const Args argv = readArgs(env, info, 1, "handle");
  return js::Boolean::create(env, liveIndex(env, argv[0])->idx->calibrated());
}
TURBOVEC_CATCH

js_value_t* idxStaged(js_env_t* env, js_callback_info_t* info) try {
  const Args argv = readArgs(env, info, 1, "handle");
  return js::Boolean::create(env, liveIndex(env, argv[0])->idx->staged());
}
TURBOVEC_CATCH

// idxAbortTokenCreate() -> token. One per call that has an AbortSignal.
js_value_t*
idxAbortTokenCreate(js_env_t* env, js_callback_info_t* /*info*/) try {
  return wrapExternal<TokenExternal>(env, std::make_shared<AbortFlag>(false));
}
TURBOVEC_CATCH

// idxAbortTokenAbort(token) -> undefined. A job holding the token that has
// not started is skipped when its turn comes.
js_value_t* idxAbortTokenAbort(js_env_t* env, js_callback_info_t* info) try {
  const Args argv = readArgs(env, info, 1, "token");
  unwrapExternal<TokenExternal>(env, argv[0], "expected abort token")
      ->state->store(true, std::memory_order_release);
  return js::Undefined::create(env);
}
TURBOVEC_CATCH

// ---------------------------------------------------------------------------
// Async bindings
// ---------------------------------------------------------------------------
//
// Each reads and checks its arguments on the JS thread, throwing for a bad
// one before any work starts, takes its array inputs, then starts a job.
// Every one takes an optional abort token after its own arguments, and those
// with array inputs an optional `borrow` flag after that (see readBorrow).

// idxLoadAsync(path, token?) -> Promise<handle>
js_value_t* idxLoadAsync(js_env_t* env, js_callback_info_t* info) try {
  const Args argv = readArgs(env, info, 1, "path string");
  return startLoad(
      env,
      readToken(env, argv, 1),
      [path = readString(env, argv[0], "path")](int* status) {
        return VectorIndex::load(path, status);
      });
}
TURBOVEC_CATCH

// idxLoadMmapAsync(path, token?) -> Promise<handle>
js_value_t* idxLoadMmapAsync(js_env_t* env, js_callback_info_t* info) try {
  const Args argv = readArgs(env, info, 1, "path string");
  return startLoad(
      env,
      readToken(env, argv, 1),
      [path = readString(env, argv[0], "path")](int* status) {
        return VectorIndex::loadMmap(path, status);
      });
}
TURBOVEC_CATCH

// idxLoadWithDeltaAsync(snapshotPath, deltaPath, token?) -> Promise<handle>
js_value_t* idxLoadWithDeltaAsync(js_env_t* env, js_callback_info_t* info) try {
  const Args argv = readArgs(env, info, 2, "(snapshotPath, deltaPath)");
  return startLoad(
      env,
      readToken(env, argv, 2),
      [snapshot = readString(env, argv[0], "snapshotPath"),
       delta = readString(env, argv[1], "deltaPath")](int* status) {
        return VectorIndex::loadWithDelta(snapshot, delta, status);
      });
}
TURBOVEC_CATCH

// idxAddAsync(handle, vectors, ids, token?, borrow?) -> Promise<undefined>
js_value_t* idxAddAsync(js_env_t* env, js_callback_info_t* info) try {
  const Args argv = readArgs(
      env, info, 3, "(handle, vectors:Float32Array, ids:BigUint64Array)");
  std::shared_ptr<IndexState> state = liveIndex(env, argv[0]);
  Batch batch =
      readBatch(env, *state->idx, argv[1], argv[2], readBorrow(env, argv, 4));
  return startBulk(
      env,
      std::move(state),
      readToken(env, argv, 3),
      [batch = std::move(batch)](VectorIndex& idx) {
        return idx.add(batch.vectors.data, batch.n, batch.ids.data);
      });
}
TURBOVEC_CATCH

// idxAddLoggedAsync(handle, vectors, ids, deltaPath, token?, borrow?)
//   -> Promise<undefined>
js_value_t* idxAddLoggedAsync(js_env_t* env, js_callback_info_t* info) try {
  const Args argv = readArgs(
      env,
      info,
      4,
      "(handle, vectors:Float32Array, ids:BigUint64Array, deltaPath)");
  std::shared_ptr<IndexState> state = liveIndex(env, argv[0]);
  Batch batch =
      readBatch(env, *state->idx, argv[1], argv[2], readBorrow(env, argv, 5));
  return startBulk(
      env,
      std::move(state),
      readToken(env, argv, 4),
      [batch = std::move(batch),
       deltaPath = readString(env, argv[3], "deltaPath")](VectorIndex& idx) {
        return idx.addLogged(
            batch.vectors.data, batch.n, batch.ids.data, deltaPath);
      });
}
TURBOVEC_CATCH

// idxRemoveAsync(handle, id, token?) -> Promise<boolean>
js_value_t* idxRemoveAsync(js_env_t* env, js_callback_info_t* info) try {
  const Args argv = readArgs(env, info, 2, "(handle, id:bigint)");
  std::shared_ptr<IndexState> state = liveIndex(env, argv[0]);
  const uint64_t id = readId(env, argv[1]);
  return startRemove(
      env,
      Lane::Search,
      std::move(state),
      readToken(env, argv, 2),
      [id](VectorIndex& idx) { return idx.remove(id); });
}
TURBOVEC_CATCH

// idxRemoveLoggedAsync(handle, id, deltaPath, token?) -> Promise<boolean>
js_value_t* idxRemoveLoggedAsync(js_env_t* env, js_callback_info_t* info) try {
  const Args argv = readArgs(env, info, 3, "(handle, id:bigint, deltaPath)");
  std::shared_ptr<IndexState> state = liveIndex(env, argv[0]);
  const uint64_t id = readId(env, argv[1]);
  return startRemove(
      env,
      Lane::Bulk,
      std::move(state),
      readToken(env, argv, 3),
      [id, deltaPath = readString(env, argv[2], "deltaPath")](
          VectorIndex& idx) { return idx.removeLogged(id, deltaPath); });
}
TURBOVEC_CATCH

// idxSearchAsync(handle, queries, k, token?, borrow?) -> Promise<result>
js_value_t* idxSearchAsync(js_env_t* env, js_callback_info_t* info) try {
  const Args argv =
      readArgs(env, info, 3, "(handle, queries:Float32Array, k:number)");
  std::shared_ptr<IndexState> state = liveIndex(env, argv[0]);
  Search search =
      readSearch(env, *state->idx, argv[1], argv[2], readBorrow(env, argv, 4));
  std::shared_ptr<VectorIndex> idx = state->idx;
  return startSearch(
      env,
      std::move(state),
      nullptr,
      readToken(env, argv, 3),
      std::move(search),
      [idx = std::move(idx)](
          const float* queries,
          int m,
          int32_t k,
          float* scores,
          uint64_t* ids) { return idx->search(queries, m, k, scores, ids); });
}
TURBOVEC_CATCH

// idxSearchFilteredAsync(handle, queries, k, allowedIds, token?, borrow?)
//   -> Promise<result>
js_value_t*
idxSearchFilteredAsync(js_env_t* env, js_callback_info_t* info) try {
  const Args argv = readArgs(
      env,
      info,
      4,
      "(handle, queries:Float32Array, k:number, allowedIds:BigUint64Array)");
  std::shared_ptr<IndexState> state = liveIndex(env, argv[0]);
  const bool borrow = readBorrow(env, argv, 5);
  Search search = readSearch(env, *state->idx, argv[1], argv[2], borrow);
  Input<uint64_t> allowed = readAllowedIds(env, argv[3], borrow);
  std::shared_ptr<VectorIndex> idx = state->idx;
  return startSearch(
      env,
      std::move(state),
      nullptr,
      readToken(env, argv, 4),
      std::move(search),
      [idx = std::move(idx), allowed = std::move(allowed)](
          const float* queries,
          int m,
          int32_t k,
          float* scores,
          uint64_t* ids) {
        return idx->searchFiltered(
            queries,
            m,
            k,
            allowed.dataOrNull(),
            static_cast<int>(allowed.size),
            scores,
            ids);
      });
}
TURBOVEC_CATCH

// idxFilterCreateAsync(handle, allowedIds, token?, borrow?)
//   -> Promise<filter handle>
// Runs on the bulk lane: a large allow-list would otherwise hold up every
// search in the process.
js_value_t* idxFilterCreateAsync(js_env_t* env, js_callback_info_t* info) try {
  const Args argv =
      readArgs(env, info, 2, "(handle, allowedIds:BigUint64Array)");
  std::shared_ptr<IndexState> state = liveIndex(env, argv[0]);
  Input<uint64_t> allowed =
      readAllowedIds(env, argv[1], readBorrow(env, argv, 3));
  std::shared_ptr<VectorIndex> idx = state->idx;
  return startJob(
      env,
      Lane::Bulk,
      std::move(state),
      nullptr,
      readToken(env, argv, 2),
      [idx = std::move(idx), allowed = std::move(allowed)]() {
        VectorIndexFilter filter = idx->createFilter(
            allowed.dataOrNull(), static_cast<int>(allowed.size));
        if (!filter.valid()) {
          fail("InvalidArgument", "ggml_vec_index_filter_create returned null");
        }
        return std::make_shared<FilterHandle>(idx, std::move(filter));
      });
}
TURBOVEC_CATCH

// idxSearchPreparedFilteredAsync(handle, filter, queries, k, token?, borrow?)
//   -> Promise<result>
js_value_t*
idxSearchPreparedFilteredAsync(js_env_t* env, js_callback_info_t* info) try {
  const Args argv = readArgs(
      env, info, 4, "(handle, filter, queries:Float32Array, k:number)");
  std::shared_ptr<IndexState> state = liveIndex(env, argv[0]);
  std::shared_ptr<FilterState> filter = filterState(env, argv[1]);
  if (!filter->handle) {
    fail("InvalidArgument", "IdMapIndexFilter has been disposed");
  }
  if (filter->busy) {
    fail("Busy", "IdMapIndexFilter has an async operation in progress");
  }
  Search search =
      readSearch(env, *state->idx, argv[2], argv[3], readBorrow(env, argv, 5));
  std::shared_ptr<VectorIndex> idx = state->idx;
  std::shared_ptr<FilterHandle> handle = filter->handle;
  return startSearch(
      env,
      std::move(state),
      std::move(filter),
      readToken(env, argv, 4),
      std::move(search),
      [idx = std::move(idx), handle = std::move(handle)](
          const float* queries,
          int m,
          int32_t k,
          float* scores,
          uint64_t* ids) {
        return idx->searchPreparedFiltered(
            handle->filter, queries, m, k, scores, ids);
      });
}
TURBOVEC_CATCH

// idxSetStagedAsync(handle, enabled:boolean, token?) -> Promise<undefined>
// Bulk work, not a flag update: switching staged search on builds its cache
// across the whole index, and switching it off repacks the rows.
js_value_t* idxSetStagedAsync(js_env_t* env, js_callback_info_t* info) try {
  const Args argv = readArgs(env, info, 2, "(handle, enabled:boolean)");
  std::shared_ptr<IndexState> state = liveIndex(env, argv[0]);
  if (!js::is<js::Boolean>(env, argv[1])) {
    fail("InvalidArgument", "enabled must be a boolean");
  }
  const bool enabled = js::Boolean(env, argv[1]).as<bool>(env);
  return startBulk(
      env,
      std::move(state),
      readToken(env, argv, 2),
      [enabled](VectorIndex& idx) { return idx.setStaged(enabled); });
}
TURBOVEC_CATCH

// idxBuildIvfAsync(handle, nLists, nIter, token?) -> Promise<undefined>
js_value_t* idxBuildIvfAsync(js_env_t* env, js_callback_info_t* info) try {
  const Args argv =
      readArgs(env, info, 3, "(handle, nLists:number, nIter:number)");
  std::shared_ptr<IndexState> state = liveIndex(env, argv[0]);
  const int32_t nLists = readPositiveInt32(env, argv[1], "n_lists");
  const int32_t nIter = readNonnegativeInt32(env, argv[2], "n_iter");
  return startBulk(
      env,
      std::move(state),
      readToken(env, argv, 3),
      [nLists, nIter](VectorIndex& idx) {
        return idx.buildIvf(nLists, nIter);
      });
}
TURBOVEC_CATCH

// idxSearchIvfAsync(handle, queries, k, nProbe, token?, borrow?)
//   -> Promise<result>
js_value_t* idxSearchIvfAsync(js_env_t* env, js_callback_info_t* info) try {
  const Args argv = readArgs(
      env, info, 4, "(handle, queries:Float32Array, k:number, nProbe:number)");
  std::shared_ptr<IndexState> state = liveIndex(env, argv[0]);
  Search search =
      readSearch(env, *state->idx, argv[1], argv[2], readBorrow(env, argv, 5));
  const int32_t nProbe = readPositiveInt32(env, argv[3], "n_probe");
  std::shared_ptr<VectorIndex> idx = state->idx;
  return startSearch(
      env,
      std::move(state),
      nullptr,
      readToken(env, argv, 4),
      std::move(search),
      [idx = std::move(idx), nProbe](
          const float* queries,
          int m,
          int32_t k,
          float* scores,
          uint64_t* ids) {
        return idx->searchIvf(queries, m, k, nProbe, scores, ids);
      });
}
TURBOVEC_CATCH

// idxCompactAsync(handle, token?) -> Promise<undefined>
js_value_t* idxCompactAsync(js_env_t* env, js_callback_info_t* info) try {
  const Args argv = readArgs(env, info, 1, "handle");
  return startBulk(
      env,
      liveIndex(env, argv[0]),
      readToken(env, argv, 1),
      [](VectorIndex& idx) { return idx.compact(); });
}
TURBOVEC_CATCH

// idxPrepareAsync(handle, token?) -> Promise<undefined>
js_value_t* idxPrepareAsync(js_env_t* env, js_callback_info_t* info) try {
  const Args argv = readArgs(env, info, 1, "handle");
  return startBulk(
      env,
      liveIndex(env, argv[0]),
      readToken(env, argv, 1),
      [](VectorIndex& idx) {
        idx.prepare();
        return static_cast<int>(GGML_VEC_INDEX_OK);
      });
}
TURBOVEC_CATCH

// idxWriteAsync(handle, path, token?) -> Promise<undefined>
js_value_t* idxWriteAsync(js_env_t* env, js_callback_info_t* info) try {
  const Args argv = readArgs(env, info, 2, "(handle, path)");
  std::shared_ptr<IndexState> state = liveIndex(env, argv[0]);
  return startBulk(
      env,
      std::move(state),
      readToken(env, argv, 2),
      [path = readString(env, argv[1], "path")](VectorIndex& idx) {
        return idx.write(path);
      });
}
TURBOVEC_CATCH

// idxCompactDeltaAsync(handle, snapshotPath, deltaPath, token?)
//   -> Promise<undefined>
js_value_t* idxCompactDeltaAsync(js_env_t* env, js_callback_info_t* info) try {
  const Args argv = readArgs(env, info, 3, "(handle, snapshotPath, deltaPath)");
  std::shared_ptr<IndexState> state = liveIndex(env, argv[0]);
  return startBulk(
      env,
      std::move(state),
      readToken(env, argv, 3),
      [snapshot = readString(env, argv[1], "snapshotPath"),
       delta = readString(env, argv[2], "deltaPath")](VectorIndex& idx) {
        return idx.compactDelta(snapshot, delta);
      });
}
TURBOVEC_CATCH

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
  V("idx_contains", idxContains);
  V("idx_dispose", idxDispose);
  V("idx_filter_dispose", idxFilterDispose);
  V("idx_len", (idxIntGetter<&VectorIndex::len>));
  V("idx_dim", (idxIntGetter<&VectorIndex::dim>));
  V("idx_bit_width", (idxIntGetter<&VectorIndex::bitWidth>));
  V("idx_calibrated", idxCalibrated);
  V("idx_staged", idxStaged);
  V("idx_abort_token_create", idxAbortTokenCreate);
  V("idx_abort_token_abort", idxAbortTokenAbort);
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
  V("idx_set_staged_async", idxSetStagedAsync);
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
