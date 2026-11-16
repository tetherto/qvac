#pragma once
//
// Runs vector-index work off the JS thread. A job's work runs on one of two
// process-wide lanes of worker threads owned by this addon, and its promise
// settles on the JS thread of the environment that started it. The lanes are
// separate from the libuv threadpool, so a long IVF build cannot hold the
// slots that file I/O needs, and separate from each other, so long builds,
// loads and writes cannot hold up searches. Each fabric call runs on the one
// thread that makes it: the addon leaves fabric's per-index thread count at 1.

#include <cstddef>
#include <cstdint>
#include <functional>
#include <initializer_list>
#include <vector>

#include <js.h>

namespace turbovec_ggml::async_job {

enum class Lane : std::uint8_t {
  // Work that can take seconds or more: IVF builds, adds, loads, writes,
  // compaction and logged removes.
  Bulk,
  // Searches and other short reads, plus filter creation and plain removes.
  Search,
};

// Threads per lane, across the process. More jobs wait in the lane's queue.
constexpr size_t BULK_THREADS = 1;
constexpr size_t SEARCH_THREADS = 1;

// Runs on a worker thread and returns a ggml_vec_index_error status. Must not
// touch JS, and must not read JS memory: copy inputs before starting the job,
// since JS can change or detach an array while the work runs. Anything it
// captures is destroyed on the JS thread. Skipped, with
// GGML_VEC_INDEX_E_INTERNAL, when the environment is torn down before the job
// starts.
using Work = std::function<int()>;

// Runs on the JS thread with the status `Work` returned and the values the
// job kept alive, in the order they were passed to `start()`. Returns the
// value to resolve the promise with, or nullptr with a pending JS exception
// to reject it. Not called when the environment is torn down first.
using Settle = std::function<js_value_t*(
    js_env_t*, int status, const std::vector<js_value_t*>& kept)>;

// Queues `work` on `lane` and returns its promise. Every value in `keepAlive`
// is referenced until the job settles, so handles and buffers the work reads or
// writes cannot be collected while it runs. A nullptr entry keeps its slot
// and reaches `settle` as nullptr. On failure, throws a JS error and
// returns nullptr; neither callback runs.
js_value_t* start(
    js_env_t* env, Lane lane, std::initializer_list<js_value_t*> keepAlive,
    Work work, Settle settle);

} // namespace turbovec_ggml::async_job
