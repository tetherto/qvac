"""Detect competing compute clients; this is sampling, not a GPU reservation."""
import csv
import io
import json
import os
from pathlib import Path
import subprocess
import time


def query(fields, kind, device):
    result = subprocess.run(
        ['nvidia-smi', '-i', device, '--query-' + kind + '=' + fields,
         '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=10)
    if result.returncode:
        raise RuntimeError('nvidia-smi query failed: ' + result.stderr.strip())
    return list(csv.reader(io.StringIO(result.stdout), skipinitialspace=True))


def process_details(pid):
    # Avoid command lines/environments, which can contain credentials. Preserve
    # process ancestry and cgroups for attribution even when /proc is restricted.
    result = {'pid': pid}
    try:
        result['processGroup'] = os.getpgid(pid)
        status = Path(f'/proc/{pid}/status').read_text()
        fields = dict(line.split(':', 1) for line in status.splitlines() if ':' in line)
        result.update(name=fields['Name'].strip(), parentPid=int(fields['PPid']),
                      namespacePids=fields.get('NSpid', '').split())
        result['cgroup'] = Path(f'/proc/{pid}/cgroup').read_text().strip()
    except (OSError, ValueError, KeyError) as error:
        result['procError'] = str(error)
    return result


def classify_processes(rows, uuid, process_group=None):
    processes = []
    for row in rows:
        if len(row) != 4:
            raise ValueError('Malformed compute-process query')
        gpu, pid, name, memory = (part.strip() for part in row)
        if gpu != uuid:
            continue
        details = process_details(int(pid))
        details.update(gpuUuid=gpu, executable=name, memoryMiB=memory,
                       owned=process_group is not None and details.get('processGroup') == process_group)
        processes.append(details)
    return processes


class GpuGuard:
    def __init__(self, output, device='0'):
        if not device or ',' in device:
            raise ValueError('GPU guard requires one CUDA_VISIBLE_DEVICES selector')
        self.output = output
        self.device = device
        self.uuid = None

    def sample(self, phase, process_group=None):
        row = {'time': time.time(), 'phase': phase}
        try:
            gpu = query('uuid,memory.total,memory.free,utilization.gpu', 'gpu', self.device)
            if len(gpu) != 1 or len(gpu[0]) != 4:
                raise ValueError('Expected one GPU with complete memory/utilization telemetry')
            uuid, total, free, utilization = (part.strip() for part in gpu[0])
            if not uuid.startswith('GPU-') or (self.uuid and uuid != self.uuid):
                raise ValueError('GPU identity is missing or changed')
            self.uuid = uuid
            # Pin subsequent queries (and the child CUDA environment) to this GPU.
            self.device = uuid
            row.update(gpuUuid=uuid, totalMiB=int(total), freeMiB=int(free), utilization=int(utilization))
            row['processes'] = classify_processes(
                query('gpu_uuid,pid,process_name,used_gpu_memory', 'compute-apps', uuid), uuid, process_group)
            row['foreignProcesses'] = [p for p in row['processes'] if not p['owned']]
        except (OSError, subprocess.TimeoutExpired, RuntimeError, ValueError) as error:
            row['error'] = str(error)
        with self.output.open('a') as stream:
            stream.write(json.dumps(row) + '\n')
        return row

    def wait_idle(self, timeout=900, stable_seconds=10):
        deadline = time.monotonic() + timeout
        idle_since = None
        print('Waiting for an idle GPU (no compute clients, >=90% memory free, <=5% utilization)', flush=True)
        while True:
            row = self.sample('admission')
            if 'error' in row:
                raise RuntimeError('GPU guard telemetry unavailable; see gpu-processes.jsonl')
            now = time.monotonic()
            idle = (not row['foreignProcesses'] and row['freeMiB'] >= 0.9 * row['totalMiB']
                    and row['utilization'] <= 5)
            idle_since = (now if idle_since is None else idle_since) if idle else None
            if idle_since is not None and now - idle_since >= stable_seconds:
                print('GPU admission passed; continuing process monitoring on ' + self.uuid, flush=True)
                return
            if now >= deadline:
                raise RuntimeError('GPU remained busy; no native process launched. See gpu-processes.jsonl')
            time.sleep(min(2, max(0, deadline - now)))

    def violation(self, process_group):
        row = self.sample('running', process_group)
        return row if row.get('error') or row.get('foreignProcesses') else None
