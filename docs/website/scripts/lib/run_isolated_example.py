"""Execute one docs example in isolation and report what it could not import.

The docs promise each embedded Python block runs after `pip install` and
nothing else. This proves it the only way that actually holds: the file is
copied alone into an empty directory and executed there, so the examples
directory is not on `sys.path` and a sibling helper cannot resolve.

Every module the reader would have installed is stubbed, so an import can only
fail when it names a file that lives beside the example in the repo. Stubbing
also removes ordering luck — without it the first missing third-party package
would mask a repo-local import further down the file.

The module body runs under a non-`__main__` name, so imports, constants and
`def`s execute while the `if __name__ == "__main__"` entry point does not. No
worker, no model download.

Usage: python3 run_isolated_example.py <file> <repo-local-names-json>
Output: {"ok": true} or {"ok": false, "kind": ..., "module": ..., "detail": ...}
"""

from __future__ import annotations

import importlib.abc
import importlib.machinery
import importlib.util
import json
import runpy
import sys
import types


class _Dummy:
    """Stand-in for any attribute pulled off a stubbed module."""

    def __init__(self, name: str) -> None:
        self._name = name

    def __call__(self, *args: object, **kwargs: object) -> _Dummy:
        return _Dummy(f"{self._name}()")

    def __getattr__(self, attr: str) -> _Dummy:
        return _Dummy(f"{self._name}.{attr}")

    def __iter__(self):
        return iter(())

    def __repr__(self) -> str:
        return f"<stub {self._name}>"


class _StubFinder(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    """Fabricate any absent module except the ones we want to catch.

    Sits at the end of `sys.meta_path`, so real stdlib and installed packages
    still import normally; this only handles what would otherwise raise.
    """

    def __init__(self, never_stub: set[str]) -> None:
        self.never_stub = never_stub

    def find_spec(self, fullname, path=None, target=None):
        if fullname.split(".")[0] in self.never_stub:
            return None
        return importlib.machinery.ModuleSpec(fullname, self, is_package=True)

    def create_module(self, spec):
        module = types.ModuleType(spec.name)
        # A package, so `from pkg.sub import x` keeps resolving through us.
        module.__path__ = []
        module.__getattr__ = lambda attr, _n=spec.name: _Dummy(f"{_n}.{attr}")
        return module

    def exec_module(self, module):
        return None


def main() -> int:
    target, never_stub_json = sys.argv[1], sys.argv[2]
    never_stub = set(json.loads(never_stub_json))

    sys.meta_path.append(_StubFinder(never_stub))

    try:
        runpy.run_path(target, run_name="__docs_isolation_check__")
    except ModuleNotFoundError as err:
        json.dump(
            {
                "ok": False,
                "kind": "missing-module",
                "module": err.name or "",
                "detail": str(err),
            },
            sys.stdout,
        )
        return 0
    except SyntaxError as err:
        json.dump(
            {
                "ok": False,
                "kind": "syntax-error",
                "module": "",
                "detail": f"line {err.lineno}: {err.msg}",
            },
            sys.stdout,
        )
        return 0
    except BaseException as err:  # noqa: BLE001
        # Anything else is the stubs failing to satisfy module-level code, not
        # a standalone-ness problem. Reported so it can't hide a real failure.
        json.dump(
            {
                "ok": False,
                "kind": "exec-error",
                "module": "",
                "detail": f"{type(err).__name__}: {err}",
            },
            sys.stdout,
        )
        return 0

    json.dump({"ok": True}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
