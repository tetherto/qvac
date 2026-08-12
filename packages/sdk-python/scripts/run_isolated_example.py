"""Execute one example in isolation and report what it could not import.

Every example promises it runs after `pip install tetherto-qvac-sdk` and
nothing else. This proves it the only way that actually holds: the file is
copied alone into an empty directory and executed there, so the examples
directory is not on `sys.path` and a sibling helper cannot resolve.

Absent modules are fabricated only when the package actually declares them
(`STUBBABLE` below), so the check runs without installing anything while an
import of something undeclared — a sibling helper, present or long deleted —
still fails. Stubbing also removes ordering luck: without it the first missing
declared package would mask a bad import further down the file.

The module body runs under a non-`__main__` name, so imports, constants and
`def`s execute while the `if __name__ == "__main__"` entry point does not. No
worker, no model download.

Usage: python3 run_isolated_example.py <file> [stubbable-names-json]
Output: {"ok": true} or {"ok": false, "kind": ..., "module": ..., "detail": ...}
"""

from __future__ import annotations

import dis
import importlib.abc
import importlib.machinery
import importlib.util
import json
import os
import runpy
import sys
import types
from collections.abc import Callable, Sequence
from typing import Any

# Top-level module names the examples may import: this package plus the
# distributions pyproject.toml declares under `dependencies` and the `vla` /
# `notebook` extras. Anything absent and outside this set is treated as a
# missing module rather than quietly fabricated, which is what catches an
# import of a sibling helper that no longer exists.
STUBBABLE = frozenset(
    {
        "tetherto",
        "pydantic",
        "bare_rpc",
        "compact_encoding",
        "numpy",
        "pandas",
        "IPython",
    }
)


class _Dummy:
    """Stand-in for any attribute pulled off a stubbed module."""

    def __init__(self, name: str) -> None:
        self._name = name

    def __call__(self, *args: object, **kwargs: object) -> _Dummy:
        return _Dummy(f"{self._name}()")

    def __getattr__(self, attr: str) -> _Dummy:
        return _Dummy(f"{self._name}.{attr}")

    def __iter__(self) -> Any:
        return iter(())

    def __repr__(self) -> str:
        return f"<stub {self._name}>"


def _module_getattr(module_name: str) -> Callable[[str], _Dummy]:
    def __getattr__(attr: str) -> _Dummy:
        return _Dummy(f"{module_name}.{attr}")

    return __getattr__


class _StubFinder(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    """Fabricate a declared module that isn't installed.

    Sits at the end of `sys.meta_path`, so stdlib and genuinely installed
    packages still import normally; this only handles what would otherwise
    raise, and only for names the package declares.
    """

    def __init__(self, stubbable: frozenset[str]) -> None:
        self.stubbable = stubbable

    def find_spec(
        self,
        fullname: str,
        path: Sequence[str] | None = None,
        target: types.ModuleType | None = None,
    ) -> importlib.machinery.ModuleSpec | None:
        if fullname.split(".")[0] not in self.stubbable:
            return None
        return importlib.machinery.ModuleSpec(fullname, self, is_package=True)

    def create_module(self, spec: importlib.machinery.ModuleSpec) -> types.ModuleType:
        module = types.ModuleType(spec.name)
        # A package, so `from pkg.sub import x` keeps resolving through us.
        module.__path__ = []  # type: ignore[attr-defined]
        # PEP 562: makes `from stub import anything` resolve to a _Dummy.
        module.__getattr__ = _module_getattr(spec.name)  # type: ignore[method-assign]
        return module

    def exec_module(self, module: types.ModuleType) -> None:
        return None


def imported_names(code: types.CodeType) -> set[str]:
    """Every module name the compiled file imports, at any nesting depth.

    Running the module only exercises top-level imports. An import inside a
    function body never executes here, because the `__main__` entry point is
    deliberately not run — so `def main(): from _common import x` would
    otherwise pass. This reads the operands the compiler emitted, so nesting
    and control flow do not hide anything.
    """
    names: set[str] = set()
    pending = [code]

    while pending:
        current = pending.pop()
        for instr in dis.get_instructions(current):
            if instr.opname == "IMPORT_NAME" and instr.argval:
                names.add(str(instr.argval).split(".")[0])
        for const in current.co_consts:
            if isinstance(const, types.CodeType):
                pending.append(const)

    return names


def resolvable(name: str) -> bool:
    """Whether `name` imports from somewhere other than the example's folder."""
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def report(kind: str, module: str, detail: str) -> int:
    json.dump(
        {"ok": False, "kind": kind, "module": module, "detail": detail}, sys.stdout
    )
    return 0


def main() -> int:
    target = sys.argv[1]
    stubbable = frozenset(json.loads(sys.argv[2])) if len(sys.argv) > 2 else STUBBABLE

    sys.meta_path.append(_StubFinder(stubbable))

    try:
        runpy.run_path(target, run_name="__isolation_check__")
    except ModuleNotFoundError as err:
        return report("missing-module", err.name or "", str(err))
    except SyntaxError as err:
        return report("syntax-error", "", f"line {err.lineno}: {err.msg}")
    except Exception as err:
        # Module-level code the stubs could not satisfy — not a standalone-ness
        # problem, but reported so it can't hide a real failure. SystemExit and
        # KeyboardInterrupt deliberately propagate.
        return report("exec-error", "", f"{type(err).__name__}: {err}")

    # The module loaded, so its top-level imports are clean. Deferred ones never
    # ran; catch those from the compiled code.
    with open(target, encoding="utf-8") as handle:
        code = compile(handle.read(), target, "exec")

    own_name = os.path.splitext(os.path.basename(target))[0]
    for name in sorted(imported_names(code) - {own_name}):
        if name not in stubbable and not resolvable(name):
            return report("missing-module", name, f"deferred import of {name!r}")

    json.dump({"ok": True}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
