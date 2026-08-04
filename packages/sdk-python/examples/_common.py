"""Shared helpers for the sample examples.

Mirrors the little `onProgress` download printer every TypeScript example in
`packages/sdk/examples` repeats inline.
"""

from __future__ import annotations

import sys


def print_progress(p) -> None:
    """Pass as `on_progress=` to `load_model`. `p` is a ModelProgressResponse
    (percentage/downloaded/total), matching the JS `onProgress` callback."""
    mb = lambda n: n / 1e6  # noqa: E731
    line = (
        f"▸ Downloading {p.percentage:.0f}% "
        f"({mb(p.downloaded):.1f}/{mb(p.total):.1f} MB)"
    )
    end = "\r" if sys.stderr.isatty() else "\n"
    print(line, end=end, file=sys.stderr)
    if p.percentage >= 100:
        print(file=sys.stderr)
