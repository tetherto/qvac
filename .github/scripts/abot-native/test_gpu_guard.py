import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from gpu_guard import GpuGuard, classify_processes
from run import wait_for_probe, capture_native, retryable_contention


class GpuGuardTest(unittest.TestCase):
    def test_retry_policy_never_retries_real_failures_or_missing_telemetry(self):
        evidence = {'gpuGuard': {'foreignProcesses': [{'pid': 42}]}, 'interruptedRunningChild': True}
        self.assertTrue(retryable_contention(75, evidence))
        for status in (0, 1, 86, 124):
            self.assertFalse(retryable_contention(status, evidence))
        self.assertFalse(retryable_contention(75, None))
        self.assertFalse(retryable_contention(75, dict(evidence, interruptedRunningChild=False)))
        self.assertFalse(retryable_contention(75, dict(evidence, gpuGuard={'error': 'unavailable'})))

    def test_existing_native_failure_is_not_reclassified_as_contention(self):
        with subprocess.Popen([sys.executable, '-c', 'raise SystemExit(7)'], start_new_session=True) as child:
            child.wait()
            with patch.object(GpuGuard, 'violation', return_value={'foreignProcesses': [{'pid': 42}]}):
                status, evidence = wait_for_probe(child, Path('/unused'), gpu_guard=GpuGuard(Path('/unused')))
        self.assertEqual(status, 7)
        self.assertFalse(retryable_contention(status, evidence))

    def test_contention_retry_preserves_interrupted_capture_and_fresh_success(self):
        class Guard:
            uuid = 'GPU-test'
            attempts = 0
            def wait_idle(self):
                self.attempts += 1
            def violation(self, pid):
                return {'foreignProcesses': [{'pid': 42}]} if self.attempts == 1 else None
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            counter = root / 'starts'
            code = ('from pathlib import Path; import time; '
                    f'p=Path({str(counter)!r}); n=int(p.read_text())+1 if p.exists() else 1; '
                    'p.write_text(str(n)); print(n,flush=True); time.sleep(30 if n==1 else 0)')
            status, evidence, seconds, retries = capture_native(
                [sys.executable, '-c', code], dict(os.environ), root / 'repeat-1', Guard(), retry_budget=3)
            self.assertEqual((status, evidence, retries), (0, None, 1))
            self.assertEqual(counter.read_text(), '2')
            self.assertEqual((root / 'repeat-1-interrupted-1/native.log').read_text().strip(), '1')
            self.assertEqual((root / 'repeat-1/native.log').read_text().strip(), '2')
            ledger = [json.loads(line) for line in (root / 'attempts.jsonl').read_text().splitlines()]
            self.assertEqual([row['exitCode'] for row in ledger], [75, 0])
            self.assertEqual([row['retry'] for row in ledger], [True, False])

    def test_contention_retries_exhaust_and_keep_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            guard = GpuGuard(root / 'unused')
            with patch.object(guard, 'wait_idle'), patch.object(guard, 'uuid', 'GPU-test'), patch.object(
                    guard, 'violation', return_value={'foreignProcesses': [{'pid': 42}]}):
                status, evidence, seconds, retries = capture_native(
                    [sys.executable, '-c', 'import time; time.sleep(30)'], dict(os.environ),
                    root / 'repeat-1', guard, retry_budget=1)
            self.assertEqual((status, retries), (75, 1))
            ledger = [json.loads(line) for line in (root / 'attempts.jsonl').read_text().splitlines()]
            self.assertEqual(len(ledger), 2)
            self.assertFalse(ledger[-1]['retry'])

    def test_admission_failure_launches_nothing_and_does_not_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            guard = GpuGuard(root / 'unused')
            with patch.object(guard, 'wait_idle', side_effect=RuntimeError('busy')), patch('run.subprocess.Popen') as launch:
                status, evidence, seconds, retries = capture_native(
                    ['unused'], {}, root / 'repeat-1', guard, retry_budget=3)
            launch.assert_not_called()
            self.assertEqual((status, retries), (75, 0))
            self.assertEqual(evidence, {'gpuAdmissionError': 'busy'})
            self.assertFalse(json.loads((root / 'repeat-1/attempt.json').read_text())['launched'])

    def test_only_our_process_group_is_owned(self):
        rows = [['GPU-test', str(os.getpid()), 'python', '100'],
                ['GPU-test', '2147483647', 'unknown', '500'],
                ['GPU-other', '42', 'other-gpu', '1000']]
        processes = classify_processes(rows, 'GPU-test', os.getpgrp())
        self.assertEqual(len(processes), 2)
        self.assertTrue(processes[0]['owned'])
        self.assertFalse(processes[1]['owned'])
        self.assertIn('procError', processes[1])
        with self.assertRaises(ValueError):
            classify_processes([['malformed']], 'GPU-test')

    def test_contention_stops_only_our_child_and_saves_foreign_process(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            guard = GpuGuard(root / 'gpu-processes.jsonl')
            command = [sys.executable, '-c', 'import time; time.sleep(30)']
            with subprocess.Popen(command, start_new_session=True) as foreign:
                try:
                    with subprocess.Popen(command, start_new_session=True) as own:
                        def query(fields, kind, device):
                            if kind == 'gpu':
                                return [['GPU-test', '20000', '5000', '100']]
                            return [['GPU-test', str(own.pid), 'diagnostic', '1000'],
                                    ['GPU-test', str(foreign.pid), 'bare', '13500']]
                        with patch('gpu_guard.query', side_effect=query):
                            status, evidence = wait_for_probe(own, root / 'native.log', gpu_guard=guard)
                        self.assertEqual(status, 75)
                        self.assertIsNotNone(own.poll())
                        self.assertIsNone(foreign.poll())
                        self.assertEqual([p['pid'] for p in evidence['gpuGuard']['foreignProcesses']], [foreign.pid])
                        saved = json.loads(guard.output.read_text())
                        self.assertEqual(saved['foreignProcesses'][0]['memoryMiB'], '13500')
                finally:
                    os.killpg(foreign.pid, signal.SIGKILL)
                    foreign.wait()

    def test_admission_waits_until_idle_and_pins_uuid(self):
        with tempfile.TemporaryDirectory() as tmp:
            guard = GpuGuard(Path(tmp) / 'gpu-processes.jsonl')
            guard.uuid = 'GPU-test'
            busy = {'foreignProcesses': [{'pid': 1}], 'freeMiB': 19000, 'totalMiB': 20000, 'utilization': 0}
            idle = dict(busy, foreignProcesses=[])
            with patch.object(guard, 'sample', side_effect=[busy, idle]) as sample, patch('gpu_guard.time.sleep'):
                guard.wait_idle(stable_seconds=0)
            self.assertEqual(sample.call_count, 2)
            with patch.object(guard, 'sample', return_value=busy):
                with self.assertRaisesRegex(RuntimeError, 'remained busy'):
                    guard.wait_idle(timeout=0)
            with patch('gpu_guard.query', side_effect=[[['GPU-test', '20000', '19500', '0']], []]) as query:
                guard.wait_idle(stable_seconds=0)
            self.assertEqual(guard.uuid, 'GPU-test')
            self.assertEqual(query.call_args.args[-1], 'GPU-test')

    def test_missing_telemetry_and_changed_device_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            guard = GpuGuard(Path(tmp) / 'gpu-processes.jsonl')
            with patch('gpu_guard.query', side_effect=RuntimeError('query failed')):
                with self.assertRaisesRegex(RuntimeError, 'telemetry unavailable'):
                    guard.wait_idle(stable_seconds=0)
            with patch('gpu_guard.query', return_value=[['GPU-test', '20000', 'N/A', '0']]):
                self.assertIn('error', guard.violation(1))
            guard.uuid = 'GPU-previous'
            with patch('gpu_guard.query', return_value=[['GPU-next', '20000', '19500', '0']]):
                self.assertIn('changed', guard.violation(1)['error'])


if __name__ == '__main__':
    unittest.main()
