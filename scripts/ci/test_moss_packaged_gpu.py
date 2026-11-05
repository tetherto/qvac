from contextlib import nullcontext
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("packaged", Path(__file__).with_name("moss-packaged-gpu.py"))
packaged = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packaged)


class StrictPackagedGpuTests(unittest.TestCase):
    def test_full_pass(self):
        packaged.validate_tap("1..12\n# tests = 12/12 pass\n# ok\n", 12)

    def test_partial_pass_fails(self):
        for text in ["# tests = 11/12 pass\n# ok\n", "# tests = 0/0 pass\n# ok\n",
                     "# tests = 12/12 pass\n", "# tests = 12/12 pass\n# not ok\n"]:
            with self.subTest(text=text), self.assertRaises(RuntimeError):
                packaged.validate_tap(text, 12)

    def test_fixture_skip_cannot_pass(self):
        for skip in ["ok 1 - no fixture # SKIP", "ok 1 - fixture missing - skipping", "# skip = 1"]:
            with self.subTest(skip=skip), self.assertRaises(RuntimeError):
                packaged.validate_tap(skip + "\n# tests = 12/12 pass\n# ok\n", 12)

    def test_failure_cannot_hide_behind_summary(self):
        with self.assertRaises(RuntimeError):
            packaged.validate_tap("not ok 1 - wrong backend\n# tests = 12/12 pass\n# ok\n", 12)

    def test_stage_uses_small_backbones_codecs_and_both_audio_fixtures(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ["packages/tts-ggml/test/reference-audio/jfk.wav",
                         "packages/asr-ggml/examples/samples/LastQuestion_long_ES.raw"]:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b"fixture")
            (root / "results").mkdir()
            tools = Mock()
            with patch.object(packaged.os, "chdir"):
                packaged.stage(root, root / "results", root / "native", tools)
            self.assertEqual([call.args[0] for call in tools.prepare_checkpoint.call_args_list],
                             ["tts-q8_0", "ttsd-q8_0", "sfx-q8_0", "speech-q8_0", "transcribe-q5_0"])
            self.assertEqual([call.args[0] for call in tools.download.call_args_list],
                             ["moss-codec-decoder-f16", "moss-codec-encoder-f16", "moss-speech-codec-f16"])
            self.assertEqual(tools.record_model_hash.call_count, 2)

    def test_stage_missing_audio_is_fatal(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(packaged.os, "chdir"):
            root = Path(tmp)
            with self.assertRaisesRegex(RuntimeError, "Required audio fixture missing"):
                packaged.stage(root, root, root, Mock())

    def test_backend_runs_all_focused_suites_and_fails_on_inference_error(self):
        for fail in [False, True]:
            with self.subTest(fail=fail), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                tools = Mock()
                tools.gpu_lease.side_effect = lambda *args: nullcontext()
                def execute(command, **kwargs):
                    if command[0] == "npx":
                        self.assertEqual(command[-1], "test/integration/moss-transcribe.test.js")
                        return Mock(returncode=0)
                    self.assertEqual(kwargs["env"]["TTS_CPP_GPU_BACKEND"], "cuda")
                    self.assertEqual(kwargs["env"]["QVAC_TEST_MOSS_FULL_GPU"], "true")
                    count = 12 if "moss-speech.test.js" in command[-1] else 1 if "parakeet-run-tests.sh" in command[-1] else 2
                    kwargs["stdout"].write(f"# tests = {count}/{count} pass\n# ok\n")
                    return Mock(returncode=1 if fail and count == 12 else 0)
                with patch.object(packaged.subprocess, "run", side_effect=execute), patch("builtins.print"):
                    if fail:
                        with self.assertRaisesRegex(RuntimeError, "validation failed"):
                            packaged.run_backend(root, root, tools, "cuda")
                    else:
                        packaged.run_backend(root, root, tools, "cuda")
                results = json.loads((root / "cuda-results.json").read_text())
                self.assertEqual(len(results), 3)
                self.assertEqual(results[0]["status"], "failed" if fail else "passed")
                self.assertEqual(results[-1]["status"], "passed")


if __name__ == "__main__":
    unittest.main()
