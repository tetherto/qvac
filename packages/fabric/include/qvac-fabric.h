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
QVAC_FABRIC_API const char* qvac_fabric_backends_dir(void);

#ifdef __cplusplus
}
#endif
