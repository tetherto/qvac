"""Run beside the failing prebuild to compare CUDA runtime environments."""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

backend = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else None
report = {
    'os': platform.freedesktop_os_release(),
    'kernel': platform.release(),
    'libc': platform.libc_ver(),
    'runner': os.environ.get('RUNNER_NAME'),
    'cuda_environment': {key: os.environ[key] for key in [
        'CUDA_VISIBLE_DEVICES', 'CUBLAS_WORKSPACE_CONFIG', 'NVIDIA_TF32_OVERRIDE',
        'GGML_CUDA_DISABLE_FUSION', 'GGML_CUDA_DISABLE_GRAPHS',
        'GGML_DISABLE_CUDA', 'GGML_DISABLE_VULKAN', 'CUDA_PATH', 'CUDACXX',
        'LD_LIBRARY_PATH', 'CUDA_CACHE_PATH'
    ] if key in os.environ},
}
def command(args):
    try:
        result = subprocess.run(args, text=True, capture_output=True, timeout=30)
        return {'exit_code': result.returncode, 'stdout': result.stdout.strip(), 'stderr': result.stderr.strip()}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {'error': str(error)}
report['gpu'] = command(['nvidia-smi', '--query-gpu=name,uuid,driver_version,compute_cap,memory.total', '--format=csv'])
report['gpu_activity'] = command(['nvidia-smi'])
report['host_compiler'] = command(['nvcc', '--version'])
if backend:
    digest = hashlib.sha256()
    with backend.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    report['backend'] = {'path': str(backend), 'sha256': digest.hexdigest()}
    report['linking'] = command(['ldd', str(backend)])
    # The addon supplies ggml symbols when loading the module. Loading it in
    # Python alone would report misleading undefined-symbol errors.
    tool = shutil.which('cuobjdump')
    if not tool and Path('/usr/local/cuda/bin/cuobjdump').exists():
        tool = '/usr/local/cuda/bin/cuobjdump'
    if tool:
        child = subprocess.Popen([tool, '--dump-ptx', str(backend)], stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, text=True)
        metadata = []
        try:
            for line in child.stdout:
                if line.strip().startswith(('.version', '.target')):
                    metadata.append(line.strip())
                    if len(metadata) >= 4:
                        break
        finally:
            child.terminate()
            child.wait(timeout=30)
        report['embedded_ptx_sample'] = metadata
    else:
        report['embedded_ptx_sample'] = 'cuobjdump unavailable; binary is retained in the source run'
report['versions'] = {}
for library, function in [('libcuda.so.1', 'cuDriverGetVersion'), ('libcudart.so.13', 'cudaRuntimeGetVersion')]:
    try:
        module = ctypes.CDLL(library)
        value = ctypes.c_int()
        status = getattr(module, function)(ctypes.byref(value))
        report['versions'][library] = {'status': status, 'version': value.value}
    except OSError as error:
        report['versions'][library] = {'error': str(error)}
try:
    cublas = ctypes.CDLL('libcublas.so.13')
    version = []
    for component in range(3):
        value = ctypes.c_int()
        status = cublas.cublasGetProperty(component, ctypes.byref(value))
        version.append({'status': status, 'value': value.value})
    report['versions']['libcublas.so.13'] = version
except OSError as error:
    report['versions']['libcublas.so.13'] = {'error': str(error)}
report['loaded_cuda_libraries'] = sorted({line.split()[-1] for line in Path('/proc/self/maps').read_text().splitlines()
    if '/libcuda' in line or '/libcublas' in line})
print(json.dumps(report, indent=2))
