"""Temporary QVAC-25129 diagnostic; uses the exact CI prebuild, no models."""

import ctypes as c
import json
import os
from pathlib import Path
import sys
import subprocess
import time


class InitParams(c.Structure):
    _fields_ = [("mem_size", c.c_size_t), ("mem_buffer", c.c_void_p), ("no_alloc", c.c_bool)]


root = Path(sys.argv[1]).resolve()
print("RESOURCE logical_cpus", os.cpu_count(), flush=True)
for filename in ["/proc/meminfo", "/proc/swaps", "/proc/pressure/memory",
                 "/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory.current",
                 "/sys/fs/cgroup/cpu.max"]:
    source = Path(filename)
    print("RESOURCE", filename, flush=True)
    print(source.read_text() if source.exists() else "unavailable", flush=True)
for key in ["GGML_VK_PREFER_HOST_MEMORY", "GGML_VK_DISABLE_ASYNC",
            "GGML_VK_SUBALLOCATION_BLOCK_SIZE", "GGML_VK_FORCE_MAX_BUFFER_SIZE",
            "GGML_VK_FORCE_MAX_ALLOCATION_SIZE", "OMP_NUM_THREADS", "GLIBC_TUNABLES"]:
    print("SETTING", key, repr(os.environ.get(key)), flush=True)
for command in [["lscpu"], ["nvidia-smi"], ["nvidia-smi", "-q"]]:
    print("DIAGNOSTIC", command, flush=True)
    result = subprocess.run(command, timeout=30, check=False)
    print("EXIT", result.returncode, flush=True)
plugins = list(root.rglob("libqvac-diffusion-ggml-vulkan.so"))
assert len(plugins) == 1, plugins
# The Vulkan module includes the GGML buffer APIs. Loading it directly avoids
# the addon's JavaScript ABI and uses the same compiled transfer implementation.
lib = c.CDLL(str(plugins[0]), mode=os.RTLD_GLOBAL)


def api(name, result, *args):
    fn = getattr(lib, name)
    fn.restype = result
    fn.argtypes = args
    return fn


ptr = c.c_void_p
plugin_init = api("ggml_backend_init", ptr)
device_count = api("ggml_backend_reg_dev_count", c.c_size_t, ptr)
device_get = api("ggml_backend_reg_dev_get", ptr, ptr, c.c_size_t)
device_type = api("ggml_backend_dev_type", c.c_int, ptr)
init_device = api("ggml_backend_dev_init", ptr, ptr, c.c_char_p)
cpu_buft = api("ggml_backend_cpu_buffer_type", ptr)
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
data_pointer = api("ggml_get_data", ptr, ptr)
set_tensor = api("ggml_backend_tensor_set", None, ptr, ptr, c.c_size_t, c.c_size_t)
set_tensor_async = api("ggml_backend_tensor_set_async", None, ptr, ptr, ptr, c.c_size_t, c.c_size_t)
read = api("ggml_backend_tensor_get", None, ptr, ptr, c.c_size_t, c.c_size_t)
sync = api("ggml_backend_synchronize", None, ptr)
free_buf = api("ggml_backend_buffer_free", None, ptr)
free_ctx = api("ggml_free", None, ptr)
free_backend = api("ggml_backend_free", None, ptr)

registry = plugin_init()
assert registry and device_count(registry), "Vulkan plugin has no devices"
devices = [device_get(registry, i) for i in range(device_count(registry))]
device = next((item for item in devices if device_type(item) == 1), None)
assert device, "A discrete GPU is required"
gpu = init_device(device, None)
assert gpu, "GPU initialization failed"
print("BACKEND", backend_name(gpu).decode(), flush=True)


def tensor(buft, size):
    ctx = init_ctx(InitParams(65536, None, True))
    assert ctx
    value = new_tensor(ctx, 0, size // 4)  # GGML_TYPE_F32
    buffer = alloc_ctx(ctx, buft)
    assert buffer, "buffer allocation failed"
    set_usage(buffer, 1)  # GGML_BACKEND_BUFFER_USAGE_WEIGHTS
    return ctx, value, buffer


try:
    # Small buffers may fit in the device's mapped BAR aperture while the
    # larger probes below cannot. Record aperture usage around allocation.
    for source_mode, source_type in [("CPU", cpu_buft()),
                                     ("Vulkan_Host", host_buft(backend_device(gpu)))]:
        size = 8 * 1024 * 1024
        source = tensor(source_type, size)
        print("SMALL_BUFFER_BEFORE", source_mode, flush=True)
        subprocess.run(["nvidia-smi", "-q", "-d", "MEMORY"], timeout=30, check=False)
        target = tensor(default_buft(gpu), size)
        print("SMALL_BUFFER_ALLOCATED", source_mode, flush=True)
        subprocess.run(["nvidia-smi", "-q", "-d", "MEMORY"], timeout=30, check=False)
        try:
            fill(source[1], 42, 0, size)
            address = data_pointer(source[1])
            assert address
            for chunk_mib in [8, 0.25, 0.0625]:
                chunk = int(chunk_mib * 1024 * 1024)
                for mode in ["synchronous", "queued"]:
                    fill(target[1], 7, 0, size)
                    sync(gpu)
                    start = time.perf_counter()
                    for offset in range(0, size, chunk):
                        if mode == "queued":
                            set_tensor_async(gpu, target[1], address + offset, offset, chunk)
                        else:
                            set_tensor(target[1], address + offset, offset, chunk)
                    sync(gpu)
                    elapsed = round(1000 * (time.perf_counter() - start), 3)
                    for offset in [0, size - 32]:
                        output = c.create_string_buffer(32)
                        read(target[1], output, offset, 32)
                        assert output.raw == bytes([42]) * 32, "small-buffer copy differs"
                    print(json.dumps({"pattern": "small_buffer", "source": source_mode,
                                      "mode": mode, "MiB": 8, "chunk_MiB": chunk_mib,
                                      "milliseconds": elapsed, "bytes_verified": True}), flush=True)
        finally:
            free_buf(target[2])
            free_ctx(target[0])
            free_buf(source[2])
            free_ctx(source[0])
    for mode, source_type in [("CPU", cpu_buft()),
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
    # Real layers stage many tensors into one buffer. Compare that pattern with
    # one large copy, including the backend's queued-transfer path. This only
    # measures the published binary; it does not change the addon or engine.
    size = 192 * 1024 * 1024
    source = tensor(host_buft(backend_device(gpu)), size)
    target = tensor(default_buft(gpu), size)
    try:
        fill(source[1], 42, 0, size)
        address = data_pointer(source[1])
        assert address
        for chunk_mib in [192, 8, 1, 0.25]:
            chunk = int(chunk_mib * 1024 * 1024)
            for mode in ["synchronous", "queued"]:
                fill(target[1], 7, 0, size)
                sync(gpu)
                start = time.perf_counter()
                for offset in range(0, size, chunk):
                    if mode == "queued":
                        set_tensor_async(gpu, target[1], address + offset, offset, chunk)
                    else:
                        set_tensor(target[1], address + offset, offset, chunk)
                sync(gpu)
                elapsed = round(1000 * (time.perf_counter() - start), 3)
                for offset in [0, size - 32]:
                    output = c.create_string_buffer(32)
                    read(target[1], output, offset, 32)
                    assert output.raw == bytes([42]) * 32, "chunked copy differs"
                print(json.dumps({"pattern": "layer_tensor_chunks", "mode": mode,
                                  "MiB": 192, "chunk_MiB": chunk_mib,
                                  "milliseconds": elapsed, "bytes_verified": True}), flush=True)
    finally:
        free_buf(target[2])
        free_ctx(target[0])
        free_buf(source[2])
        free_ctx(source[0])
finally:
    free_backend(gpu)
