"""Timing utilities for benchmarking."""

import time
from contextlib import contextmanager
from typing import Callable


@contextmanager
def timer():
    """Context manager for timing code blocks.

    Usage:
        with timer() as get_elapsed:
            # do some work
            elapsed = get_elapsed()
    """
    start = time.perf_counter()
    yield lambda: time.perf_counter() - start


def format_duration(seconds: float) -> str:
    """Format duration as human-readable string.

    Args:
        seconds: Duration in seconds

    Returns:
        Formatted string like "1.23s" or "5m 30.1s"
    """
    if seconds < 60:
        return f"{seconds:.2f}s"
    elif seconds < 3600:
        minutes = int(seconds // 60)
        secs = seconds % 60
        return f"{minutes}m {secs:.1f}s"
    else:
        hours = int(seconds // 3600)
        minutes = int((seconds % 3600) // 60)
        secs = seconds % 60
        return f"{hours}h {minutes}m {secs:.0f}s"
