# Changelog

## [1.1.8] - 2026-05-12

### Fixed
- Guard `OutputCallBackJs` against use-after-free of `js_env_t*` during model unload. The destructor's `uv_close` close callback released JS references asynchronously, so a model that left a dirty libuv queue at teardown (pending `uv_async_send` activations, unjoined streaming threads, or in-flight `cancel` work) could race the host env invalidation. On iOS, where react-native-bare-kit worklets tear down the env aggressively on unload, this manifested as `EXC_BAD_ACCESS` (PAC failure) inside `js_delete_reference` / `js_open_handle_scope`. An atomic `envInvalidated` flag is now flipped from a `js_add_teardown_callback`, and all paths that touch JS state (`uv_close` close callback, sync destructor branch, `jsOutputCallback`) bail out when the env is gone instead of dereferencing a dangling pointer. This does not absolve callers from draining their own queues before destroying the instance.

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
