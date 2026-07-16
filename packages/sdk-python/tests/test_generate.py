"""Tests for scripts/generate.py: the Python client's typed-surface generator.

Mirrors the SDK's own contract-export test rigor (packages/sdk/test/unit/
contract-export.test.ts): manifest/schema coverage, deterministic
regeneration, and that the committed output matches a fresh build.
"""

from __future__ import annotations

import importlib.util
import sys
import tempfile
from collections.abc import Iterator
from pathlib import Path

import pytest

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = PACKAGE_ROOT / "scripts"

spec = importlib.util.spec_from_file_location("generate", SCRIPTS_DIR / "generate.py")
assert spec is not None and spec.loader is not None
generate = importlib.util.module_from_spec(spec)
sys.modules["generate"] = generate
spec.loader.exec_module(generate)


@pytest.fixture(scope="module")
def manifest_methods() -> list[dict]:
    return generate.load_manifest_methods()


@pytest.fixture(scope="module")
def fresh_build() -> Iterator[Path]:
    with tempfile.TemporaryDirectory() as tmp:
        output_root = Path(tmp) / "_generated"
        generate.build(output_root)
        yield output_root


def test_committed_output_matches_a_fresh_build(fresh_build: Path) -> None:
    assert generate.compare_dirs(fresh_build, generate.GENERATED_DIR)


def test_build_is_deterministic_across_runs(fresh_build: Path) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        second = Path(tmp) / "_generated"
        generate.build(second)
        assert generate.compare_dirs(fresh_build, second)


def test_every_manifest_method_resolves_to_a_request_and_response_class(
    manifest_methods: list[dict],
) -> None:
    resolved = generate.resolve_titles(generate.MODELS_DIR, manifest_methods)
    for method in manifest_methods:
        name = method["name"]
        request_title = f"{generate.pascal_case(name)}Request"
        response_title = f"{generate.pascal_case(name)}Response"
        assert request_title in resolved, f"{name} has no resolvable request class"
        assert response_title in resolved, f"{name} has no resolvable response class"


def test_every_registered_constant_resolves_to_an_enum_class(
    manifest_methods: list[dict],
) -> None:
    # Public constants (ModelType, PluginId, ...) merged into schema.json's
    # $defs by @/schemas/constants-registry.ts -- see .cursor/rules/sdk/
    # public-constants-contract.mdc in packages/sdk. Always plain top-level
    # classes, resolved the same way as every Request/Response.
    constant_titles = generate.load_constant_titles()
    assert constant_titles, "sanity: the contract actually has registered constants"

    resolved = generate.resolve_titles(generate.MODELS_DIR, manifest_methods)
    for title in constant_titles:
        assert title in resolved, f"{title} has no resolvable class"
        assert resolved[title][0] is None, f"{title} should be a plain top-level class"


def test_index_reexports_every_resolved_title(manifest_methods: list[dict]) -> None:
    resolved = generate.resolve_titles(generate.MODELS_DIR, manifest_methods)
    rendered = generate.render_index(resolved)
    for title in resolved:
        assert title in rendered, f"{title} missing from rendered index"


def test_methods_module_has_one_function_per_manifest_entry_with_matching_shape(
    manifest_methods: list[dict],
) -> None:
    import ast

    rendered = generate.render_methods_module(manifest_methods)
    tree = ast.parse(rendered)
    functions_by_name = {
        node.name: node
        for node in ast.walk(tree)
        if isinstance(node, ast.AsyncFunctionDef)
    }
    sync_functions = [
        node.name for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)
    ]
    assert (
        not sync_functions
    ), f"expected every method stub to be async def, found sync: {sync_functions}"

    for method in manifest_methods:
        func_name = generate.snake_case(method["name"])
        assert func_name in functions_by_name, f"missing stub for {method['name']}"

        params = [arg.arg for arg in functions_by_name[func_name].args.args]
        shape = generate.CALL_SHAPE_ANNOTATION[method["callShape"]]
        if shape == "duplex":
            assert params == [
                "transport",
                "params",
                "up",
            ], f"{method['name']} is duplex, expected (transport, params, up), got {params}"
        else:
            assert params == [
                "transport",
                "params",
            ], f"{method['name']} is {shape}, expected (transport, params), got {params}"


def test_models_registry_module_has_one_constant_per_catalog_entry() -> None:
    import ast

    catalog = generate.load_models_registry()
    assert len(catalog) > 0

    rendered = generate.render_models_registry_module(catalog)
    tree = ast.parse(rendered)
    assigned_names = {
        node.targets[0].id
        for node in tree.body
        if isinstance(node, ast.Assign)
        and len(node.targets) == 1
        and hasattr(node.targets[0], "id")
    }

    for name, entry in catalog.items():
        assert name in assigned_names, f"{name} has no generated ModelConstant"
        assert (
            name == entry["name"]
        ), f"{name}: catalog key must match its own name field"


def test_progress_capable_methods_get_a_with_progress_stub(
    manifest_methods: list[dict],
) -> None:
    import ast

    rendered = generate.render_methods_module(manifest_methods)
    tree = ast.parse(rendered)
    functions_by_name = {
        node.name: node
        for node in ast.walk(tree)
        if isinstance(node, ast.AsyncFunctionDef)
    }

    progress_methods = {m["name"] for m in manifest_methods if m.get("progress")}
    assert progress_methods == {"loadModel", "downloadAsset", "rag", "finetune"}

    for method in manifest_methods:
        name = method["name"]
        progress_func_name = f"{generate.snake_case(name)}_with_progress"
        if name not in progress_methods:
            assert (
                progress_func_name not in functions_by_name
            ), f"{name} has no progress block but got a {progress_func_name} stub"
            continue

        assert (
            progress_func_name in functions_by_name
        ), f"missing progress stub for {name}"
        func = functions_by_name[progress_func_name]
        params = [arg.arg for arg in func.args.args]
        assert params == [
            "transport",
            "params",
        ], f"{progress_func_name} params: {params}"

        source = ast.unparse(func)
        assert "transport.call_stream(payload)" in source
        assert "payload['withProgress'] = True" in source
        assert generate.progress_response_title(method) in source
        assert f"{generate.pascal_case(name)}Response" in source
