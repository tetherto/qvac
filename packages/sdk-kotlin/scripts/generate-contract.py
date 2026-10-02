#!/usr/bin/env python3
"""Generate the Kotlin client contract from the shared QVAC artifacts.

Usage:
  python3 scripts/generate-contract.py
  python3 scripts/generate-contract.py --check

The generated Kotlin source is intentionally boring: it contains only
serialization models, constants, registries, and method metadata. Runtime
behavior remains in hand-written common Kotlin code.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from contract_types import TypeGraph, render_schema_methods


PACKAGE_ROOT = Path(__file__).resolve().parent.parent
CONTRACT_ROOT = PACKAGE_ROOT.parent / "sdk" / "contract"
OUTPUT_ROOT = PACKAGE_ROOT / "src/commonMain/kotlin/io/tether/qvac/sdk/generated"


def read_json(name: str):
    return json.loads((CONTRACT_ROOT / name).read_text(encoding="utf-8"))


def pascal_case(value: str) -> str:
    return "".join(part[:1].upper() + part[1:] for part in re.split(r"[^A-Za-z0-9]+", value) if part)


def kotlin_identifier(value: str) -> str:
    result = re.sub(r"[^A-Za-z0-9_]", "_", value)
    if not result:
        return "value"
    if result[0].isdigit():
        return f"value_{result}"
    if result in {
        "as", "break", "class", "continue", "do", "else", "false", "for",
        "fun", "if", "in", "interface", "is", "null", "object", "package",
        "return", "super", "this", "throw", "true", "try", "typealias",
        "typeof", "val", "var", "when", "while", "by", "catch", "constructor",
        "delegate", "dynamic", "field", "file", "finally", "get", "import",
        "init", "param", "property", "receiver", "set", "setparam", "where",
        "actual", "abstract", "annotation", "companion", "const", "crossinline",
        "data", "enum", "expect", "external", "final", "infix", "inline",
        "inner", "lateinit", "noinline", "open", "operator", "out", "override",
        "private", "protected", "public", "reified", "sealed", "suspend", "tailrec",
        "vararg", "field", "it",
    }:
        return f"`{result}`"
    return result


def ref_name(ref: str, definitions: dict) -> str | None:
    name = ref.rsplit("/", 1)[-1]
    definition = definitions.get(name)
    if definition and definition.get("title"):
        return pascal_case(definition["title"])
    return pascal_case(name)


def primitive_type(schema: dict, definitions: dict) -> tuple[str, bool]:
    if "$ref" in schema:
        return ref_name(schema["$ref"], definitions) or "JsonElement", False

    if "const" in schema:
        value = schema["const"]
        if isinstance(value, bool):
            return "Boolean", False
        if isinstance(value, int):
            return "Long", False
        if isinstance(value, float):
            return "Double", False
        return "String", False

    types = schema.get("type")
    nullable = False
    if isinstance(types, list):
        nullable = "null" in types
        types = next((item for item in types if item != "null"), None)

    if types == "string":
        return "String", nullable
    if types == "integer":
        return "Long", nullable
    if types == "number":
        return "Double", nullable
    if types == "boolean":
        return "Boolean", nullable
    if types == "array":
        items = schema.get("items", {})
        item_type, item_nullable = primitive_type(items, definitions)
        if item_nullable:
            item_type = f"{item_type}?"
        return f"List<{item_type}>", nullable
    if types == "object":
        if schema.get("properties"):
            return "JsonObject", nullable
        if schema.get("additionalProperties") not in (False, None):
            value_type, value_nullable = primitive_type(schema["additionalProperties"], definitions)
            if value_nullable:
                value_type = f"{value_type}?"
            return f"Map<String, {value_type}>", nullable
        return "JsonObject", nullable
    return "JsonElement", nullable


def field_type(schema: dict, definitions: dict, required: bool) -> str:
    result, nullable = primitive_type(schema, definitions)
    if not required and not nullable:
        result += "?"
    return result


def merged_object_properties(schema: dict) -> tuple[dict, set[str], bool]:
    """Flatten object members from unions so callers can construct one request.

    JSON Schema unions are validated by the worker. Kotlin keeps the complete
    wire shape in one permissive serializable request class; this preserves
    every field without pretending that a source-language sealed hierarchy is
    the wire contract.
    """
    properties: dict = {}
    required: set[str] | None = None
    is_union = any(key in schema for key in ("anyOf", "oneOf", "allOf"))
    if schema.get("properties"):
        properties.update(schema["properties"])
        required = set(schema.get("required", []))
    for key in ("anyOf", "oneOf", "allOf"):
        for branch in schema.get(key, []):
            branch_properties, branch_required, branch_is_union = merged_object_properties(branch)
            properties.update(branch_properties)
            if required is None:
                required = set(branch_required)
            elif branch_is_union or is_union:
                required &= branch_required
            else:
                required |= branch_required
            is_union = is_union or branch_is_union
    return properties, required or set(), is_union


def render_models(schema: dict) -> str:
    definitions = schema["$defs"]
    lines = [
        "// Generated by scripts/generate-contract.py. Do not edit by hand.",
        "package io.tether.qvac.sdk.generated",
        "",
        "import kotlinx.serialization.SerialName",
        "import kotlinx.serialization.Serializable",
        "import kotlinx.serialization.json.JsonElement",
        "import kotlinx.serialization.json.JsonObject",
        "",
    ]

    emitted: set[str] = set()
    for definition_name, definition in sorted(definitions.items()):
        title = definition.get("title")
        if not title:
            continue
        class_name = pascal_case(title)
        if class_name in emitted:
            continue
        emitted.add(class_name)

        enum_values = definition.get("enum")
        if enum_values and all(isinstance(value, str) for value in enum_values):
            lines.extend(["@Serializable", f"enum class {class_name} {{"])
            varnames = definition.get("x-enum-varnames", [])
            for index, value in enumerate(enum_values):
                enum_name = kotlin_identifier(varnames[index] if index < len(varnames) else pascal_case(value)).replace("`", "")
                if enum_name[0].isdigit():
                    enum_name = f"VALUE_{enum_name}"
                lines.append(f'    @SerialName({json.dumps(value)})')
                lines.append(f"    {enum_name},")
            lines.extend(["}", ""])
            continue

        properties, required, is_union = merged_object_properties(definition)
        if not properties:
            lines.extend(["@Serializable", f"class {class_name}", ""])
            continue

        if is_union:
            required = set()
        lines.extend(["@Serializable", f"data class {class_name}("])
        property_lines: list[str] = []
        for property_name, property_schema in sorted(properties.items()):
            identifier = kotlin_identifier(property_name)
            type_name = field_type(property_schema, definitions, property_name in required)
            serial_name = f'    @SerialName({json.dumps(property_name)})' if identifier.strip("`") != property_name else ""
            if serial_name:
                property_lines.append(serial_name)
            default = "" if property_name in required else " = null"
            property_lines.append(f"    val {identifier}: {type_name}{default},")
        lines.extend(property_lines)
        lines.extend([")", ""])

    return "\n".join(lines) + "\n"


def render_methods(manifest: dict, schema: dict) -> str:
    definitions = schema["$defs"]
    lines = [
        "// Generated by scripts/generate-contract.py. Do not edit by hand.",
        "package io.tether.qvac.sdk.generated",
        "",
        "enum class QvacCallShape {",
        "    REQUEST_REPLY,",
        "    SERVER_STREAM,",
        "    DUPLEX,",
        "}",
        "",
        "data class QvacMethodDescriptor(",
        "    val name: String,",
        "    val callShape: QvacCallShape,",
        "    val requestType: String,",
        "    val responseType: String,",
        "    val progressResponseType: String? = null,",
        "    val progressCondition: String? = null,",
        ")",
        "",
        "object QvacMethods {",
    ]
    for method in manifest["methods"]:
        request_def = definitions[method["requestSchema"].rsplit("/", 1)[-1]]
        response_def = definitions[method["responseSchema"].rsplit("/", 1)[-1]]
        request_type = pascal_case(request_def["title"])
        response_type = pascal_case(response_def["title"])
        shape = {
            "request-reply": "REQUEST_REPLY",
            "server-stream": "SERVER_STREAM",
            "duplex": "DUPLEX",
        }[method["callShape"]]
        progress = method.get("progress")
        progress_type = "null"
        condition = "null"
        if progress:
            progress_def = definitions[progress["responseSchema"].rsplit("/", 1)[-1]]
            progress_type = json.dumps(pascal_case(progress_def["title"]))
            condition = json.dumps(progress["condition"])
        property_name = kotlin_identifier(method["name"])
        lines.extend([
            f"    val {property_name} = QvacMethodDescriptor(",
            f"        name = {json.dumps(method['name'])},",
            f"        callShape = QvacCallShape.{shape},",
            f"        requestType = {json.dumps(request_type)},",
            f"        responseType = {json.dumps(response_type)},",
            f"        progressResponseType = {progress_type},",
            f"        progressCondition = {condition},",
            "    )",
        ])
    lines.extend(["", "    val all: List<QvacMethodDescriptor> = listOf("])
    for method in manifest["methods"]:
        lines.append(f"        {kotlin_identifier(method['name'])},")
    lines.extend(["    )", "}", ""])
    return "\n".join(lines)


def render_typed_methods(manifest: dict, schema: dict) -> str:
    definitions = schema["$defs"]
    lines = [
        "// Generated by scripts/generate-contract.py. Do not edit by hand.",
        "package io.tether.qvac.sdk",
        "",
        "import io.tether.qvac.sdk.generated.*",
        "import kotlinx.coroutines.flow.Flow",
        "",
        "sealed interface QvacProgressEvent<out Progress, out Result> {",
        "    data class Progress<out Progress>(val value: Progress) : QvacProgressEvent<Progress, Nothing>",
        "    data class Result<out Result>(val value: Result) : QvacProgressEvent<Nothing, Result>",
        "}",
        "",
    ]
    for method in manifest["methods"]:
        request_def = definitions[method["requestSchema"].rsplit("/", 1)[-1]]
        response_def = definitions[method["responseSchema"].rsplit("/", 1)[-1]]
        request_type = pascal_case(request_def["title"])
        response_type = pascal_case(response_def["title"])
        name = kotlin_identifier(method["name"])
        if method["callShape"] == "request-reply":
            lines.extend([
                f"suspend fun QvacClient.{name}(request: {request_type}): {response_type} =",
                f"    callTyped(request)",
                "",
            ])
        elif method["callShape"] == "server-stream":
            lines.extend([
                f"fun QvacClient.{name}(request: {request_type}): Flow<{response_type}> =",
                f"    streamTyped(request)",
                "",
            ])
        else:
            lines.extend([
                f"fun QvacClient.{name}(request: {request_type}, input: Flow<ByteArray>): Flow<{response_type}> =",
                f"    duplexTyped(request, input)",
                "",
            ])

        progress = method.get("progress")
        if progress:
            progress_def = definitions[progress["responseSchema"].rsplit("/", 1)[-1]]
            progress_type = pascal_case(progress_def["title"])
            progress_discriminator = progress_def.get("properties", {}).get("type", {}).get("const", progress_type)
            lines.extend([
                f"fun QvacClient.{name}WithProgress(request: {request_type}): Flow<QvacProgressEvent<{progress_type}, {response_type}>> =",
                f"    progressTyped(request, progressType = {json.dumps(progress_discriminator)})",
                "",
            ])
    return "\n".join(lines)


def render_models_registry(catalog: dict) -> str:
    fields = [
        ("name", "String"),
        ("src", "String"),
        ("registryPath", "String"),
        ("registrySource", "String"),
        ("blobCoreKey", "String"),
        ("blobBlockOffset", "Long"),
        ("blobBlockLength", "Long"),
        ("blobByteOffset", "Long"),
        ("modelId", "String"),
        ("expectedSize", "Long"),
        ("sha256Checksum", "String"),
        ("addon", "String"),
        ("engine", "String"),
        ("quantization", "String"),
        ("params", "String"),
    ]
    lines = [
        "// Generated by scripts/generate-contract.py. Do not edit by hand.",
        "package io.tether.qvac.sdk.generated",
        "",
        "data class ModelConstant(",
    ]
    for name, type_name in fields:
        lines.append(f"    val {name}: {type_name},")
    lines.extend([")", "", "object Models {"])
    for constant_name in sorted(catalog):
        entry = catalog[constant_name]
        lines.append(f"    val {kotlin_identifier(constant_name)} = ModelConstant(")
        for field_name, _ in fields:
            value = entry[field_name]
            if isinstance(value, str):
                rendered = json.dumps(value)
            else:
                rendered = str(value)
            lines.append(f"        {field_name} = {rendered},")
        lines.extend(["    )", ""])
    lines.extend(["    val all: List<ModelConstant> = listOf("])
    for constant_name in sorted(catalog):
        lines.append(f"        {kotlin_identifier(constant_name)},")
    lines.extend(["    )", "}", ""])
    return "\n".join(lines)


def render_maps(maps: dict) -> str:
    lines = [
        "// Generated by scripts/generate-contract.py. Do not edit by hand.",
        "package io.tether.qvac.sdk.generated",
        "",
        "object ModelTypeMaps {",
    ]
    for kotlin_name, json_name in [
        ("aliasToCanonical", "aliasToCanonical"),
        ("engineToAddon", "engineToAddon"),
        ("legacyEngineToCanonical", "legacyEngineToCanonical"),
    ]:
        lines.append(f"    val {kotlin_name}: Map<String, String> = mapOf(")
        for key, value in sorted(maps[json_name].items()):
            lines.append(f"        {json.dumps(key)} to {json.dumps(value)},")
        lines.extend(["    )", ""])
    lines.extend(["}", ""])
    return "\n".join(lines)


def render_errors(codes: dict) -> str:
    lines = [
        "// Generated by scripts/generate-contract.py. Do not edit by hand.",
        "package io.tether.qvac.sdk.generated",
        "",
        "object ErrorCodes {",
    ]
    all_entries: list[tuple[str, str, int]] = []
    for group in ("server", "client", "registry"):
        for name, value in sorted(codes[group].items()):
            constant = f"{group.upper()}_{name}"
            lines.append(f"    const val {kotlin_identifier(constant)}: Int = {value}")
            all_entries.append((constant, name, value))
    lines.extend(["", "    val all: Map<String, Int> = mapOf("])
    for constant, name, value in all_entries:
        lines.append(f"        {json.dumps(constant)} to {value},")
    lines.extend(["    )", "", "    val byName: Map<String, List<Int>> = mapOf("])
    names: dict[str, list[int]] = {}
    for _, name, value in all_entries:
        names.setdefault(name, []).append(value)
    for name, values in sorted(names.items()):
        rendered_values = ", ".join(str(value) for value in values)
        lines.append(f"        {json.dumps(name)} to listOf({rendered_values}),")
    lines.extend([
        "    )",
        "",
        "    fun lookup(name: String, reportedCode: Int? = null): Int? {",
        "        val candidates = byName[name] ?: return null",
        "        if (reportedCode != null && reportedCode in candidates) return reportedCode",
        "        return candidates.singleOrNull()",
        "    }",
        "}",
        "",
    ])
    return "\n".join(lines)


def render_version(version: str) -> str:
    return (
        "// Generated by scripts/generate-contract.py. Do not edit by hand.\n"
        "package io.tether.qvac.sdk.generated\n\n"
        f"const val SDK_VERSION: String = {json.dumps(version)}\n"
    )


def render_exception_types(codes: dict) -> str:
    lines = ["// Generated by scripts/generate-contract.py. Do not edit.",
        "package io.tether.qvac.sdk.generated", "", "import io.tether.qvac.sdk.QvacException",
        "import kotlinx.serialization.json.JsonObject", "",
        "sealed class QvacKnownException(name: String, code: Int?, message: String, payload: JsonObject) :",
        "    QvacException(name, code, message, payload) {"]
    entries = []
    for group in ("server", "client", "registry"):
        for key, code in sorted(codes[group].items()):
            typ = group.title() + ''.join(part.title() for part in key.split('_'))
            entries.append((typ, key, code))
            lines += [f"    class {typ}(message: String, payload: JsonObject, reportedCode: Int?) :",
                f"        QvacKnownException({json.dumps(key)}, reportedCode, message, payload)"]
    lines += ["}", "", "internal fun knownException(name: String, code: Int?, message: String, payload: JsonObject): QvacKnownException? = when {"]
    counts = {}
    for _, key, _ in entries:
        counts[key] = counts.get(key, 0) + 1
    for typ, key, code in entries:
        match = f"code == {code}" if counts[key] > 1 else f"(code == null || code == {code})"
        lines += [f"    name == {json.dumps(key)} && {match} -> QvacKnownException.{typ}(message, payload, code)"]
    return '\n'.join(lines + ["    else -> null", "}", ""])


def generated_files() -> dict[str, str]:
    graph = TypeGraph(read_json("schema.json"))
    return {
        "schema/SchemaTypes.kt": graph.render(),
        "schema/SchemaMethods.kt": render_schema_methods(graph, read_json("manifest.json")),
        "ContractModels.kt": render_models(read_json("schema.json")),
        "ContractMethods.kt": render_methods(read_json("manifest.json"), read_json("schema.json")),
        "TypedMethods.kt": render_typed_methods(read_json("manifest.json"), read_json("schema.json")),
        "Models.kt": render_models_registry(read_json("models.json")),
        "ModelTypeMaps.kt": render_maps(read_json("model-type-maps.json")),
        "ErrorCodes.kt": render_errors(read_json("error-codes.json")),
        "QvacErrors.kt": render_exception_types(read_json("error-codes.json")),
        "SdkVersion.kt": render_version(json.loads((CONTRACT_ROOT.parent / "package.json").read_text(encoding="utf-8"))["version"]),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    files = generated_files()
    mismatches: list[str] = []
    if not args.check:
        OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
        for name, content in files.items():
            (OUTPUT_ROOT / name).parent.mkdir(parents=True, exist_ok=True)
            (OUTPUT_ROOT / name).write_text(content, encoding="utf-8")
        return 0
    for name, content in files.items():
        path = OUTPUT_ROOT / name
        if not path.exists() or path.read_text(encoding="utf-8") != content:
            mismatches.append(str(path))
    if mismatches:
        print("Generated Kotlin contract is stale:")
        print("\n".join(mismatches))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
