import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("guard", Path(__file__).with_name("check-wire-literals.py"))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class WireGuardTest(unittest.TestCase):
    def test_catches_misspelled_key_and_discriminator(self):
        self.assertEqual((["modleId"], ["completino"]), guard.check(
            'put("modleId", id); type = "completino"', {"modelId"}, {"completion"}))

    def test_schema_walk_includes_nested_unions(self):
        keys, values = guard.vocabulary({"oneOf": [{"properties": {"type": {"const": "ok"}}}]})
        self.assertEqual({"type"}, keys)
        self.assertEqual({"ok"}, values)

    def test_ignores_comments_but_checks_accessors(self):
        self.assertEqual((["typo"], []), guard.check('// put("ignored", x)\nfoo["typo"]', set(), set()))
