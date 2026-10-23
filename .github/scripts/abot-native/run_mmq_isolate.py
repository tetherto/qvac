"""Test whether MMQ scratch-tail bytes influence valid synthetic outputs."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time

from compare import compare_files
from run import digest, wait_for_probe


def classify_read(log):
    records = [json.loads(line[len('MMQ_SCRATCH '):]) for line in log.splitlines() if line.startswith('MMQ_SCRATCH ')]
    address = re.search(r'=========     Address (0x[0-9a-fA-F]+)', log)
    if not records or not address:
        return None
    allocation = records[-1]
    value = int(address[1], 16)
    base, tail = int(allocation['base'], 16), int(allocation['tail'], 16)
    return {**allocation, 'readAddress': address[1], 'offsetFromTail': value - tail,
            'insidePadding': tail <= value < base + allocation['allocatedBytes']}


def execute(args):
    args.output.mkdir(parents=True, exist_ok=True)
    summary = {'scope': 'Synthetic Q8_0 MUL_MAT, K=14336 M=3072; not a full-model correctness verdict',
               'sha256': {name: digest(getattr(args, name)) for name in ('cli', 'original', 'rebuilt')},
               'comparisons': [], 'sanitizers': []}
    summary_path = args.output / 'summary.json'
    def save():
        summary_path.write_text(json.dumps(summary, indent=2, allow_nan=False) + '\n')
    save()
    clean_env = {k: v for k, v in os.environ.items() if not k.startswith('QVAC_MMQ_')}

    def run(name, n, seed, module, tail=None, poison=False, tool=None):
        env = dict(clean_env, QVAC_MMQ_TRACE='1')
        if tail is not None:
            env['QVAC_MMQ_TAIL_PATTERN'] = str(tail)
        if poison:
            env['QVAC_MMQ_POISON_VALID'] = '1'
        raw, log_path = args.output / (name + '.f32'), args.output / (name + '.log')
        command = [str(args.cli), str(module), str(raw), str(n), str(seed)]
        if tool:
            sanitizer = shutil.which('compute-sanitizer')
            if not sanitizer:
                raise RuntimeError('compute-sanitizer unavailable')
            command = [sanitizer, '--tool', tool, '--launch-timeout', '0', '--kill', '--error-exitcode', '86', '--print-limit', '8', *command]
        start = time.monotonic()
        with log_path.open('w') as log:
            with subprocess.Popen(command, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True) as child:
                status, _ = wait_for_probe(child, log_path, timeout=300)
        text = log_path.read_text(errors='replace')
        row = {'name': name, 'status': status, 'seconds': round(time.monotonic() - start, 3),
               'tool': tool, 'n': n, 'seed': seed, 'tail': tail, 'poisonValid': poison}
        if tool:
            counts = re.findall(r'ERROR SUMMARY: ([0-9,]+) error', text)
            row.update({'errors': int(counts[-1].replace(',', '')) if counts else None,
                        'uninitializedReads': text.count('Uninitialized __global__ memory read'),
                        'readAllocation': classify_read(text)})
        if status not in ((0, 86) if tool else (0,)) or not raw.exists():
            summary['failure'] = row
            save()
            raise RuntimeError(f'Isolated operation failed: {row}')
        if tool and (row['errors'] is None or 'Internal Sanitizer Error' in text):
            summary['failure'] = row
            save()
            raise RuntimeError('Incomplete sanitizer verdict')
        return raw, row

    for n, seed in ((1616, 42), (1616, 43), (1600, 42), (1664, 42)):
        prefix = f'n{n}-seed{seed}'
        original, _ = run(prefix + '-original', n, seed, args.original)
        baseline, _ = run(prefix + '-rebuilt', n, seed, args.rebuilt)
        comparisons = {'n': n, 'seed': seed, 'originalVsRebuilt': compare_files(original, baseline), 'tailPatterns': []}
        paths = [original, baseline]
        for pattern in (0, 165, 255):
            raw, _ = run(prefix + f'-tail{pattern}', n, seed, args.rebuilt, tail=pattern)
            comparisons['tailPatterns'].append({'pattern': pattern, **compare_files(baseline, raw)})
            paths.append(raw)
        poisoned, _ = run(prefix + '-positive-control', n, seed, args.rebuilt, tail=0, poison=True)
        comparisons['positiveControl'] = compare_files(baseline, poisoned)
        comparisons['tailInvariant'] = all(r['maxAbs'] == 0 for r in comparisons['tailPatterns'])
        comparisons['positiveControlDetected'] = comparisons['positiveControl']['maxAbs'] > 0
        summary['comparisons'].append(comparisons)
        save()
        print(json.dumps({'n': n, 'seed': seed, 'tailInvariant': comparisons['tailInvariant'],
                          'positiveControlDetected': comparisons['positiveControlDetected']}), flush=True)
        # Retain raw evidence if padding changes valid results or module builds differ.
        if comparisons['tailInvariant'] and comparisons['originalVsRebuilt']['maxAbs'] == 0 and comparisons['positiveControlDetected']:
            for path in paths + [poisoned]:
                path.unlink()

    for name, module, pattern, tool in (
        ('original-initcheck', args.original, None, 'initcheck'),
        ('rebuilt-initcheck', args.rebuilt, None, 'initcheck'),
        ('zero-tail-initcheck', args.rebuilt, 0, 'initcheck'),
        ('zero-tail-memcheck', args.rebuilt, 0, 'memcheck'),
    ):
        _, row = run(name, 1616, 42, module, tail=pattern, tool=tool)
        summary['sanitizers'].append(row)
        save()
    summary['paddingOnlyInTestedCases'] = all(r['tailInvariant'] and r['positiveControlDetected'] for r in summary['comparisons'])
    summary['originalVsRebuiltExact'] = all(r['originalVsRebuilt']['maxAbs'] == 0 for r in summary['comparisons'])
    summary['zeroTailSanitizersClean'] = all(r['status'] == 0 and r['errors'] == 0 for r in summary['sanitizers'] if r['tail'] == 0)
    summary['uninitializedReadReproduced'] = all(r['uninitializedReads'] > 0 and r['status'] == 86 for r in summary['sanitizers'] if r['tail'] is None)
    save()
    if not (summary['zeroTailSanitizersClean'] and summary['uninitializedReadReproduced'] and summary['paddingOnlyInTestedCases'] and summary['originalVsRebuiltExact']):
        raise RuntimeError('MMQ isolation needs investigation; see summary.json and retained outputs')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ('cli', 'original', 'rebuilt', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    execute(parser.parse_args())
