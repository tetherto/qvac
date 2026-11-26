import unittest

from full_suite import summarize


class FullSuiteTest(unittest.TestCase):
    def test_distinguishes_disk_frame_failure_from_other_failures(self):
        log = '''# ABot-World: CPU streaming, KV on matches resident frames across history updates
    # ABot parity backend: cuda0
    not ok 10 - block 1, frame 1: mean pixel error 1.8000 <= 1/255 against resident execution
# ABot-World: disk residency, KV on matches resident frames across history updates
    # ABot parity backend: cuda0
    ok 20 - block 1, frame 0: mean pixel error 0.0000 <= 1/255 against resident execution
    not ok 21 - block 1, frame 1: mean pixel error 1.2295 <= 1/255 against resident execution
not ok 5 - ABot-World: disk residency, KV on matches resident frames across history updates
# ABot-World: full world generation - native scene creation + KV-cache walk
# tests = 97/98 pass
# asserts = 732/767 pass
'''
        verdict = summarize(log)
        self.assertEqual(verdict['disk_errors'], [dict(block=1, frame=1, mean=1.2295)])
        self.assertEqual(verdict['comparisons'], 3)
        self.assertEqual(verdict['disk_comparisons'], 2)
        self.assertEqual(verdict['cuda_lanes'], 2)
        self.assertEqual(verdict['totals']['tests'], '97/98')
