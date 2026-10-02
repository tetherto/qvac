# Changelog

## [1.5.0] - 2026-09-15

### Fixed

- Sharded models loaded from disk now run qvac-fabric's automatic GPU/CPU placement (`--fit`). `initFromConfig` routes a multi-shard model through `llama_model_load_from_splits`, which bypasses `common_init_from_params` — the only place fabric runs the fit — so a sharded model larger than VRAM was offloaded whole and spilled back to host memory by the driver. The fit now runs before the split load, reading the model shape from the first shard, and its result (layer count, context size, tensor split, per-tensor buffer overrides, MoE cache and prefetch settings) is folded back into the load parameters so the context is created at the size the fit chose rather than the one it rejected. A `gpu_layers` the caller pinned still wins (QVAC-25039).
- Single-file loads now run the fit too, and run it the same way the sharded path does. `common_init_from_params` hands the fitter `params.tensor_buft_overrides.data()` and then ignores the returned status, so for a caller that set no override of its own the fitter received a null buffer, aborted at its first precondition with "did not provide buffer to set tensor_buft_overrides", and the model loaded unfitted with nothing in the log to say so. fabric pads that vector in `common_params_parse_ex` (common/arg.cpp), so a consumer reaching fabric through `common_params_parse` was already covered, but one using `common_params_parser_init` with its own handler dispatch was not. `initFromConfig` now fits this path through the same helper as the sharded one and clears `params.fit_params` so fabric does not repeat the fit in place, which brings the scratch buffers, the checked status and the lock below with it. Loads on this path consequently now pay the fitter's full descent search where they previously aborted after one probe.
- A fit that fails or errors no longer leaves the placement it rejected behind. `common_fit_params` writes candidate placements into the caller's `tensor_split` and `tensor_buft_overrides` buffers on every probe of its descent search, and restores only the two parameter structs when it gives up — so fitting in place could hand the load a placement the fitter had explicitly rejected, or every MoE expert pinned to CPU. The fit now runs against scratch buffers on both paths and adopts them only on success, matching what `@qvac/model-fit` does. A `COMMON_PARAMS_FIT_STATUS_ERROR` is now reported at error level instead of passing as quietly as a routine "does not fit".
- The process-global ggml log callback is restored after every fit. The fitter installs a pointer to one of its own stack frames as the log user_data and restores it on the way out, but not exception-safely: it throws from inside that window (a missing CPU backend, among others) and turns the throw into a status rather than putting the logger back, leaving the subsequent load to log through a freed frame. The saved callback is now reinstated unconditionally once the fitter returns.
- The fit is serialised within this module. `common/fit.h` documents `common_fit_params` as not thread-safe because it swaps the process-global llama logger for the duration of the call, installing a pointer to one of its own stack frames; a concurrent load in the same process logs through that global. This mirrors the `g_fitMutex` in `@qvac/model-fit`, which guards the identical call for the identical reason. Note the scope: the guard is a static local in an inline function, so each linked module gets its own, and it does not serialise against `@qvac/model-fit`'s mutex or against a fit any other fabric consumer starts.

### Added

- `fitParamsToFreeDeviceMemory(params, modelPath)` in `LlamacppUtils.hpp`: runs the fit against scratch buffers, checks the status, holds the lock and restores the logger, then folds the result into `params`. Every loader in this header goes through it, and it is the entry point a consumer loading a model outside `common_init_from_params` should use too.
- `padTensorBuftOverridesForFit(params)` and `trimTensorBuftOverridesAfterFit(params)`, for consumers that call `common_init_from_params` directly and so have to satisfy the fitter's buffer requirement in place. The padding is what gives `common_fit_params` somewhere to write its placement; the trim drops the unused tail afterwards, since the fitter needs `llama_max_tensor_buft_overrides()` (4096) writable entries while it runs but the loader reads only as far as the terminator, and `params` is copied by value into every per-slot context. Neither is needed by the loaders here, which use the scratch-buffer path instead.

### Breaking

- qvac-fabric >= 10549.0.0 headers are required. `LlamacppUtils.hpp` now includes `common/fit.h` and calls the nine-argument `common_fit_params`, reading `common_params::prefetch_weights_auto` and `llama_context_params::prefetch_weights`. Fabric 10297.1.2 and older declare an eight-argument `common_fit_params` and have neither field, so they no longer compile. This port declares no qvac-fabric dependency of its own — consumers supply the fabric headers — so consumers must be on 10549.0.0 before taking this version. No function signature in this port changed and nothing was removed: existing calls are source- and ABI-compatible.
- `initFromConfig` now writes back to the `common_params&` it is given, on every on-disk path: `n_gpu_layers`, `n_ctx`, `prefetch_weights`, `moe_cache_size`, `tensor_split` and `tensor_buft_overrides` carry the fit's decision after the call, where previously the parameters were only read. A caller that sizes anything from those fields afterwards sees the fitted values rather than the requested ones — which is the point, since the context is built from them. `fit_params` itself is left as the caller set it: the single-file path clears it only across its `common_init_from_params` call, to stop fabric fitting a second time, and restores it after. A caller that wants none of this sets `params.fit_params = false` before the call.

## [1.4.0] - 2026-09-07

### Fixed
- `js::Array::set` / `create` now match libjs 1.32's `js_set_array_elements` const placement (`js_value_t *const []` instead of `const js_value_t *[]`). The previous C++ span type (`std::span<const js_value_t*>`) produced `const js_value_t **`, which no longer converts. Callers that hold `js_value_t *[]` or `std::vector<js_value_t*>` keep compiling.

### Breaking
- libjs 1.32 headers (`bare-headers` >= 1.32) are required. libjs 1.30's `const js_value_t *[]` signature is no longer accepted, so consumers must raise their `bare-headers` floor to 1.32 before taking this version.

## [1.3.3] - 2026-07-31

### Fixed
- `JsAsyncTask` now releases its work captures on the JavaScript loop before settling its Promise. This lets an awaiting unload release large native models before the next load begins, while preserving the existing environment-teardown safety.
- Calling `cancel()` with no live jobs now uses a capture-free asynchronous task. The cancellation remains asynchronous without unnecessarily retaining `AddonCpp` and the model it owns.

## [1.3.2] - 2026-07-29

### Fixed
- `JsAsyncTask` now defers environment teardown until queued completions finish, preventing background work from touching disposed JavaScript state.

## [1.3.1] - 2026-07-24

### Fixed
- `MultiJobScheduler` cancel entry points (`cancel(id)`, `cancelAll()`, `cancelJobs()`) now return only once every job they delivered a model-side cancel for has fully left the scheduler (queue and in-flight set, i.e. its admission slot is released). Previously they returned as soon as the cancel was forwarded to the model, so a model that applies per-id cancels on its own worker (llm-llamacpp's continuous batch scheduler records the cancel and tears the slot down between decode steps) left a window where `activeJobs()` still counted the cancelled job — a consumer admitting a follow-up job the moment its cancel resolved was spuriously refused as busy, and the JS `cancel()` promise contract ("resolves when cancellation completes") silently regressed relative to `SingleJobScheduler`, whose cancel waits for the in-flight job to back out (`ProcessingSync::waitInactive`). Cancel paths that deliver no model-side cancel (no `cancelById` / no whole-model `cancel()`) still return immediately, and scheduler teardown is unchanged (never waits for the model).
- `cancelJobs()` drops every still-queued snapshot id in one lock pass before issuing or awaiting any in-flight cancel. The previous per-id loop, combined with the blocking cancel above, let a freed worker admit a queued snapshot id the loop had not reached yet — a job cancelled while queued ran anyway, with a graceful terminal instead of the documented "Job cancelled" error. Correctness no longer depends on the order the ids are passed in.

## [1.3.0] - 2026-07-06

### Added
- Swappable job admission: a new `IJobScheduler` strategy interface on `AddonCpp` (`src/inference-addon-cpp/job/IJobScheduler.hpp`). The single-job default is unchanged; a caller wanting cross-request continuous batching builds a `MultiJobScheduler` (fixed worker pool + bounded waiting-room queue, FIFO admission, back-pressure via `runJob` returning `std::nullopt` at capacity, exclusive-job support for e.g. finetune/inference mutual exclusion) and passes it into the `AddonCpp` constructor. `runJob`/`runExclusiveJob` mint each admitted job's `JobId` internally (monotonic, never reused for the scheduler's lifetime) and return it — callers never supply ids, so no two jobs can ever share one and a late terminal event can never be attributed to a newer job. At the JS boundary the admission result is never falsy on success: Boolean `false` = rejected, Boolean `true` = accepted on the untagged single-job path (the pre-1.3.0 shape, so existing `if (!accepted)` consumers are unaffected), Number >= 1 = accepted with a tagged id.
- Per-job cancellation: `AddonCpp::cancelJob(JobId id = kNoJobId)` targets one job; `cancelAllJobs()` cancels everything live at call time. The JS `cancel()` binding accepts an optional job id (`cancel(id)` → per-job; no id → snapshot-based cancel-all: `liveJobIds()` is captured on the JS thread and exactly that set is cancelled via `cancelJobs(ids)`; on the tagged multi-job path ids are never reused, so jobs admitted after the request survive the deferred cancellation, while the untagged single-job path can only snapshot the slot sentinel — the slot, not the job — so a cancel deferred past its job's end can still land on the slot's next occupant unless the model pins cancels to the run they were aimed at). Native job ids are back on queued/output events — carried once in 1.1.3 and reverted in 1.1.4 for being layered awkwardly on top of the single-job runner. This time id routing lives inside the scheduler itself, which guarantees exactly one terminal event per admitted job (including cancelled and queue-dropped jobs), so the same approach that was unsound in 1.1.3 is sound now.
- Per-job observed stats: models implementing the new `IModelJobStats` interface report end-to-end TTFT/TPS/token counts for each tagged job on its `jobEnded` event, instead of only the whole-model aggregate.
- `AddonCpp::activeJobs()` / JS `activeJobs` expose the scheduler's live admitted-job count (in-flight + queued) as the authoritative concurrency figure, replacing ad hoc in-flight counters in consumers.
- `js::Number::asChecked<uint64_t>()` and `JsArgsParser::getCheckedIntegralOptional`: validating parses for untrusted boundary numbers (finite, non-negative, integral, `<= 2^53 - 1`, else `InvalidArgument`); the per-job `cancel(id)` binding parses its job id through them. The plain `as<uint64_t>()` / `getIntegralOptional` keep their pre-1.3.0 truncating-cast behavior (now documented), so existing downstream parses are unaffected.
- `llm-llamacpp` wires a `MultiJobScheduler` sized from `parallel` so independent `run()` calls decode together via true cross-request continuous batching; a 1-slot pool behaves exactly as before.

### Breaking
- `OutputQueue::clear()` now returns `std::vector<std::pair<JobId, std::any>>` instead of `std::vector<std::any>` — every drained entry carries its originating job id.
- `JobRunner` is renamed `SingleJobScheduler` and moved from the root-level `JobRunner.hpp` to `job/SingleJobScheduler.hpp`. Its constructor no longer takes an `outputQueue` parameter; the queue is now supplied via `start(std::shared_ptr<OutputQueue>)`. The `JobRunner.hpp` backward-compatibility forwarding header (with its `using JobRunner = SingleJobScheduler` alias) has been removed — includers of `JobRunner.hpp` or the `JobRunner` name must switch to `job/SingleJobScheduler.hpp` / `SingleJobScheduler`.

## [1.2.4] - 2026-07-13

### Fixed
- `JsLogger` singleton ownership is now hardened for processes with multiple ephemeral JS envs (worklets / bare-thread workers). QVAC-21544 (1.2.3) fixed crashes on sequential teardown/reload, but left a documented gap: a second **concurrently live** env calling `setLogger` could silently hijack the singleton — leaking the first env's callback ref and leaving `logger_async_` on the wrong loop; `releaseLogger` from a non-owner env could tear down another env's logger (including a cross-thread `uv_close`); and C++ producer threads could race `uv_async_send` against handle close during teardown. This release serializes install, release, and teardown under `admin_mutex_`, rejects concurrent install from a different live env (`InvalidArgument`: "Logger already installed by another env; call releaseLogger first"), makes non-owner `releaseLogger` a no-op, scopes `onEnvTeardown` to the owning env, clears undrained log entries on release/teardown, holds `admin_mutex_` around the armed check and `uv_async_send` in `log()`, and gates enqueue on a live owner so C++ logs emitted after `releaseLogger`/teardown are dropped instead of bleeding into the next owner's callback.

### Added
- JS integration test suite `tests/integration_js/logger/reject.test.js` covering concurrent-env `setLogger` rejection, sequential cross-env handoff, non-owner `releaseLogger` no-op, and teardown-without-release reload.
- Regression test in `tests/integration_js/logger/test.js` for orphaned log entries between `releaseLogger()` and the next `setLogger()`.
- Regression test for same-env callback replacement via `setLogger` without an intervening `releaseLogger`.

## [1.2.3] - 2026-07-02

### Fixed
- `JsLogger` no longer crashes during Bare runtime/worklet teardown or on a subsequent `setLogger()` after a soft reload (QVAC-21544). Two related lifecycle bugs are addressed: (1) a `js_add_teardown_callback` now disarms the logger (nulls the shared state and `uv_close`s the async handle) while the env is being destroyed, so the teardown's final `uv_run` can no longer dispatch `asyncCallback` against a disposing JS context (`SIGABRT`); and (2) `setLogger()` / `releaseLogger()` now only delete the previously stored callback ref when it belongs to the current live env (`oldState->env == env`) — a soft reload leaves a stale ref owned by an already-disposed env whose V8 global handles are gone, so deleting it crashed in `GlobalHandles::Release`. Verified on-device (Pixel, Android 16) with the translation addon: reload followed by re-translate no longer aborts.

### Added
- JS integration test `tests/integration_js/logger/teardown.test.js` reproducing the forced worker-runtime teardown race that surfaces the crash above.

## [1.2.2] - 2026-06-30

### Fixed
- Self-pin the addon's shared library (`pinAddon()` in `Pin.hpp`, hooked once in `JsInterface::createInstance`) so that bare's `dlclose()` on `worklet.terminate()` can never unmap addon code that still has `thread_local` / `pthread_key_t` destructors registered (ggml, OpenMP, …). On Android (bionic) `dlclose()` unmaps that code, so a later thread exit jumped into now-unmapped memory and aborted (SIGSEGV); the SDK worked around this by never terminating worklets, leaking ~150 MB per load/unload cycle. Each addon now takes an `RTLD_NOLOAD | RTLD_NODELETE` reference to its own library (`GET_MODULE_HANDLE_EX_FLAG_PIN` on Windows) on first instance creation — only the small, fixed code mapping stays resident; the isolate + thread are still fully torn down. Idempotent and thread-safe (single atomic guard). Matches the existing `bare-crypto` / `bare-tls` approach. Validated on-device (Pixel 10 Pro XL, bionic): the destructor-after-`dlclose` case crashes without the pin and survives with it.

## [1.2.1] - 2026-05-20

### Fixed
- `~OutputCallBackJs()` now releases JS references synchronously before scheduling `uv_close`, instead of doing it inside the close-callback lambda. The previous ordering deferred `js_delete_reference()` into a libuv close-phase callback that could run after the host worklet `js_env_t*` had already been invalidated (iOS bare-kit teardown after `unload()`), producing `EXC_BAD_ACCESS` / PAC failures inside `js_delete_reference` / `js_open_handle_scope`. The close-callback now only frees the `uv_async_t` handle and the `State`, neither of which touches the JS env, so it is safe regardless of when libuv runs it.

## [1.1.5] - 2026-04-30

### Fixed
- Keep JS output callback state alive until pending libuv async delivery is closed, avoiding teardown races.
- Work around a Bare/libjs first `js_create_double()` issue on GitHub Azure win32-x64 runners by routing addon double creation through `js::Number`.

### Added
- Add JS integration CI coverage for callback lifetime and number creation across desktop platforms.

## [1.1.4] - 2026-03-30

### Breaking
- Reverted native job IDs from 1.1.3 — `cancel(jobId)` overload and `jobId` field on queued events removed.

### Fixed
- Cancel race condition: `cancel()` was a no-op once the worker dequeued the job, so the model kept running and the next request appeared stuck.
- `cancel()` now correctly handles both queued and actively-processing jobs without deadlock or stale stop flags.

### Added
- Regression test for cancel during active processing.

## [1.1.3] - 2026-03-18
- Add native job IDs to queued addon events so JS callbacks can distinguish late cancel/error delivery from newer accepted jobs.
- Extend JS callback delivery with a trailing native `jobId` argument while keeping existing 4-argument handlers compatible.
- Make shared `cancel(handle, jobId)` honor the requested job ID while remaining backward compatible for existing callers that omit it.
- Add addon-cpp regression coverage for late cancel ownership and stale cancel isolation.

## [1.1.2] - 2026-02-20
Reduce noise from logs, macro for compile-time enabling of debug logs.

## [1.1.1] - 2026-02-17
- await addon.cancel() does not guarantee job is finished even though await is specified.
- Other improvement/fixes related to run and cancel:

Some tests were hanging when using cancel.
- Detect reliably of job already running.

Other improvements:
- transitionCb unused

## [1.0.0] - 2025-12-15

Refactored from complex templated Addon and JsInterface classes to a simpler architecture using `std::any` and output handlers. The use of `std::any` is better aligned with the already dynamic handling of JavaScript types. Refer to [docs/usage.md](docs/usage.md) for updated usage and examples.

### Breaking 
- Templated and overridden Addon and JsInterface no longer supported

### Changes
- Eliminated complex state handling 
- Simplified job execution with single JobRunner (no priority queue)
- Eliminated templated Addon and JsInterface
- Eliminated coupling of js-related code with C++ core
- `AddonCpp` and `AddonJs` are composed of several components instead of having all implementation in one file
- Model's `process(std::any)` receives input directly (no input handlers)
- JobRunner releases lock during `model->process()` to allow cancellation

### Added 
- Extensible output handlers
- C++ Addon tests 
- C++ Handlers tests

### Kept
- Multiple parallel instances: Needed to use several addons at once
- Job cancellation: Important feature required by some Addon implementations

### Benefits
- **Modular Architecture**: Components are now separated into smaller, focused modules
- **Extensibility**: New output handlers can be added without modifying core classes
- **Separation of Concerns**: JavaScript-specific code is decoupled from C++ core
- **Type Flexibility**: Use of `std::any` aligns better with JavaScript's dynamic typing
- **Simplified Testing**: Pure C++ addons can be tested directly without JavaScript bindings
- **Reduced Complexity**: Single job runner is easier to reason about

### Trade-offs
- **Runtime Type Checking**: Using `std::any` means type checking happens at runtime
- **Single Job Execution**: No priority scheduling (application manages job ordering if needed)
