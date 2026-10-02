"""Strict schema-to-Kotlin type graph. Rendering is separate from schema traversal.

The existing generated package remains a compatibility surface. This package
provides lossless union arms and nested configurations without breaking callers.
"""
from dataclasses import dataclass, field
import hashlib
import json
import re


def name(value):
    result = re.sub(r"[^a-zA-Z0-9_]", "", value)
    return ("Value" if not result or result[0].isdigit() else "") + result


def literal(value):
    # JSON and Kotlin string escaping differ for interpolation.
    return json.dumps(value, ensure_ascii=False).replace("$", "\\$")


@dataclass
class Definition:
    name: str
    schema: dict
    kind: str
    fields: list = field(default_factory=list)
    arms: list = field(default_factory=list)


class TypeGraph:
    def __init__(self, schema):
        self.defs = schema["$defs"]
        self.types = {}
        self.by_shape = {}
        self.roots = {}
        for key, value in self.defs.items():
            self.roots[key] = self.resolve(value, value.get("title", key), root=True)

    def dereference(self, schema):
        if not isinstance(schema, dict):
            return schema
        if "$ref" not in schema:
            return schema
        ref = schema["$ref"]
        if not ref.startswith("#/$defs/"):
            raise ValueError(f"Unsupported reference: {ref}")
        key = ref[len("#/$defs/"):].replace("~1", "/").replace("~0", "~")
        if key not in self.defs:
            raise ValueError(f"Unresolved reference: {ref}")
        return self.defs[key]

    def resolve(self, schema, hint, root=False):
        schema = self.dereference(schema)
        if schema is True or schema is False or schema == {}:
            # `true`/`false`/`{}` accept-anything or accept-nothing schemas (the
            # latter appears as an array's `items: false` tuple bound) have no
            # single Kotlin type; carry them as an opaque JsonElement.
            return "JsonElement"
        if not isinstance(schema, dict):
            raise ValueError(f"Unsupported schema at {hint}: {schema}")
        if "allOf" in schema:
            raise ValueError(f"Unnormalised allOf at {hint}; normalize in shared contract exporter")
        typ = schema.get("type")
        if isinstance(typ, list):
            nonnull = [t for t in typ if t != "null"]
            suffix = "?" if "null" in typ else ""
            if len(nonnull) == 0:
                return "JsonNull"
            if len(nonnull) == 1:
                return self.resolve({**schema, "type": nonnull[0]}, hint) + suffix
            # A value permitting several primitive JSON types at once (e.g. an
            # enum item that is string|number|boolean) has no single Kotlin
            # type; carry it as an opaque JsonElement rather than failing.
            return "JsonElement" + suffix
        arms = schema.get("oneOf", schema.get("anyOf"))
        if arms:
            nonnull = [a for a in arms if a.get("type") != "null"]
            if len(nonnull) == 1 and len(nonnull) != len(arms):
                return self.resolve(nonnull[0], hint) + "?"
        primitives = {"string": "String", "integer": "Long", "number": "Double", "boolean": "Boolean", "null": "JsonNull"}
        if typ in primitives and (not schema.get("enum") or typ != "string"):
            return primitives[typ]
        if typ == "array":
            return "List<" + self.resolve(schema.get("items", {}), hint + "Item") + ">"
        if typ == "object" and not schema.get("properties") and schema.get("additionalProperties", True) is not False:
            additional = schema.get("additionalProperties", {})
            return "Map<String, " + self.resolve(additional, hint + "Value") + ">"
        kind = "union" if arms else "enum" if schema.get("enum") else "object" if typ == "object" else None
        if kind is None:
            if not schema or set(schema) <= {"description", "title"}:
                return "JsonElement"
            raise ValueError(f"Unsupported shape at {hint}: {schema}")
        fingerprint = json.dumps(schema, sort_keys=True)
        if fingerprint in self.by_shape:
            return self.by_shape[fingerprint]
        typename = name(schema.get("title", hint))
        if typename in self.types:
            # Inline schemas can share a human title but differ in constraints.
            # Stable structural suffixes avoid order-dependent name collisions.
            if root:
                raise ValueError(f"Duplicate root type name: {typename}")
            typename += hashlib.sha256(fingerprint.encode()).hexdigest()[:8].upper()
        definition = Definition(typename, schema, kind)
        self.types[typename] = definition
        self.by_shape[fingerprint] = typename
        if kind == "object":
            identifiers = set()
            for key, prop in schema.get("properties", {}).items():
                if prop.get("not") == {}:
                    if key in schema.get("required", []):
                        raise ValueError(f"Required forbidden property: {typename}.{key}")
                    continue
                identifier = name(key)
                if identifier in identifiers:
                    raise ValueError(f"Property identifier collision in {typename}: {key}")
                identifiers.add(identifier)
                fieldtype = self.resolve(prop, typename + key[:1].upper() + key[1:])
                required = key in schema.get("required", [])
                if not required and not fieldtype.endswith("?"):
                    fieldtype += "?"
                definition.fields.append((key, identifier, fieldtype, required, prop))
        elif kind == "union":
            used_variants = set()
            for index, arm in enumerate(arms):
                armtype = self.resolve(arm, typename + f"Variant{index + 1}")
                variant = armtype.removeprefix(typename) if armtype in self.types else f"Variant{index + 1}"
                if not variant:
                    variant = "Value"
                variant = name(variant)
                if variant in used_variants:
                    raise ValueError(f"Duplicate union arm: {typename}.{variant}")
                used_variants.add(variant)
                definition.arms.append((variant, armtype, self.shape(arm)))
        elif not all(isinstance(v, str) for v in schema["enum"]):
            raise ValueError(f"Non-string enum at {typename}")
        return typename

    def shape(self, schema, property_depth=0, refs=frozenset()):
        ref = schema.get("$ref") if isinstance(schema, dict) else None
        if ref in refs:
            raise ValueError(f"Recursive union selection schema: {ref}")
        if ref:
            refs = refs | {ref}
        schema = self.dereference(schema)
        if schema is True:
            return {}
        # Structural selection only. Value/range validation stays in the worker.
        result = {k: schema[k] for k in ("type", "const", "enum", "required", "not") if k in schema}
        if "properties" in schema and property_depth < 2:
            result["properties"] = {k: self.shape(v, property_depth + 1, refs) for k, v in schema["properties"].items()}
        for key in ("oneOf", "anyOf"):
            if key in schema:
                result[key] = [self.shape(a, property_depth, refs) for a in schema[key]]
        if "items" in schema:
            result["items"] = self.shape(schema["items"], property_depth + 1, refs)
        return result

    def render(self):
        out = ["// Generated by scripts/generate-contract.py. Do not edit.",
               "@file:OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)",
               "package io.tether.qvac.sdk.generated.schema", "",
               "import kotlinx.serialization.*", "import kotlinx.serialization.encoding.*",
               "import kotlinx.serialization.json.*", ""]
        for d in self.types.values():
            if d.kind == "object":
                out += ["@Serializable", f"{'data ' if d.fields else ''}class {d.name}" + ("(" if d.fields else "")]
                for key, identifier, typ, required, prop in d.fields:
                    default = ""
                    if "const" in prop:
                        default = " = " + (literal(prop["const"]) if isinstance(prop["const"], str) else json.dumps(prop["const"]))
                        if typ.rstrip("?") == "Double" and isinstance(prop["const"], (int, float)):
                            default = " = " + repr(float(prop["const"]))
                    elif not required:
                        default = " = null"
                    if "const" in prop:
                        out += ["    @EncodeDefault(EncodeDefault.Mode.ALWAYS)"]
                    out += [f"    @SerialName({literal(key)}) val `{identifier}`: {typ}{default},"]
                if d.fields:
                    out += [")"]
            elif d.kind == "enum":
                out += ["@Serializable", f"enum class {d.name} {{"]
                used = set()
                varnames = d.schema.get("x-enum-varnames", [])
                for i, value in enumerate(d.schema["enum"]):
                    identifier = name(varnames[i] if i < len(varnames) else value.upper())
                    if identifier in used:
                        raise ValueError(f"Enum collision: {d.name}.{identifier}")
                    used.add(identifier)
                    out += [f"    @SerialName({literal(value)}) `{identifier}`,"]
                out += ["}"]
            else:
                out += [f"@Serializable(with = {d.name}Serializer::class)", f"sealed class {d.name} {{"]
                for variant, typ, _ in d.arms:
                    qualified = "io.tether.qvac.sdk.generated.schema." + typ if typ in self.types else typ
                    out += [f"    data class {variant}(val value: {qualified}) : {d.name}()"]
                out += ["}", f"internal object {d.name}Serializer : KSerializer<{d.name}> {{",
                        f"    override val descriptor = kotlinx.serialization.descriptors.buildClassSerialDescriptor({literal(d.name)})",
                        "    private val shapes = listOf("]
                for _, _, shape in d.arms:
                    out += ["        Json.parseToJsonElement(" + literal(json.dumps(shape, separators=(',', ':'))) + ").jsonObject,"]
                out += ["    )", f"    override fun deserialize(decoder: Decoder): {d.name} {{",
                        '        val input = decoder as? JsonDecoder ?: throw SerializationException("QVAC unions require JSON")',
                        "        val element = input.decodeJsonElement()",
                        "        return when (selectWireVariant(element, shapes)) {"]
                for i, (variant, typ, _) in enumerate(d.arms):
                    out += [f"            {i} -> {d.name}.{variant}(input.json.decodeFromJsonElement(serializer<{typ}>(), element))"]
                out += [f'            else -> throw SerializationException("No matching {d.name} variant")', "        }", "    }",
                        f"    override fun serialize(encoder: Encoder, value: {d.name}) {{", "        when (value) {"]
                for variant, typ, _ in d.arms:
                    out += [f"            is {d.name}.{variant} -> encoder.encodeSerializableValue(serializer<{typ}>(), value.value)"]
                out += ["        }", "    }", "}"]
            out += [""]
        return "\n".join(out)


def render_schema_methods(graph, manifest):
    out = ["// Generated by scripts/generate-contract.py. Do not edit.",
           "package io.tether.qvac.sdk", "", "import io.tether.qvac.sdk.generated.schema.*",
           "import kotlinx.coroutines.flow.Flow", ""]
    for method in manifest["methods"]:
        request = "io.tether.qvac.sdk.generated.schema." + graph.roots[method["requestSchema"].split("/$defs/")[-1]]
        response = "io.tether.qvac.sdk.generated.schema." + graph.roots[method["responseSchema"].split("/$defs/")[-1]]
        methodname = method["name"]
        shape = method["callShape"]
        if shape == "request-reply":
            out += [f"suspend fun QvacClient.`{methodname}`(request: {request}): {response} = callTyped(request)"]
        elif shape == "server-stream":
            out += [f"fun QvacClient.`{methodname}`(request: {request}): Flow<{response}> = streamTyped(request)"]
        else:
            out += [f"fun QvacClient.`{methodname}`(request: {request}, input: Flow<ByteArray>): Flow<{response}> = duplexTyped(request, input)"]
        if "progress" in method:
            progress = "io.tether.qvac.sdk.generated.schema." + graph.roots[method["progress"]["responseSchema"].split("/$defs/")[-1]]
            definition = graph.defs[method["progress"]["responseSchema"].split("/$defs/")[-1]]
            discriminator = definition["properties"]["type"]["const"]
            out += [f'fun QvacClient.{methodname}WithProgress(request: {request}): Flow<QvacProgressEvent<{progress}, {response}>> = progressTyped(request, progressType = {literal(discriminator)})']
        out += [""]
    return "\n".join(out)
