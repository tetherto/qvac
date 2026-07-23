# Changelog

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
