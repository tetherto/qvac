"""Extract the public function surface of the Python SDK, as JSON.

Usage: python3 -I python-surface.py <path to tetherto/qvac_sdk>

Reads the package's `__init__.py` for the names it re-exports by explicit
`from .<module> import (...)` lists, finds each one's `def` or `async def` in
that module, and prints its signature: parameter names, kinds, annotations,
and defaults as written, plus the first paragraph of its docstring. Classes
and constants are skipped. Standard library only: it reads source and never
imports the package.
"""

from __future__ import annotations

import ast
import json
import sys
from pathlib import Path


def module_path(package: Path, module: str) -> Path:
    base = package / module.replace(".", "/")
    return base / "__init__.py" if base.is_dir() else base.with_suffix(".py")


def public_defs(package: Path, module: str, seen: set[str] | None = None) -> dict[str, tuple[ast.AST, str]]:
    """Every public function a module defines or star-imports, with its module."""
    seen = seen if seen is not None else set()
    if module in seen:
        return {}
    seen.add(module)
    source = module_path(package, module)
    if not source.exists():
        return {}
    found: dict[str, tuple[ast.AST, str]] = {}
    prefix = module.rsplit(".", 1)[0] + "." if "." in module else ""
    for node in ast.parse(source.read_text()).body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and not node.name.startswith("_"):
            found[node.name] = (node, module)
        elif isinstance(node, ast.ImportFrom) and node.level == 1 and node.module and any(a.name == "*" for a in node.names):
            found.update(public_defs(package, prefix + node.module, seen))
    return found


def reexports(package: Path) -> dict[str, tuple[ast.AST, str]]:
    """Every public function the package re-exports, explicitly or by star."""
    functions: dict[str, tuple[ast.AST, str]] = {}
    for node in ast.parse((package / "__init__.py").read_text()).body:
        if not (isinstance(node, ast.ImportFrom) and node.level == 1 and node.module):
            continue
        defs = public_defs(package, node.module)
        for alias in node.names:
            if alias.name == "*":
                functions.update(defs)
            elif alias.name in defs:
                functions[alias.asname or alias.name] = defs[alias.name]
    return functions


def text(node: ast.AST | None) -> str | None:
    return None if node is None else ast.unparse(node)


def describe(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> dict:
    args = fn.args
    params = []
    positional = args.posonlyargs + args.args
    defaults = [None] * (len(positional) - len(args.defaults)) + list(args.defaults)
    for arg, default in zip(positional, defaults):
        params.append({"name": arg.arg, "kind": "positional", "annotation": text(arg.annotation), "default": text(default)})
    if args.vararg:
        params.append({"name": args.vararg.arg, "kind": "var-positional", "annotation": text(args.vararg.annotation), "default": None})
    for arg, default in zip(args.kwonlyargs, args.kw_defaults):
        params.append({"name": arg.arg, "kind": "keyword", "annotation": text(arg.annotation), "default": text(default)})
    if args.kwarg:
        params.append({"name": args.kwarg.arg, "kind": "var-keyword", "annotation": text(args.kwarg.annotation), "default": None})
    doc = ast.get_docstring(fn) or ""
    prefix = "async def" if isinstance(fn, ast.AsyncFunctionDef) else "def"
    signature = f"{prefix} {fn.name}({ast.unparse(fn.args)})" + (f" -> {text(fn.returns)}" if fn.returns else "")
    return {
        "name": fn.name,
        "async": isinstance(fn, ast.AsyncFunctionDef),
        "signature": signature,
        "params": params,
        "returns": text(fn.returns),
        "summary": doc.split("\n\n")[0].strip(),
    }


def main(package: Path) -> None:
    functions = [
        {**describe(node), "module": module}
        for name, (node, module) in sorted(reexports(package).items())
    ]
    print(json.dumps({"functions": functions}, indent=2))


if __name__ == "__main__":
    main(Path(sys.argv[1]))
