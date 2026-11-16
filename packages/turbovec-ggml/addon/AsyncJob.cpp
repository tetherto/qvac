#include "AsyncJob.hpp"

#include <atomic>
#include <exception>
#include <memory>
#include <new>
#include <utility>

#include <ggml-vector-index.h>
#include <uv.h>

#include "WorkerPool.hpp"

namespace turbovec_ggml::async_job {

namespace {

// One pool per lane. Never destroyed, so static destruction at process exit
// cannot wait on a running job.
WorkerPool& pool(Lane lane) {
  static auto* bulk = new WorkerPool(BULK_THREADS);
  static auto* search = new WorkerPool(SEARCH_THREADS);
  return lane == Lane::Bulk ? *bulk : *search;
}

struct Job {
  js_env_t* env = nullptr;
  js_deferred_t* deferred = nullptr;
  uv_async_t async{};
  // Holds env teardown back until the worker is done, so the worker's
  // uv_async_send always reaches a live loop. Finished by onClose.
  js_deferred_teardown_t* teardown = nullptr;
  // JS thread only. Once false, no JS call is legal.
  bool envAlive = true;
  // Set with envAlive. A job that has not started by then is skipped, so
  // teardown waits only for the jobs already running.
  std::atomic<bool> abandoned{false};
  std::vector<js_ref_t*> refs;
  Work work;
  Settle settle;
  int status = GGML_VEC_INDEX_OK;
};

void deleteRefs(Job* job) {
  for (js_ref_t* ref : job->refs) {
    if (ref != nullptr) {
      js_delete_reference(job->env, ref);
    }
  }
  job->refs.clear();
}

void onEnvTeardown(js_deferred_teardown_t* /*handle*/, void* data) {
  auto* job = static_cast<Job*>(data);
  job->envAlive = false;
  job->abandoned.store(true);
}

void onClose(uv_handle_t* handle) {
  std::unique_ptr<Job> job(static_cast<Job*>(handle->data));
  job->work = nullptr;
  job->settle = nullptr;
  if (job->teardown != nullptr) {
    js_finish_deferred_teardown_callback(job->teardown);
  }
}

void settleJob(Job* job) {
  js_env_t* env = job->env;
  js_handle_scope_t* scope = nullptr;
  if (js_open_handle_scope(env, &scope) != 0) {
    // No JS value can be created without a scope, so the promise cannot be
    // settled. Bare only fails this when the environment cannot allocate.
    return;
  }

  std::vector<js_value_t*> kept;
  bool ok = true;
  try {
    kept.reserve(job->refs.size());
    for (js_ref_t* ref : job->refs) {
      js_value_t* value = nullptr;
      if (ref != nullptr && js_get_reference_value(env, ref, &value) != 0) {
        ok = false;
        break;
      }
      kept.push_back(value);
    }
  } catch (...) {
    ok = false;
  }

  js_value_t* result = nullptr;
  if (ok) {
    try {
      result = job->settle(env, job->status, kept);
    } catch (const std::bad_alloc&) {
      js_throw_error(env, "OutOfMemory", "allocation failure");
    } catch (...) {
      js_throw_error(env, "InternalError", "async settle failed");
    }
  } else {
    js_throw_error(env, "InternalError", "lost an async job value");
  }

  if (result != nullptr) {
    js_resolve_deferred(env, job->deferred, result);
  } else {
    js_value_t* error = nullptr;
    bool pending = false;
    if (js_is_exception_pending(env, &pending) != 0 || !pending ||
        js_get_and_clear_last_exception(env, &error) != 0 || error == nullptr) {
      // Settle returned nullptr without throwing. Reject with a generic
      // error so the promise never stays pending.
      static constexpr char kMessage[] = "async job failed";
      js_value_t* message = nullptr;
      js_create_string_utf8(
          env,
          reinterpret_cast<const utf8_t*>(kMessage),
          sizeof(kMessage) - 1,
          &message);
      js_create_error(env, nullptr, message, &error);
    }
    js_reject_deferred(env, job->deferred, error);
  }
  js_close_handle_scope(env, scope);
}

// Called from uv on the JS thread. The close handshake must always run, or
// env teardown waits forever.
void onComplete(uv_async_t* handle) {
  auto* job = static_cast<Job*>(handle->data);
  job->work = nullptr;
  if (job->envAlive) {
    settleJob(job);
    deleteRefs(job);
  }
  job->settle = nullptr;
  uv_close(reinterpret_cast<uv_handle_t*>(handle), onClose);
}

} // namespace

js_value_t* start(
    js_env_t* env, Lane lane, std::initializer_list<js_value_t*> keepAlive,
    Work work, Settle settle) {
  std::unique_ptr<Job> job;
  try {
    job = std::make_unique<Job>();
    job->refs.reserve(keepAlive.size());
  } catch (const std::bad_alloc&) {
    js_throw_error(env, "OutOfMemory", "allocation failure");
    return nullptr;
  }
  job->env = env;
  job->work = std::move(work);
  job->settle = std::move(settle);

  for (js_value_t* value : keepAlive) {
    js_ref_t* ref = nullptr;
    if (value != nullptr && js_create_reference(env, value, 1, &ref) != 0) {
      deleteRefs(job.get());
      js_throw_error(env, "InternalError", "failed to reference job value");
      return nullptr;
    }
    job->refs.push_back(ref);
  }

  js_value_t* promise = nullptr;
  uv_loop_t* loop = nullptr;
  if (js_create_promise(env, &job->deferred, &promise) != 0 ||
      js_get_env_loop(env, &loop) != 0 ||
      uv_async_init(loop, &job->async, onComplete) != 0) {
    deleteRefs(job.get());
    js_throw_error(env, "InternalError", "failed to start async job");
    return nullptr;
  }
  job->async.data = job.get();

  // From here on the handle owns the job and only uv_close may free it.
  Job* raw = job.release();
  if (js_add_deferred_teardown_callback(
          env, onEnvTeardown, raw, &raw->teardown) != 0) {
    raw->teardown = nullptr;
    deleteRefs(raw);
    uv_close(reinterpret_cast<uv_handle_t*>(&raw->async), onClose);
    js_throw_error(env, "InternalError", "failed to register job teardown");
    return nullptr;
  }

  const bool posted = pool(lane).post([raw]() {
    try {
      raw->status =
          raw->abandoned.load() ? GGML_VEC_INDEX_E_INTERNAL : raw->work();
    } catch (const std::bad_alloc&) {
      raw->status = GGML_VEC_INDEX_E_OOM;
    } catch (...) {
      raw->status = GGML_VEC_INDEX_E_INTERNAL;
    }
    uv_async_send(&raw->async);
  });
  if (!posted) {
    deleteRefs(raw);
    uv_close(reinterpret_cast<uv_handle_t*>(&raw->async), onClose);
    js_throw_error(env, "InternalError", "failed to queue async job");
    return nullptr;
  }
  return promise;
}

} // namespace turbovec_ggml::async_job
