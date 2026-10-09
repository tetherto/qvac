"""Tests for plan-desktop-platforms.py.

Run: python3 -m unittest discover -s .github/scripts -p 'test_*.py'

The two JS planners beside this one have tests; this one did not, and it is
the script that decides which machines an expensive dispatch runs on.
"""

import importlib.util
import json
import os
import unittest

_spec = importlib.util.spec_from_file_location(
    "plan_desktop_platforms",
    os.path.join(os.path.dirname(__file__), "plan-desktop-platforms.py"),
)
plan_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(plan_mod)
plan = plan_mod.plan


class PlanDesktopPlatforms(unittest.TestCase):
    def test_default_is_linux_x64(self):
        self.assertEqual([e["platform"] for e in plan(None)], ["linux-x64"])
        self.assertEqual([e["platform"] for e in plan("")], ["linux-x64"])

    def test_every_known_platform_resolves_to_a_runner(self):
        for name in plan_mod.RUNNERS:
            (entry,) = plan(json.dumps([name]))
            self.assertEqual(entry["platform"], name)
            self.assertTrue(entry["runner"], f"{name} has a runner")

    def test_duplicates_collapse_preserving_order(self):
        # Two identical legs would upload to the same artifact name and
        # silently clobber each other.
        got = [e["platform"] for e in plan('["win32-x64","linux-x64","win32-x64"]')]
        self.assertEqual(got, ["win32-x64", "linux-x64"])

    def test_malformed_json_fails_cleanly(self):
        for raw in ("not json", "[", '{"a":1}'):
            with self.assertRaises(SystemExit, msg=raw) as cm:
                plan(raw)
            self.assertNotIn("Traceback", str(cm.exception))
            self.assertIn("desktop_platforms", str(cm.exception))

    def test_unknown_and_empty_are_rejected(self):
        with self.assertRaises(SystemExit) as cm:
            plan('["nope"]')
        self.assertIn("nope", str(cm.exception))
        with self.assertRaises(SystemExit):
            plan("[]")

    def test_a_json_array_runner_stays_parseable(self):
        # darwin-arm64 carries a JSON-array runner label, which the workflow
        # feeds to fromJSON. If it is not valid JSON the leg cannot schedule.
        (entry,) = plan('["darwin-arm64"]')
        self.assertTrue(entry["runner"].startswith("["))
        self.assertEqual(
            json.loads(entry["runner"]), ["self-hosted", "qvac-macos26-arm64-gpu"]
        )


if __name__ == "__main__":
    unittest.main()
