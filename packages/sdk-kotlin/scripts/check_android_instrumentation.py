#!/usr/bin/env python3
"""Fail closed: adb's process exit code alone does not indicate test success."""
import re
import sys
from pathlib import Path


def validate(output: str) -> int:
    if re.search(r"FAILURES!!!|INSTRUMENTATION_FAILED|INSTRUMENTATION_ABORTED|shortMsg=|Process crashed", output):
        raise ValueError("Android instrumentation failed or crashed")
    if re.search(r"^INSTRUMENTATION_STATUS_CODE: -[12]\s*$", output, re.M):
        raise ValueError("Android instrumentation reported a failed test")
    codes = re.findall(r"^INSTRUMENTATION_CODE: (-?\d+)\s*$", output, re.M)
    totals = re.findall(r"^OK \((\d+) tests?\)\s*$", output, re.M)
    if codes != ["-1"] or len(totals) != 1 or int(totals[0]) <= 0:
        raise ValueError("Missing successful, nonempty instrumentation completion")
    passed = len(re.findall(r"^INSTRUMENTATION_STATUS_CODE: 0\s*$", output, re.M))
    if passed == 0:
        raise ValueError("No test actually passed (all skipped or incomplete)")
    # JUnit counts assumption failures (-4) as run tests, but @Ignore (-3)
    # is excluded from its final run count.
    completed = re.findall(r"^INSTRUMENTATION_STATUS_CODE: (?:0|-4)\s*$", output, re.M)
    if len(completed) != int(totals[0]):
        raise ValueError("Reported test count does not match completed test results")
    return int(totals[0])


if __name__ == "__main__":
    try:
        count = validate(Path(sys.argv[1]).read_text())
    except (ValueError, OSError, IndexError) as error:
        print(f"Device validation failed: {error}", file=sys.stderr)
        sys.exit(1)
    print(f"Verified Android instrumentation completion: {count} tests")
