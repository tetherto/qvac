import argparse
import json
import platform
from pathlib import Path
import re
import subprocess
import sys
from threading import Event, Thread
import time

from replay import check_artifacts, gpu_rows, processes


DISK_LANE = '# ABot-World: disk residency, KV on matches resident frames across history updates'
FRAME = re.compile(
    r'^\s*(ok|not ok) \d+ - block (\d+), frame (\d+): mean pixel error (\d+\.\d+) <= 1/255'
)


def summarize(log):
    current_lane = ''
    comparisons = 0
    disk_errors = []
    disk_comparisons = 0
    for line in log.splitlines():
        if line.startswith('# '):
            current_lane = line
        frame = FRAME.match(line)
        if frame:
            comparisons += 1
            if current_lane == DISK_LANE:
                disk_comparisons += 1
                status, block, index, error = frame.groups()
                if status == 'not ok':
                    disk_errors.append(dict(block=int(block), frame=int(index), mean=float(error)))
    totals = dict(re.findall(r'^# (tests|asserts) = (\d+/\d+) pass', log, flags=re.MULTILINE))
    return dict(totals=totals, comparisons=comparisons, disk_comparisons=disk_comparisons,
                disk_errors=disk_errors, cuda_lanes=log.count('ABot parity backend: cuda0'),
                failed_tests=re.findall(r'^not ok \d+ - .*$', log, flags=re.MULTILINE))


def host():
    os_release = platform.freedesktop_os_release()
    devices = gpu_rows('gpu', 'index,uuid,name,memory.total,memory.free,driver_version')
    if (os_release.get('ID') != 'ubuntu' or os_release.get('VERSION_ID') != '22.04'
            or platform.machine() != 'x86_64'
            or len(devices) != 1 or 'RTX 4000 SFF Ada' not in devices[0][2]):
        raise RuntimeError(f'Unexpected runner hardware or OS: {os_release.get("PRETTY_NAME")} {devices}')
    return dict(os=os_release.get('PRETTY_NAME'), kernel=platform.release(), gpu=devices[0],
                node=subprocess.check_output(['node', '--version'], text=True).strip(),
                npm=subprocess.check_output(['npm', '--version'], text=True).strip(),
                bare=subprocess.check_output(['bare', '--version'], text=True).strip())


def sample(gpu_id, job_group, output, done):
    with output.open('w', buffering=1, encoding='utf-8') as stream:
        while not done.is_set():
            try:
                fields = 'memory.used,memory.free,utilization.gpu'
                used, free, utilization = gpu_rows('gpu', fields, gpu_id)[0]
                workloads = processes(gpu_id)
                record = dict(used_mib=int(used), free_mib=int(free), utilization=int(utilization),
                              processes=workloads, foreign=[p for p in workloads if p.get('group') != job_group])
            except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
                record = dict(error=str(error))
            stream.write(json.dumps(dict(epoch=time.time(), **record)) + '\n')
            done.wait(2)


def run(package, output):
    output.mkdir(parents=True, exist_ok=True)
    environment = host()
    (output / 'environment.json').write_text(json.dumps(environment, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(environment), flush=True)
    subprocess.run(['npm', 'run', 'test:integration:generate'], cwd=package, check=True)
    path = output / 'test-output.log'
    done = Event()
    with path.open('wb') as log, subprocess.Popen(
        ['npm', 'run', 'test:integration'], cwd=package,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True,
    ) as child:
        thread = Thread(target=sample, args=(environment['gpu'][1], child.pid, output / 'gpu.jsonl', done))
        thread.start()
        try:
            for line in child.stdout:
                log.write(line)
                sys.stdout.buffer.write(line)
                sys.stdout.buffer.flush()
            status = child.wait()
        finally:
            done.set()
            thread.join()
    result = summarize(path.read_text(encoding='utf-8', errors='replace'))
    result['test_exit'] = status
    (output / 'result.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result), flush=True)
    if status:
        return status if status > 0 else 128 - status
    return int(result['comparisons'] != 135 or result['disk_comparisons'] != 45
               or result['cuda_lanes'] != 3 or result['totals'].get('tests') != '98/98')


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='command', required=True)
    verify = commands.add_parser('verify')
    verify.add_argument('package', type=Path)
    replay = commands.add_parser('run')
    replay.add_argument('package', type=Path)
    replay.add_argument('output', type=Path)
    args = parser.parse_args()
    if args.command == 'verify':
        check_artifacts(args.package, 'parity')
        return 0
    return run(args.package, args.output)


if __name__ == '__main__':
    raise SystemExit(main())
