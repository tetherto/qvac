from array import array
import importlib.util
import json
import os
import struct
import zlib
import binascii
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from run import first_uninitialized_read, wait_for_probe
from run_mmq_isolate import classify_read
from compare_trace import compare_nodes, read_trace

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('compare', HERE / 'compare.py')
compare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compare)


class DiagnosticsTest(unittest.TestCase):
    def test_trace_finds_first_change_and_rejects_missing_or_different_graphs(self):
        tensor = {'name': 'out', 'type': 0, 'op': 'MUL_MAT', 'ne': [2, 1, 1, 1], 'nb': [4, 8, 8, 8]}
        nodes = [{'event': 'node', 'index': i, 'output': tensor, 'sources': [], 'fnv1a64': str(i)} for i in range(3)]
        changed = json.loads(json.dumps(nodes))
        changed[1]['fnv1a64'] = 'different'
        self.assertEqual(compare_nodes(nodes, changed)['firstDifference']['index'], 1)
        self.assertIsNone(compare_nodes(nodes, nodes)['firstDifference'])
        changed[0]['output']['ne'][0] = 3
        self.assertFalse(compare_nodes(nodes, changed)['comparable'])
        self.assertFalse(compare_nodes(nodes, nodes[:-1])['comparable'])
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'operations.jsonl'
            path.write_text('\n'.join(json.dumps(row) for row in nodes))
            with self.assertRaisesRegex(ValueError, 'Incomplete'):
                read_trace(path)
            with path.open('a') as f:
                f.write('\n' + json.dumps({'event': 'end', 'nodes': 3}) + '\n')
            self.assertEqual(read_trace(path), nodes)

    def test_scratch_read_classification_distinguishes_payload_padding_and_out_of_bounds(self):
        allocation = {'base': '0x1000', 'tail': '0x1800', 'payloadBytes': 2048, 'allocatedBytes': 2304}
        prefix = 'MMQ_SCRATCH ' + json.dumps(allocation) + '\n'
        for address, expected in (('0x17fc', False), ('0x1800', True), ('0x18fc', True), ('0x1900', False)):
            row = classify_read(prefix + '=========     Address ' + address)
            self.assertEqual(row['insidePadding'], expected)
            self.assertEqual(row['offsetFromTail'], int(address, 16) - 0x1800)
        self.assertIsNone(classify_read(prefix))
        self.assertIsNone(classify_read('=========     Address 0x1800'))

    def test_mmq_report_records_operation_and_stops_only_diagnostic_process(self):
        operation = {'phase': 'before', 'lane': 'resident-no-kv', 'tensors': [{'name': 'test.weight', 'ne': [128, 256, 1, 1]}]}
        report = ('ABOT_MMQ ' + json.dumps(operation) + '\n'
                  '========= Uninitialized __global__ memory read of size 4 bytes\n'
                  '=========     at void mul_mat_q<8, 128, false>()+0x2220\n')
        self.assertIsNone(first_uninitialized_read('========= ERROR SUMMARY: 0 errors'))
        self.assertIsNone(first_uninitialized_read(report.split('=========')[0]))
        parsed = first_uninitialized_read(report)
        self.assertEqual(parsed['operation'], operation)
        self.assertIn('mul_mat_q', parsed['kernel'])
        self.assertFalse(parsed['completedSanitizerReport'])
        with tempfile.TemporaryDirectory() as tmp:
            log_path = Path(tmp) / 'native.log'
            with log_path.open('w') as log:
                code = 'import time; print(' + repr(report) + ', flush=True); time.sleep(30)'
                with subprocess.Popen([sys.executable, '-c', code], stdout=log, start_new_session=True) as child:
                    status, evidence = wait_for_probe(child, log_path, True, timeout=10)
            self.assertEqual(status, 86)
            self.assertEqual(evidence['operation'], operation)
            self.assertIsNotNone(child.returncode)

    def test_numerical_error_and_nonfinite(self):
        with tempfile.TemporaryDirectory() as tmp:
            a, b = Path(tmp) / 'a', Path(tmp) / 'b'
            a.write_bytes(array('f', [1, 2, 3]).tobytes())
            b.write_bytes(array('f', [1, 2.5, 2.5]).tobytes())
            r = compare.compare_files(a, b)
            self.assertEqual(r['firstDifferentElement'], 1)
            self.assertEqual(r['maxAbs'], 0.5)
            self.assertAlmostEqual(r['meanAbs'], 1 / 3)
            b.write_bytes(array('f', [1, float('nan'), 3]).tobytes())
            with self.assertRaisesRegex(ValueError, 'Non-finite'):
                compare.compare_files(a, b)
            b.write_bytes(b'bad')
            with self.assertRaisesRegex(ValueError, 'Invalid float'):
                compare.compare_files(a, b)

    def test_missing_capture_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, 'Missing'):
                compare.compare_capture(Path(tmp))

    def test_stage_order(self):
        names = ['b0-s-1-final-latents.f32', 'b0-s0-renoise.f32', 'b0-s0-flow.f32',
                 'b0-s-1-initial-noise.f32', 'b1-s0-flow.f32']
        self.assertEqual(sorted(names, key=compare.stage_order),
                         [names[3], names[2], names[1], names[0], names[4]])

    def test_png_threshold_is_unchanged(self):
        if not shutil.which('node'):
            self.skipTest('Node is required')
        guards = HERE.parents[2] / 'packages/diffusion-cpp/test/integration/abot-guards.js'
        def png(pixel):
            def chunk(kind, data):
                return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', binascii.crc32(kind + data) & 0xffffffff)
            return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)) +
                    chunk(b'IDAT', zlib.compress(bytes([0, pixel, pixel, pixel]))) + chunk(b'IEND', b''))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for lane in {x for pair in compare.PAIRS for x in pair}:
                (root / lane).mkdir()
                (root / lane / 'frame_0000.png').write_bytes(png(10))
            cmd = ['node', str(HERE / 'compare-png.mjs'), str(root), str(guards), '1']
            subprocess.run(cmd, check=True, capture_output=True)
            (root / 'disk-kv/frame_0000.png').write_bytes(png(12))
            result = subprocess.run(cmd, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout)[2]['maxError'], 2)

    def test_first_divergence_and_required_stages(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            names = ['b0-s-1-' + s + '.f32' for s in ('initial-noise', 'final-latents', 'decoder-input', 'decoder-output')]
            names += [f'b0-s{s}-flow.f32' for s in range(4)]
            names += [f'b0-s{s}-renoise.f32' for s in range(3)]
            for lane in {x for pair in compare.PAIRS for x in pair}:
                (root / lane).mkdir()
                for name in names:
                    (root / lane / name).write_bytes(array('f', [1, 2]).tobytes())
            target = root / 'disk-kv/b0-s0-flow.f32'
            target.write_bytes(array('f', [1, 2.01]).tobytes())
            rows = compare.compare_capture(root, 1)
            self.assertIsNone(rows[0]['firstDifference'])
            self.assertEqual(rows[2]['firstDifference']['file'], target.name)
            target.unlink()
            with self.assertRaises(ValueError):
                compare.compare_capture(root, 1)

    def test_cross_process_comparison_detects_shared_reference_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            reference, current = Path(tmp) / 'first', Path(tmp) / 'next'
            names = ['b0-s-1-' + s + '.f32' for s in ('initial-noise', 'final-latents', 'decoder-input', 'decoder-output')]
            names += [f'b0-s{s}-flow.f32' for s in range(4)]
            names += [f'b0-s{s}-renoise.f32' for s in range(3)]
            for root in (reference, current):
                for lane in {x for pair in compare.PAIRS for x in pair}:
                    (root / lane).mkdir(parents=True)
                    for name in names:
                        (root / lane / name).write_bytes(array('f', [1, 2]).tobytes())
            # A shared shift leaves every within-process comparison equal.
            for lane in ('resident-kv', 'stream-kv', 'disk-kv'):
                (current / lane / 'b0-s0-flow.f32').write_bytes(array('f', [1, 3]).tobytes())
            self.assertTrue(all(row['firstDifference'] is None for row in compare.compare_capture(current, 1)))
            rows = compare.compare_capture(current, 1, reference)
            changed = {row['candidate']: row['firstDifference'] for row in rows if row['firstDifference']}
            self.assertEqual(set(changed), {'resident-kv', 'stream-kv', 'disk-kv'})
            self.assertTrue(all(row['file'] == 'b0-s0-flow.f32' and row['maxAbs'] == 1 for row in changed.values()))
            (reference / 'resident-kv/b0-s0-flow.f32').unlink()
            with self.assertRaisesRegex(ValueError, 'Missing'):
                compare.compare_capture(current, 1, reference)


class HeaderTest(unittest.TestCase):
    def test_trace_hash_ignores_stride_padding_but_detects_changed_values(self):
        compiler = shutil.which('c++')
        include = Path(os.environ.get('ABOT_DIAGNOSTIC_GGML_INCLUDE', HERE.parents[2] / 'diagnostic-engine/ggml/include'))
        if not compiler or not include.exists():
            self.skipTest('C++ compiler and ggml headers required')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'trace.cpp'
            source.write_text('''#include "diagnostics.h"
extern "C" size_t ggml_type_size(enum ggml_type) { return 4; }
int main() {
    ggml_tensor t = {};
    t.ne[0]=2; t.ne[1]=2; t.ne[2]=1; t.ne[3]=1;
    t.nb[0]=4; t.nb[1]=12; t.nb[2]=24; t.nb[3]=24;
    float strided[] = {1,2,99,3,4,99};
    float compact[] = {1,2,3,4};
    const auto expected = abot_trace_hash(reinterpret_cast<unsigned char*>(strided), &t);
    strided[2] = -999;
    if (expected != abot_trace_hash(reinterpret_cast<unsigned char*>(strided), &t)) return 1;
    t.nb[1]=8; t.nb[2]=16; t.nb[3]=16;
    if (expected != abot_trace_hash(reinterpret_cast<unsigned char*>(compact), &t)) return 2;
    compact[1] = 3;
    if (expected == abot_trace_hash(reinterpret_cast<unsigned char*>(compact), &t)) return 3;
}
''')
            exe = root / 'trace'
            subprocess.run([compiler, '-std=c++17', '-I' + str(HERE), '-I' + str(include), str(source), '-o', str(exe)], check=True, capture_output=True)
            subprocess.run([str(exe)], check=True)

    def test_compiled_hooks_are_opt_in_and_write_valid_float_data(self):
        compiler = shutil.which('c++')
        if not compiler:
            self.skipTest('No C++ compiler available')
        include = Path(os.environ.get('ABOT_DIAGNOSTIC_GGML_INCLUDE', HERE.parents[2] / 'diagnostic-engine/ggml/include'))
        if not include.exists():
            self.skipTest('Run native compilation on the pinned CI checkout')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'test.cpp'
            source.write_text('#include "diagnostics.h"\nint main(int argc, char** argv) {\n'
                              'setenv("SD_ABOT_DIAGNOSTIC_DIR", argv[1], 1);\n'
                              'float values[] = {1.0f, 2.5f};\n'
                              'abot_diag_dump("flow", 0, 0, values, 2);\n'
                              'abot_diag_event("prepare", values, sizeof(values));\n}\n')
            for enabled in (False, True):
                output = root / str(enabled)
                output.mkdir()
                exe = root / ('enabled' if enabled else 'disabled')
                args = [compiler, '-std=c++17', '-I' + str(HERE), '-I' + str(include),
                        str(source), '-o', str(exe)]
                if enabled:
                    args.append('-DSD_ABOT_DIAGNOSTICS')
                subprocess.run(args, check=True, capture_output=True)
                subprocess.run([str(exe), str(output)], check=True)
                if enabled:
                    self.assertEqual(list(compare.read_f32(output / 'b0-s0-flow.f32')[0]), [1.0, 2.5])
                    self.assertEqual(json.loads((output / 'memory.jsonl').read_text())['bytes'], 8)
                else:
                    self.assertEqual(list(output.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
