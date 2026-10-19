import unittest
from check_android_instrumentation import validate


class InstrumentationResultTest(unittest.TestCase):
    success = "INSTRUMENTATION_STATUS_CODE: 1\nINSTRUMENTATION_STATUS_CODE: 0\nOK (1 test)\nINSTRUMENTATION_CODE: -1\n"

    def test_success(self):
        self.assertEqual(1, validate(self.success))
        self.assertEqual(1, validate(self.success.replace("\n", "\r\n")))
        self.assertEqual(1, validate("INSTRUMENTATION_STATUS_CODE: -3\n" + self.success))
        self.assertEqual(2, validate("INSTRUMENTATION_STATUS_CODE: -4\n" + self.success.replace("1 test", "2 tests")))

    def test_failures_and_incomplete_runs(self):
        for output in (
            "", "OK (0 tests)\nINSTRUMENTATION_CODE: -1\n",
            "INSTRUMENTATION_RESULT: shortMsg=Process crashed.\nINSTRUMENTATION_CODE: 0\n",
            self.success.replace("STATUS_CODE: 0", "STATUS_CODE: -2"),
            self.success.replace("STATUS_CODE: 0", "STATUS_CODE: -3"),
            self.success.replace("INSTRUMENTATION_CODE: -1", ""),
            self.success.replace("OK (1 test)", "OK (2 tests)"),
            self.success + "FAILURES!!!\n", self.success + self.success,
        ):
            with self.subTest(output=output), self.assertRaises(ValueError):
                validate(output)


if __name__ == "__main__":
    unittest.main()
