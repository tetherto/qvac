from pathlib import Path
import tempfile
import unittest

from replay import instrument, summarize


class ReplayTest(unittest.TestCase):
    def test_instrumentation_preserves_existing_assertion(self):
        source = """const fs = require('bare-fs')
      config: { seed: 42, kvCache: true },
          t.ok(error <= 1 / 255)
          return blocks
"""
        output = instrument(source)
        self.assertIn('          t.ok(error <= 1 / 255)\n          ', output)
        self.assertIn('          return blocks\n', output)
        self.assertIn('verbosity: 3', output)
        self.assertIn('QVAC-28085 FRAMES', output)
        with self.assertRaisesRegex(ValueError, 'Historical source changed'):
            instrument(source.replace('return blocks', 'return []'))

    def test_summary_reports_pixel_drift_separately_from_memory_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / 'test.log'
            log.write_text('    not ok 21 - block 1, frame 1: mean pixel error 1.2295 <= 1/255 against resident execution\n'
                           '# ABot-World: full world generation - native scene creation + KV-cache walk\n'
                           'model manager cannot make enough memory available on CUDA0\n', encoding='utf-8')
            result = summarize(log, -6)
            self.assertEqual(result['exit'], -6)
            self.assertTrue(result['reached_full_world'])
            self.assertEqual(result['pixel_comparisons'], 1)
            self.assertEqual(result['max_pixel_error'], 1.2295)
            self.assertEqual(len(result['failures']), 2)
