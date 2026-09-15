"""Temporary QVAC-25129 diagnostic; uses the exact CI prebuild, no models."""

import ctypes as c
import json
import os
from pathlib import Path
import sys
import time


class InitParams(c.Structure):
    _fields_ = [("mem_size", c.c_size_t), ("mem_buffer", c.c_void_p), ("no_alloc", c.c_bool)]


root = Path(sys.argv[1]).resolve()
addons = list(root.rglob("qvac__diffusion-cpp.bare"))
assert len(addons) == 1, addons
# GGML symbols are exported by the addon for its Vulkan plugin. Lazy binding
# leaves the unused JavaScript entry points unresolved in this model-free probe.
lib = c.CDLL(str(addons[0]), mode=os.RTLD_LAZY | os.RTLD_GLOBAL)


def api(name, result, *args):
    fn = getattr(lib, name)
    fn.restype = result
    fn.argtypes = args
    return fn


ptr = c.c_void_p
load_backend = api("ggml_backend_load", ptr, c.c_char_p)
init_backend = api("ggml_backend_init_by_type", ptr, c.c_int, c.c_char_p)
backend_name = api("ggml_backend_name", c.c_char_p, ptr)
backend_device = api("ggml_backend_get_device", ptr, ptr)
default_buft = api("ggml_backend_get_default_buffer_type", ptr, ptr)
host_buft = api("ggml_backend_dev_host_buffer_type", ptr, ptr)
buf_name = api("ggml_backend_buffer_name", c.c_char_p, ptr)
buf_is_host = api("ggml_backend_buffer_is_host", c.c_bool, ptr)
init_ctx = api("ggml_init", ptr, InitParams)
new_tensor = api("ggml_new_tensor_1d", ptr, ptr, c.c_int, c.c_int64)
alloc_ctx = api("ggml_backend_alloc_ctx_tensors_from_buft", ptr, ptr, ptr)
set_usage = api("ggml_backend_buffer_set_usage", None, ptr, c.c_int)
fill = api("ggml_backend_tensor_memset", None, ptr, c.c_uint8, c.c_size_t, c.c_size_t)
copy = api("ggml_backend_tensor_copy", None, ptr, ptr)
read = api("ggml_backend_tensor_get", None, ptr, ptr, c.c_size_t, c.c_size_t)
sync = api("ggml_backend_synchronize", None, ptr)
free_buf = api("ggml_backend_buffer_free", None, ptr)
free_ctx = api("ggml_free", None, ptr)
free_backend = api("ggml_backend_free", None, ptr)

plugins = list(root.rglob("libqvac-diffusion-ggml-vulkan.so"))
assert len(plugins) == 1, plugins
assert load_backend(os.fsencode(plugins[0])), "Vulkan plugin did not load"
cpu = init_backend(0, None)
gpu = init_backend(1, None)
assert cpu and gpu, "CPU and discrete GPU backends are required"
print("BACKENDS", backend_name(cpu).decode(), backend_name(gpu).decode(), flush=True)


def tensor(buft, size):
    ctx = init_ctx(InitParams(65536, None, True))
    assert ctx
    value = new_tensor(ctx, 0, size // 4)  # GGML_TYPE_F32
    buffer = alloc_ctx(ctx, buft)
    assert buffer, "buffer allocation failed"
    set_usage(buffer, 1)  # GGML_BACKEND_BUFFER_USAGE_WEIGHTS
    return ctx, value, buffer


try:
    for mode, source_type in [("CPU", default_buft(cpu)),
                              ("Vulkan_Host", host_buft(backend_device(gpu)))]:
        assert source_type, mode
        for mib in [64, 192, 512]:
            size = mib * 1024 * 1024
            source = tensor(source_type, size)
            target = tensor(default_buft(gpu), size)
            try:
                fill(source[1], 42, 0, size)
                samples = []
                for _ in range(3):
                    start = time.perf_counter()
                    copy(source[1], target[1])
                    sync(gpu)
                    samples.append(round(1000 * (time.perf_counter() - start), 3))
                for offset in [0, size - 32]:
                    output = c.create_string_buffer(32)
                    read(target[1], output, offset, 32)
                    assert output.raw == bytes([42]) * 32, "copied bytes differ"
                print(json.dumps({"source": mode, "MiB": mib, "milliseconds": samples,
                                  "source_buffer": buf_name(source[2]).decode(),
                                  "target_buffer": buf_name(target[2]).decode(),
                                  "target_is_host": buf_is_host(target[2]),
                                  "bytes_verified": True}), flush=True)
            finally:
                free_buf(target[2])
                free_ctx(target[0])
                free_buf(source[2])
                free_ctx(source[0])
finally:
    free_backend(gpu)
    free_backend(cpu)
