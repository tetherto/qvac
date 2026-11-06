#pragma once

// The part of @qvac/fabric's C API that is fabric's own rather than llama.cpp's
// or ggml's: locating and loading the ggml backend modules shipped with this
// runtime. Consumers call it instead of computing a backends directory in
// JavaScript, which bare-pack cannot follow and which has no answer inside a
// bundle or an APK.

#include <stddef.h>

#if defined(_WIN32)
#if defined(QVAC_FABRIC_BUILD)
#define QVAC_FABRIC_API __declspec(dllexport)
#else
#define QVAC_FABRIC_API __declspec(dllimport)
#endif
#else
#define QVAC_FABRIC_API __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

// Loads the ggml backend modules shipped with this runtime from
// qvac_fabric_backends_dir(), once per process; later calls only return the
// count. Thread-safe. Returns the number of registered ggml backends. A no-op
// on hosts whose backends are linked into the runtime (Apple).
// NOLINTNEXTLINE(readability-identifier-naming)
QVAC_FABRIC_API size_t qvac_fabric_load_backends(void);

// Where qvac_fabric_load_backends() looks, in order:
//   1. $QVAC_FABRIC_BACKENDS_DIR, when set and non-empty;
//   2. <runtime dir>/<runtime module name>, when it is a directory: an
//      installed platform package, prebuilds/<host>/qvac__fabric-<suffix>/;
//   3. <runtime dir>: bare-link output, where the backends sit next to the
//      runtime, including an APK's lib/<abi>/ when libraries are not
//      extracted (the directory cannot be listed there, and ggml falls back
//      to loading each backend by file name).
// The runtime dir is the directory of the loaded runtime module itself. The
// string is UTF-8 and stays valid for the life of the process.
// NOLINTNEXTLINE(readability-identifier-naming)
QVAC_FABRIC_API const char* qvac_fabric_backends_dir(void);

// ---------------------------------------------------------------------------
// Decision models (upstream llama.cpp's typed decision API, "systemone").
//
// Runs upstream's server-context in-process: decision parsing, prompt
// rendering, task scheduling and answer calculation all stay upstream's. No
// HTTP server is started. Requests and results use upstream's /v1/systemone
// JSON shapes; mapping them to a public API is the caller's job.
//
// Strings passed in are UTF-8 JSON and are only read during the call. Strings
// returned through `char**` are owned by the caller and must be released with
// qvac_fabric_decision_free_string(). No function throws.
// ---------------------------------------------------------------------------

typedef struct qvac_fabric_decision qvac_fabric_decision;
typedef struct qvac_fabric_decision_cancel qvac_fabric_decision_cancel;

// NOLINTNEXTLINE(readability-identifier-naming)
enum qvac_fabric_decision_status {
  QVAC_FABRIC_DECISION_OK = 0,
  // The run was cancelled (its token was cancelled, or the engine is being
  // destroyed). Never reported as OK, even if upstream returned a response.
  QVAC_FABRIC_DECISION_CANCELLED = 1,
  // The request was rejected: bad JSON, nesting deeper than
  // QVAC_FABRIC_DECISION_MAX_JSON_DEPTH, or upstream validation (unknown
  // question type, too many options, unsupported input...). result_json
  // carries {"error": {"message": ..., ...}}.
  QVAC_FABRIC_DECISION_INVALID_REQUEST = 2,
  // Execution failed. result_json carries {"error": {...}} when available.
  QVAC_FABRIC_DECISION_ERROR = 3,
  // The engine no longer accepts runs (destroy has started).
  QVAC_FABRIC_DECISION_UNAVAILABLE = 4,
};

// Maximum nesting of the values inside a request body: a state, instruction or
// description may be nested this many levels deep, the same limit upstream
// applies to the values it walks recursively (llama.cpp #30242). The body
// object itself adds one level. Deeper requests are rejected before any
// recursive code sees them: running in-process there is no crash isolation,
// and catching an exception cannot recover from a stack overflow.
#define QVAC_FABRIC_DECISION_MAX_JSON_DEPTH 128

// Loads a decision model and starts its execution loop on a thread the engine
// owns. params_json fields (all optional except "model"):
//   "model"              string  GGUF path
//   "mmproj"             string  projector GGUF path, for media input
//   "lora"               array   [{"path": string, "scale": number}]
//   "n_ctx", "n_batch", "n_ubatch", "n_parallel", "n_gpu_layers",
//   "n_threads"          integer
//   "sleep_idle_seconds" integer (default -1, never sleep)
// Calls qvac_fabric_load_backends() itself. On success returns
// QVAC_FABRIC_DECISION_OK and sets *out. On failure nothing is left running,
// *out is NULL, and *error_json (if error_json is not NULL) describes it.
// NOLINTNEXTLINE(readability-identifier-naming)
QVAC_FABRIC_API int qvac_fabric_decision_create(
    const char* params_json, qvac_fabric_decision** out, char** error_json);

// The loaded model's decision capabilities, as a JSON object:
//   {"decision_type": "openjev", "noul": "probability" | "expected_rating",
//    "joint": bool, "shared_prefix": bool, "images": bool, "audio": bool,
//    "score_levels": {"min": 2, "max": 10}, "max_json_depth": 128,
//    "n_ctx": int, "model": string}
// Free with qvac_fabric_decision_free_string(). NULL if d is NULL.
// NOLINTNEXTLINE(readability-identifier-naming)
QVAC_FABRIC_API char* qvac_fabric_decision_info(qvac_fabric_decision* d);

// A cancellation token, shared between the thread that runs a request and the
// thread that cancels it. Created with one reference; each holder releases its
// own. A run keeps its own reference while it uses the token, so the creator
// may release it at any time. Cancelling is thread-safe and sticky.
// NOLINTNEXTLINE(readability-identifier-naming)
QVAC_FABRIC_API qvac_fabric_decision_cancel*
qvac_fabric_decision_cancel_create(void);
// NOLINTNEXTLINE(readability-identifier-naming)
QVAC_FABRIC_API void
qvac_fabric_decision_cancel_retain(qvac_fabric_decision_cancel* c);
// NOLINTNEXTLINE(readability-identifier-naming)
QVAC_FABRIC_API void
qvac_fabric_decision_cancel_release(qvac_fabric_decision_cancel* c);
// NOLINTNEXTLINE(readability-identifier-naming)
QVAC_FABRIC_API void
qvac_fabric_decision_cancel_request(qvac_fabric_decision_cancel* c);

// Runs one /v1/systemone request (one state) and blocks until it finishes.
// cancel may be NULL. Several runs may be in flight on one engine; upstream
// schedules their tasks over its n_parallel slots. Upstream checks
// cancellation between result polls, so a cancel takes effect at the next
// poll, not in the middle of a backend computation. *result_json receives the
// upstream result object on OK, or {"error": {...}} otherwise.
// NOLINTNEXTLINE(readability-identifier-naming)
QVAC_FABRIC_API int qvac_fabric_decision_run(
    qvac_fabric_decision* d, const char* request_json,
    qvac_fabric_decision_cancel* cancel, char** result_json);

// Stops accepting runs, cancels the runs in flight and waits for them to
// return, stops the execution loop, joins its thread and frees the model.
// Must not be called concurrently with itself or after it returned.
// NOLINTNEXTLINE(readability-identifier-naming)
QVAC_FABRIC_API void qvac_fabric_decision_destroy(qvac_fabric_decision* d);

// NOLINTNEXTLINE(readability-identifier-naming)
QVAC_FABRIC_API void qvac_fabric_decision_free_string(char* s);

#ifdef __cplusplus
}
#endif
