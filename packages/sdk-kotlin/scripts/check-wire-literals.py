"""Fail on unknown wire keys/types in the handwritten common API.

This deliberately checks vocabulary, not path-sensitive schema validation. Actual
serialization and worker conformance tests cover shapes. Supplemental plugin and
worker-control vocabulary must have a checked-in upstream source anchor.
"""
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT.parent / "sdk/contract/schema.json"
KEY = re.compile(r'(?:\b(?:put(?:JsonObject|JsonArray)?|get(?:Value)?|required\w*)\(\s*|\[\s*)"([^"\n]+)"')
TYPE = re.compile(r'(?:\b(?:type|handler)\s*=\s*|\bput\(\s*"type"\s*,\s*)"([^"\n]+)"')
BRANCH = re.compile(r'^\s*"([\w:-]+)"\s*->', re.M)


def vocabulary(schema):
    keys, values = set(), set()
    def visit(node):
        if isinstance(node, dict):
            keys.update(node.get("properties", {}))
            if isinstance(node.get("const"), str):
                values.add(node["const"])
            values.update(v for v in node.get("enum", []) if isinstance(v, str))
            for value in node.values():
                visit(value)
        elif isinstance(node, list):
            for value in node:
                visit(value)
    visit(schema)
    return keys, values


def check(source, keys, values):
    # Comment prose is not wire data. String literals remain intact.
    source = re.sub(r'/\*.*?\*/|//[^\n]*', '', source, flags=re.S)
    return sorted(set(KEY.findall(source)) - keys), sorted((set(TYPE.findall(source)) | set(BRANCH.findall(source))) - values)


def main():
    keys, values = vocabulary(json.loads(SCHEMA.read_text()))
    # pluginInvoke.params/result are intentionally opaque in schema.json.
    # Read their authoritative Zod declaration, not an unchecked allowlist.
    vla = (ROOT.parent / "inference/src/schemas/vla.ts").read_text()
    plugin_keys = set(re.findall(r'^\s*(\w+)\s*:\s*', vla, re.M))
    plugin_types = set(re.findall(r"z\.literal\('([^']+)'\)", vla))
    failures = []
    count = 0
    source_root = ROOT / "src/commonMain/kotlin/io/tether/qvac/sdk"
    for path in sorted(source_root.rglob("*.kt")):
        if path.relative_to(source_root).parts[0] in {"generated", "rpc"}:
            continue  # Generated code and binary framing do not hand-assemble SDK JSON.
        bad_keys, bad_values = check(path.read_text(),
            keys | plugin_keys if path.name == "QvacVlaApi.kt" else keys,
            values | plugin_types if path.name == "QvacVlaApi.kt" else values)
        count += 1
        if bad_keys or bad_values:
            failures.append(f"{path.name}: keys={bad_keys}, types={bad_values}")
    if failures:
        raise SystemExit("Wire vocabulary drift:\n" + "\n".join(failures))
    print(f"Wire vocabulary checked in {count} handwritten API files")


if __name__ == "__main__":
    main()
