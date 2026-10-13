// Mocked uv.h. Production headers include <uv.h> directly now that libjs no
// longer pulls it in through <js.h>. Unit tests compile against this stub
// instead of libuv: async send and close dispatch their callbacks
// synchronously so the JsAsyncTask completion chain (worker -> uv_async_send
// -> completion -> uv_close -> close callback) is observable without a loop.

#pragma once

struct uv_async_t {
  void* data;
  // Stored by the mocked uv_async_init so uv_async_send can dispatch the
  // completion callback synchronously (stands in for the libuv loop).
  void (*async_cb)(uv_async_t*) = nullptr;
};
struct uv_handle_t {};
struct uv_loop_t {};

inline int
uv_async_init(uv_loop_t* loop, uv_async_t* handle, void (*cb)(uv_async_t*)) {
  handle->async_cb = cb;
  return 0;
}

inline int uv_async_send(uv_async_t* handle) {
  if (handle->async_cb != nullptr) {
    handle->async_cb(handle);
  }
  return 0;
}

inline void* uv_handle_get_data(uv_handle_t* handle) { return nullptr; }

inline void uv_handle_set_data(uv_handle_t* handle, void* data) {}

inline void uv_close(uv_handle_t* handle, void (*cb)(uv_handle_t*)) {
  if (cb != nullptr) {
    cb(handle);
  }
}
