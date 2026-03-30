"""Pytest configuration for benchmark client tests."""
import pytest


def pytest_configure(config):
    """Register custom markers."""
    config.addinivalue_line(
        "markers",
        "verbose_arabic: marks tests that print verbose Arabic phrase analysis (skipped by default)"
    )


def pytest_collection_modifyitems(config, items):
    """Skip verbose_arabic tests unless explicitly requested with -m flag."""
    # Check if user explicitly requested verbose_arabic marker
    markexpr = config.getoption("-m", default="")
    
    if "verbose_arabic" not in markexpr:
        skip_verbose = pytest.mark.skip(
            reason="Verbose test skipped by default. Run with: pytest -m verbose_arabic -v -s"
        )
        for item in items:
            if "verbose_arabic" in item.keywords:
                item.add_marker(skip_verbose)
