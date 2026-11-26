import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time


ARTIFACTS = {
    'incident': '52370ff0f314edfbbc0ef1f6a7ae46186582fbdb94a5591d246f75fed4261db0',
    'parity': '3a1c7b31aa30b521d7c72d0c3335677a96c70b42274a554853738afb4af9b3c4',
}
BACKENDS = {
    'libqvac-diffusion-ggml-cuda.so': '2a26e15e4e009a9591a29e3f0d4db6bf5221f56ea1136d3759082eaf5831e139',
    'libqvac-diffusion-ggml-vulkan.so': '1e1e53ce0d1a8a14c814dca3a4e57557b0f117ef9e16c1259e909bee5b39d349',
}
TEST = 'test/integration/abot-world.test.js'
OBSERVED_TEST = 'test/integration/abot-observed.test.js'


def check_artifacts(package, scenario):
    platform = package / 'prebuilds/linux-x64'
    name = 'qvac__diffusion-cpp-linux-x64'
    files = {platform / f'{name}.bare': ARTIFACTS[scenario]}
    files.update({platform / name / backend: expected for backend, expected in BACKENDS.items()})
    for file, expected in files.items():
        digest = hashlib.sha256()
        with file.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(block)
        actual = digest.hexdigest()
        if actual != expected:
            raise RuntimeError(f'Unexpected artifact hash {actual} for {file.name}')
        print(actual, file.name, flush=True)


def instrument(source):
    def replace_once(old, new):
        nonlocal source
        if source.count(old) != 1:
            raise ValueError(f'Historical source changed at {old!r}')
        source = source.replace(old, new)

    replace_once("const fs = require('bare-fs')", "const fs = require('bare-fs')\nconst { createHash } = require('bare-crypto')")
    replace_once('config: { seed: 42, kvCache: true },', 'config: { seed: 42, kvCache: true, verbosity: 3, profile: true },')
    replace_once('          return blocks\n', '''          console.log('QVAC-28085 FRAMES', JSON.stringify({
            lane: lane.name,
            config,
            hashes: blocks.map((frames) => frames.map((frame) => createHash('sha256').update(frame).digest('hex')))
          }))
          return blocks
''')
    return source


def gpu_rows(query, fields, gpu_id=None):
    args = ['nvidia-smi', f'--query-{query}={fields}', '--format=csv,noheader,nounits']
    if gpu_id is not None:
        args.append(f'--id={gpu_id}')
    output = subprocess.check_output(args, text=True, timeout=15)
    return list(csv.reader(output.splitlines(), skipinitialspace=True))


def processes(gpu_id):
    rows = gpu_rows('compute-apps', 'pid,process_name,used_gpu_memory,gpu_uuid', gpu_id)
    result = []
    for pid, name, used, device in rows:
        if device != gpu_id or not pid.isdigit():
            raise RuntimeError(f'Unexpected GPU process record {device} {pid}')
        item = dict(pid=int(pid), name=Path(name).name, used_mib=used)
        try:
            item.update(cgroup=Path(f'/proc/{pid}/cgroup').read_text().strip(), group=os.getpgid(int(pid)))
        except OSError:
            pass
        result.append(item)
    return result


def wait_for_idle(gpu_id, output):
    deadline = time.monotonic() + 900
    while time.monotonic() < deadline:
        _, _, _, total, free, utilization, _ = gpu_rows(
            'gpu', 'index,uuid,name,memory.total,memory.free,utilization.gpu,driver_version', gpu_id)[0]
        running = processes(gpu_id)
        output.write(json.dumps(dict(epoch=time.time(), phase='admission', processes=running,
                                     free_mib=int(free), utilization=int(utilization))) + '\n')
        if not running and int(free) >= 0.9 * int(total) and int(utilization) <= 5:
            return
        time.sleep(15)
    raise TimeoutError('RTX 4000 SFF GPU did not become idle within 15 minutes')


def summarize(log, exit_code):
    content = log.read_text(encoding='utf-8', errors='replace')
    taps = dict(re.findall(r'^# (tests|asserts) = (\d+/\d+) pass', content, flags=re.MULTILINE))
    means = [float(value) for value in re.findall(r'mean pixel error (\d+(?:\.\d+)?) <= 1/255', content)]
    failure_lines = [line for line in content.splitlines() if re.search(
        r'^\s*not ok|failed during weight preparation|kv initial capture failed|kv append pass failed|'
        r'cannot make enough memory|cudaMalloc failed', line)]
    walked = '# ABot-World: full world generation' in content
    return dict(exit=exit_code, taps=taps, pixel_comparisons=len(means),
                max_pixel_error=max(means, default=None), reached_full_world=walked,
                failures=failure_lines[:42])


def run(package, bare, output, name, entry, gpu_id, backend):
    env = {**os.environ, 'CI': 'true', 'NO_GPU': 'false', 'ABOT_PARITY_BACKEND': backend,
           'CUDA_VISIBLE_DEVICES': gpu_id}
    env.pop('ABOT_MODELS_DIR', None)
    env.pop('GGML_DISABLE_VULKAN', None)
    if backend == 'vulkan0':
        env['GGML_DISABLE_CUDA'] = '1'
        env['GGML_VK_VISIBLE_DEVICES'] = '0'
    else:
        env.pop('GGML_DISABLE_CUDA', None)
    log_path = output / f'{name}.log'
    print(f'Starting {name} on {gpu_id}', flush=True)
    with log_path.open('wb') as log, (output / f'{name}-gpu.jsonl').open('w', buffering=1) as telemetry:
        wait_for_idle(gpu_id, telemetry)
        child = subprocess.Popen([str(bare), entry, '--exit'], env=env, cwd=package, stdout=log,
                                 stderr=subprocess.STDOUT, start_new_session=True)
        deadline = time.monotonic() + 2400
        try:
            while child.poll() is None:
                used, free, utilization = gpu_rows('gpu', 'memory.used,memory.free,utilization.gpu', gpu_id)[0]
                running = processes(gpu_id)
                telemetry.write(json.dumps(dict(epoch=time.time(), used_mib=int(used), free_mib=int(free),
                                                utilization=int(utilization), processes=running,
                                                foreign=[p for p in running if p.get('group') != child.pid])) + '\n')
                if time.monotonic() > deadline:
                    raise TimeoutError(f'{name} reached the 40-minute diagnostic deadline')
                try:
                    child.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    pass
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
    result = summarize(log_path, child.returncode)
    (output / f'{name}-result.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(dict(case=name, **result)), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('scenario', choices=ARTIFACTS)
    parser.add_argument('package', type=Path)
    parser.add_argument('bare', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    package, bare, output = args.package.resolve(), args.bare.resolve(), args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    check_artifacts(package, args.scenario)
    devices = gpu_rows('gpu', 'index,uuid,name,memory.total,memory.free,utilization.gpu,driver_version')
    if len(devices) != 1 or 'RTX 4000 SFF Ada' not in devices[0][2]:
        raise RuntimeError(f'Expected one RTX 4000 SFF Ada device, got {devices}')
    (output / 'gpu-environment.json').write_text(json.dumps(devices) + '\n', encoding='utf-8')
    gpu_id = devices[0][1]
    (package / OBSERVED_TEST).write_text(instrument((package / TEST).read_text(encoding='utf-8')), encoding='utf-8')
    results = [run(package, bare, output, 'original-cuda', TEST, gpu_id, 'cuda0'),
               run(package, bare, output, 'instrumented-cuda', OBSERVED_TEST, gpu_id, 'cuda0')]
    if args.scenario == 'parity':
        results.append(run(package, bare, output, 'instrumented-vulkan', OBSERVED_TEST, gpu_id, 'vulkan0'))
    return int(any(item['exit'] or not item['reached_full_world'] or item['pixel_comparisons'] != 135
                   for item in results))


if __name__ == '__main__':
    raise SystemExit(main())
