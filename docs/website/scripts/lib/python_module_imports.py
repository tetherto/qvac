"""Emit the module dependencies of Python files as JSON, keyed by path.

Used by the docs example validator. Imports are read off the AST rather than
matched with a regex because the examples carry long module docstrings that
themselves contain `from tetherto.qvac_sdk import ...` lines; only a real parse
tells those apart from imports the file actually executes.

Usage: python3 python_module_imports.py FILE [FILE ...]

Output: {"<path>": {"imports": [...]}} or {"<path>": {"syntaxError": "..."}}.
Relative imports are reported verbatim with their leading dots so the caller
can treat them as local without re-deriving the level.
"""

from __future__ import annotations

import ast
import json
import sys


def module_refs(tree: ast.AST) -> list[str]:
    refs: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                refs.append(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                refs.append("." * node.level + (node.module or ""))
            elif node.module:
                refs.append(node.module.split(".")[0])
    return sorted({ref for ref in refs if ref})


def main() -> int:
    out: dict[str, dict[str, object]] = {}
    for path in sys.argv[1:]:
        try:
            with open(path, encoding="utf-8") as handle:
                tree = ast.parse(handle.read(), filename=path)
        except SyntaxError as err:
            out[path] = {"syntaxError": f"line {err.lineno}: {err.msg}"}
            continue
        except OSError as err:
            out[path] = {"syntaxError": str(err)}
            continue
        out[path] = {"imports": module_refs(tree)}
    json.dump(out, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
