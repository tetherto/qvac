"""Run diagnostic C API lanes and preserve reproducible, bounded evidence."""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import signal
import subprocess
import threading
import time

from compare import compare_capture
from compare_trace import compare_traces
from gpu_guard import GpuGuard


def first_uninitialized_read(log):
    marker = '========= Uninitialized __global__ memory read'
    position = log.find(marker)
    if position < 0:
        return None
    preceding = log[:position].splitlines()
    records = [json.loads(line[len('ABOT_MMQ '):]) for line in preceding if line.startswith('ABOT_MMQ ')]
    following = log[position:].splitlines()
    return {'error': following[0],
            'kernel': next((line.strip() for line in following[1:] if line.startswith('=========     at ')), None),
            'operation': records[-1] if records else None,
            'completedSanitizerReport': False}


def wait_for_probe(child, log_path, stop_on_uninitialized=False, timeout=2400, gpu_guard=None):
    deadline = time.monotonic() + timeout
    while True:
        if gpu_guard:
            violation = gpu_guard.violation(child.pid)
            if violation:
                # A foreign client is evidence, never a process we may kill.
                previous_status = child.poll()
                if previous_status is None:
                    try:
                        os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                child.wait()
                return previous_status or 75, {'gpuGuard': violation, 'interruptedRunningChild': previous_status is None}
        try:
            status = child.wait(timeout=min(2, max(0.01, deadline - time.monotonic())))
            if gpu_guard:
                violation = gpu_guard.violation(child.pid)
                if violation:
                    return status or 75, {'gpuGuard': violation, 'interruptedRunningChild': False}
            return status, None
        except subprocess.TimeoutExpired:
            evidence = first_uninitialized_read(log_path.read_text(errors='replace')) if stop_on_uninitialized else None
            if evidence or time.monotonic() >= deadline:
                # Only terminate this diagnostic's process group; retain a
                # detected error as a failure, never as a completed clean run.
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
                return (86 if evidence else 124), evidence


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def retryable_contention(status, evidence):
    report = (evidence or {}).get('gpuGuard', {})
    # Never retry a numerical/native error, unavailable telemetry, admission
    # failure, or a child that had already exited before contention was sampled.
    return (status == 75 and (evidence or {}).get('interruptedRunningChild') is True
            and bool(report.get('foreignProcesses')) and not report.get('error'))


def capture_native(cmd, env, capture, guard, stop_on_uninitialized=False, retry_budget=0):
    """Keep completed repetitions; archive and restart only interrupted processes."""
    retries = 0
    start = time.monotonic()
    while True:
        capture.mkdir()
        evidence = None
        launched = False
        if guard:
            try:
                guard.wait_idle()
                env = dict(env, CUDA_VISIBLE_DEVICES=guard.uuid)
            except RuntimeError as error:
                evidence = {'gpuAdmissionError': str(error)}
        if evidence:
            status = 75
        else:
            with (capture / 'native.log').open('w') as log:
                with subprocess.Popen(cmd, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True) as child:
                    launched = True
                    # Capture mappings of the actual executable, not a dlopen probe.
                    time.sleep(2)
                    maps = Path(f'/proc/{child.pid}/maps')
                    try:
                        (capture / 'process-maps.txt').write_text(maps.read_text())
                    except OSError as error:
                        # Optional evidence may be restricted or the child may
                        # already have exited. Still monitor/reap our process.
                        (capture / 'process-maps-error.txt').write_text(str(error) + '\n')
                    status, evidence = wait_for_probe(child, capture / 'native.log', stop_on_uninitialized, gpu_guard=guard)
        retry = retries < retry_budget and retryable_contention(status, evidence)
        destination = capture.with_name(f'{capture.name}-interrupted-{retries + 1}') if retry else capture
        if retry:
            capture.rename(destination)
        attempt = {'repeat': capture.name, 'attempt': retries + 1, 'exitCode': status,
                   'launched': launched, 'capture': destination.name, 'retry': retry, 'evidence': evidence}
        (destination / 'attempt.json').write_text(json.dumps(attempt, indent=2) + '\n')
        with (capture.parent / 'attempts.jsonl').open('a') as ledger:
            ledger.write(json.dumps(attempt) + '\n')
        if not retry:
            return status, evidence, round(time.monotonic() - start, 3), retries
        retries += 1
        print(f'GPU contention interrupted {capture.name}; retained {destination.name}. '
              f'Waiting for idle GPU before restarting this repetition ({retries}/{retry_budget} retries used).', flush=True)


def sample_gpu(stop, output):
    with output.open('w') as f:
        while not stop.is_set():
            try:
                p = subprocess.run(['nvidia-smi', '--query-gpu=timestamp,index,uuid,memory.used,utilization.gpu', '--format=csv,noheader'], capture_output=True, text=True, timeout=10)
                f.write(p.stdout or p.stderr)
                f.flush()
            except (OSError, subprocess.TimeoutExpired) as error:
                f.write(str(error) + '\n')
            stop.wait(2)


def execute(args):
    args.output.mkdir(parents=True, exist_ok=True)
    inputs = json.loads(args.inputs.read_text())
    metadata = {'probe': args.probe, 'gpuGuardEnabled': args.gpu_guard,
                'requestedRepetitions': args.repeats, 'contentionRetryBudget': args.gpu_contention_retries,
                'cli': {'path': str(args.cli), 'sha256': digest(args.cli)},
                'cpuModuleSha256': digest(args.cpu_module), 'cudaModuleSha256': digest(args.cuda_module),
                'inputs': {key: {'path': value, 'sha256': digest(value)} for key, value in inputs.items()},
                'environment': {key: os.environ.get(key) for key in ('CUDA_VISIBLE_DEVICES', 'GGML_CUDA_DISABLE_GRAPHS', 'GGML_CUDA_DISABLE_FUSION')}}
    (args.output / 'provenance.json').write_text(json.dumps(metadata, indent=2) + '\n')
    env = dict(os.environ, SD_ABOT_DIAGNOSTIC_CUDA_MODULE=str(args.cuda_module), SD_ABOT_DIAGNOSTIC_CPU_MODULE=str(args.cpu_module))
    if args.probe == 'sync':
        env['SD_ABOT_DIAGNOSTIC_SYNC'] = '1'
    if args.probe == 'no-graphs':
        env['GGML_CUDA_DISABLE_GRAPHS'] = '1'
    if args.probe == 'no-fusion':
        env['GGML_CUDA_DISABLE_FUSION'] = '1'
    if args.probe == 'node':
        if not args.node_filter:
            raise ValueError('Node capture requires an explicit tensor-name filter')
        env['SD_ABOT_DIAGNOSTIC_NODE'] = args.node_filter
    if args.probe == 'trace-repeat':
        env['SD_ABOT_DIAGNOSTIC_TRACE'] = '1'
        env['SD_ABOT_TRACE_DUMP'] = args.node_filter
    prefix = []
    if args.probe == 'mmq-initcheck':
        env['SD_ABOT_DIAGNOSTIC_MMQ'] = '1'
    if args.probe in ('memcheck', 'initcheck', 'mmq-initcheck'):
        tool = shutil.which('compute-sanitizer')
        if not tool:
            raise RuntimeError('Requested compute-sanitizer is unavailable on this runner')
        sanitizer = 'initcheck' if args.probe == 'mmq-initcheck' else args.probe
        prefix = [tool, '--tool', sanitizer, '--launch-timeout', '0', '--kill', '--error-exitcode', '86']
        if args.probe == 'mmq-initcheck':
            prefix += ['--print-limit', '8']
    if args.probe == 'nsys':
        tool = shutil.which('nsys')
        if not tool:
            raise RuntimeError('Requested Nsight Systems is unavailable on this runner')
        prefix = [tool, 'profile', '--trace=cuda,nvtx', '--sample=none', '--output', str(args.output / 'cuda-trace')]
    results = []
    remaining_retries = args.gpu_contention_retries
    guard = GpuGuard(args.output / 'gpu-processes.jsonl', os.environ.get('CUDA_VISIBLE_DEVICES', '0')) if args.gpu_guard else None
    stop = threading.Event()
    sampler = threading.Thread(target=sample_gpu, args=(stop, args.output / 'gpu-activity.csv'), daemon=True)
    sampler.start()
    try:
        for repeat in range(args.repeats):
            capture = args.output / f'repeat-{repeat + 1}'
            blocks = 1 if args.probe in ('memcheck', 'initcheck', 'mmq-initcheck', 'nsys', 'node', 'repeat', 'trace-repeat') else 4
            actions = 'idle:1' if blocks == 1 else 'idle:1,W:1,WL:1,S:1'
            cmd = [*prefix, str(args.cli), '--mode', 'diagnostic-parity', '--backend', 'cuda0',
                   '--dit', inputs['model'], '--taehv', inputs['taehv'], '--scene', inputs['scene'],
                   '--seed', '42', '--threads', '8', '--actions', actions, '--outdir', str(capture)]
            status, evidence, seconds, retries = capture_native(
                cmd, env, capture, guard, args.probe == 'mmq-initcheck', remaining_retries)
            remaining_retries -= retries
            row = {'repeat': repeat + 1, 'exitCode': status, 'seconds': seconds,
                   'contentionRetries': retries, 'remainingContentionRetries': remaining_retries}
            if evidence and 'gpuAdmissionError' in evidence:
                row.update(launched=False, gpuGuardError=evidence['gpuAdmissionError'])
                evidence = None
            if evidence and 'gpuGuard' in evidence:
                row['gpuGuardFailure'] = evidence['gpuGuard']
                evidence = None
            if args.probe == 'mmq-initcheck':
                evidence = evidence or (first_uninitialized_read((capture / 'native.log').read_text(errors='replace')) if (capture / 'native.log').exists() else None)
                row['firstUninitializedRead'] = evidence
                (capture / 'first-uninitialized-read.json').write_text(json.dumps(evidence, indent=2) + '\n')
                if evidence and status == 0:
                    status = row['exitCode'] = 86
            if status == 0:
                native_log = (capture / 'native.log').read_text(errors='replace')
                if args.probe in ('memcheck', 'initcheck', 'mmq-initcheck') and (
                    'ERROR SUMMARY: 0 errors' not in native_log or
                    re.search(r'========= (Error:|Internal Sanitizer Error)', native_log)
                ):
                    raise RuntimeError('Sanitizer did not produce a clean completed report; capture retained')
                if not all(marker in native_log for marker in ('runtime=CUDA0, params=CUDA0', 'runtime=CUDA0, params=CPU', 'runtime=CUDA0, params=disk')):
                    raise RuntimeError('Missing explicit CUDA/residency evidence')
                if args.probe == 'node' and not all(list((capture / lane).glob('*-node.f32')) for lane in {x for pair in [('resident-no-kv', 'stream-no-kv'), ('resident-kv', 'stream-kv'), ('resident-kv', 'disk-kv')] for x in pair}):
                    raise RuntimeError('Node probe did not capture the requested activation in every lane')
                comparisons = compare_capture(capture, blocks)
                row['comparisons'] = comparisons
                if args.probe in ('repeat', 'trace-repeat'):
                    cross = compare_capture(capture, blocks, args.output / 'repeat-1') if repeat else []
                    row['crossProcessComparisons'] = cross
                    row['tensorDivergence'] = any(pair['firstDifference'] for pair in comparisons + cross)
                    (capture / 'cross-process-comparisons.json').write_text(json.dumps(cross, indent=2, allow_nan=False) + '\n')
                if args.probe == 'trace-repeat':
                    traces = {'withinProcess': compare_traces(capture),
                              'crossProcess': compare_traces(capture, args.output / 'repeat-1') if repeat else []}
                    row['operationDivergence'] = any(pair['firstDifference'] for group in traces.values() for pair in group)
                    row['traceStructureChanged'] = any(not pair['comparable'] for pair in traces['crossProcess'])
                    row['tensorDivergence'] = row['tensorDivergence'] or row['operationDivergence'] or row['traceStructureChanged']
                    (capture / 'trace-comparisons.json').write_text(json.dumps(traces, indent=2) + '\n')
                png = subprocess.run(['node', str(Path(__file__).with_name('compare-png.mjs')), str(capture), str(args.guards), str(9 if blocks == 1 else 45)], capture_output=True, text=True, timeout=120)
                (capture / 'png-comparisons.json').write_text(png.stdout)
                if png.stderr:
                    (capture / 'png-comparisons.stderr.log').write_text(png.stderr)
                row['pixelParityExitCode'] = png.returncode
                (capture / 'tensor-comparisons.json').write_text(json.dumps(comparisons, indent=2, allow_nan=False) + '\n')
                # Keep the first differing tensor pair for each lane; summaries
                # retain metrics/hashes for every tensor, without multi-GB artifacts.
                keep = set()
                for pair in comparisons:
                    if pair['firstDifference']:
                        for lane in (pair['baseline'], pair['candidate']):
                            keep.add(capture / lane / pair['firstDifference']['file'])
                # Keep the first process as a reference until the search ends.
                # On divergence retain both complete captures for attribution;
                # this reference is a repeatability check, not a golden oracle.
                retain = args.probe in ('repeat', 'trace-repeat') and (repeat == 0 or row['tensorDivergence'] or png.returncode)
                if not retain:
                    for raw in capture.rglob('*.f32'):
                        if raw not in keep and not raw.name.endswith('-node.f32'):
                            raw.unlink()
            results.append(row)
            (args.output / 'results.json').write_text(json.dumps(results, indent=2, allow_nan=False) + '\n')
            print(json.dumps({key: value for key, value in row.items() if key not in ('comparisons', 'crossProcessComparisons')}), flush=True)
            if status or row.get('pixelParityExitCode', 0) or row.get('tensorDivergence'):
                raise RuntimeError(f'Native diagnostic stopped: exit={status}, pixelParityExit={row.get("pixelParityExitCode")}, tensorDivergence={row.get("tensorDivergence")}; capture retained')
        if args.probe in ('repeat', 'trace-repeat'):
            for raw in (args.output / 'repeat-1').rglob('*.f32'):
                raw.unlink()
        print(json.dumps({'completedRepetitions': len(results),
                          'interruptedAttempts': args.gpu_contention_retries - remaining_retries,
                          'exclusiveGpuReservation': False}), flush=True)
    finally:
        stop.set()
        sampler.join(timeout=12)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ('cli', 'inputs', 'cuda-module', 'cpu-module', 'output', 'guards'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--probe', choices=['baseline', 'sync', 'no-graphs', 'no-fusion', 'memcheck', 'initcheck', 'mmq-initcheck', 'nsys', 'node', 'repeat', 'trace-repeat'], default='baseline')
    parser.add_argument('--node-filter', default='')
    parser.add_argument('--repeats', type=int, default=2)
    parser.add_argument('--gpu-guard', action='store_true', help='Wait for an idle GPU and fail on observed competing compute clients; not an exclusive reservation')
    parser.add_argument('--gpu-contention-retries', type=int, default=0, help='Extra attempts across the entire batch, only for live processes interrupted by observed contention')
    args = parser.parse_args()
    limit = 10 if args.probe in ('repeat', 'trace-repeat') else 3
    if not 1 <= args.repeats <= limit:
        parser.error(f'Repeats must be between 1 and {limit}')
    if not 0 <= args.gpu_contention_retries <= 3 or (args.gpu_contention_retries and not args.gpu_guard):
        parser.error('Contention retries must be 0–3 and require --gpu-guard')
    execute(args)
