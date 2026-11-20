#pragma once

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

// Browser backends are linked into the WebAssembly module, so the web binding
// implements these native Fabric loader functions as no-ops.
size_t qvac_fabric_load_backends(void);
const char *qvac_fabric_backends_dir(void);

#ifdef __cplusplus
}
#endif
