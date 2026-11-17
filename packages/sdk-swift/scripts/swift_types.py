"""Schema-to-Swift type graph and the renderers for types and client methods."""
from dataclasses import dataclass, field
import hashlib
import json
import re


def name(value):
    result = re.sub(r"[^a-zA-Z0-9_]", "", value)
    return ("Value" if not result or result[0].isdigit() else "") + result


def lower_camel(value):
    parts = [p for p in re.split(r"[^A-Za-z0-9]+", value) if p]
    if not parts:
        return "value"
    if all(p.isupper() or p.isdigit() for p in parts):
        parts = [p.lower() for p in parts]
    head, rest = parts[0], parts[1:]
    result = head[:1].lower() + head[1:] + "".join(p[:1].upper() + p[1:] for p in rest)
    return ("v" + result) if result[0].isdigit() else result


def literal(value):
    return json.dumps(value, ensure_ascii=False)


def raw_literal(value):
    return '#"' + value + '"#'


# Swift resolves these names to the module's own type before the standard
# library's, so a schema type with one of them is given a prefix.
RESERVED_TYPE_NAMES = {
    "Any", "Array", "Bool", "Codable", "Data", "Date", "Decodable", "Decoder", "Dictionary",
    "Double", "Encodable", "Encoder", "Error", "Float", "Int", "JSONValue", "Optional",
    "Protocol", "Result", "Self", "Sendable", "Set", "String", "Task", "Type", "URL",
}

SUBSCHEMA_MAPS = ("properties", "patternProperties", "$defs")
SUBSCHEMA_LISTS = ("oneOf", "anyOf", "allOf", "prefixItems")
SUBSCHEMAS = ("items", "additionalProperties", "not", "contains", "propertyNames", "if", "then", "else")


def untitled(schema):
    if not isinstance(schema, dict):
        return schema
    result = {}
    for key, value in schema.items():
        if key == "title":
            continue
        if key in SUBSCHEMA_MAPS and isinstance(value, dict):
            result[key] = {k: untitled(v) for k, v in value.items()}
        elif key in SUBSCHEMA_LISTS and isinstance(value, list):
            result[key] = [untitled(v) for v in value]
        elif key in SUBSCHEMAS:
            result[key] = [untitled(v) for v in value] if isinstance(value, list) else untitled(value)
        else:
            result[key] = value
    return result


def fingerprint(schema, path):
    """The contract exporter titles every inline schema after the method it sits
    in, so the same field under two methods differs only in titles; those share
    one type. Matching shapes at different paths stay separate."""
    return json.dumps({"path": path, "shape": untitled(schema)}, sort_keys=True)


@dataclass
class Definition:
    name: str
    schema: dict
    kind: str
    fields: list = field(default_factory=list)
    arms: list = field(default_factory=list)


class TypeGraph:
    def __init__(self, schema, type_names=None):
        self.defs = schema["$defs"]
        self.type_names = type_names or {}
        self.def_ids = {id(value) for value in self.defs.values()}
        self.types = {}
        self.by_shape = {}
        self.roots = {}
        self.candidates = {}
        self.owners = []
        # A shared shape takes the shortest name among the places it appears, so
        # its name does not depend on which method the contract lists first.
        self.surveying = True
        self.visited = set()
        self.preferred = {}
        for key, value in self.defs.items():
            self.resolve(value, value.get("title", key), root=True)
        self.preferred = {shape: min(names, key=lambda n: (len(n), n))
                          for shape, names in self.candidates.items()}
        self.surveying = False
        self.types, self.by_shape = {}, {}
        for key, value in self.defs.items():
            self.roots[key] = self.resolve(value, value.get("title", key), root=True)

    def dereference(self, schema):
        if not isinstance(schema, dict) or "$ref" not in schema:
            return schema
        ref = schema["$ref"]
        if not ref.startswith("#/$defs/"):
            raise ValueError(f"Unsupported reference: {ref}")
        key = ref[len("#/$defs/"):].replace("~1", "/").replace("~0", "~")
        if key not in self.defs:
            raise ValueError(f"Unresolved reference: {ref}")
        return self.defs[key]

    def resolve(self, schema, hint, root=False):
        target = self.dereference(schema)
        if not (isinstance(target, dict) and id(target) in self.def_ids):
            return self.resolve_schema(target, hint, root)
        self.owners.append(name(target.get("title", hint)))
        try:
            return self.resolve_schema(target, hint, root)
        finally:
            self.owners.pop()

    def resolve_schema(self, schema, hint, root):
        if schema is True or schema is False or schema == {}:
            return "JSONValue"
        if not isinstance(schema, dict):
            raise ValueError(f"Unsupported schema at {hint}: {schema}")
        if "allOf" in schema:
            raise ValueError(f"Unnormalized allOf at {hint}; normalize it in the contract exporter")
        typ = schema.get("type")
        if isinstance(typ, list):
            nonnull = [t for t in typ if t != "null"]
            suffix = "?" if "null" in typ else ""
            if len(nonnull) == 0:
                return "JSONValue"
            if len(nonnull) == 1:
                return self.resolve({**schema, "type": nonnull[0]}, hint) + suffix
            return "JSONValue" + suffix
        arms = schema.get("oneOf", schema.get("anyOf"))
        if arms:
            nonnull = [a for a in arms if a.get("type") != "null"]
            if len(nonnull) == 1 and len(nonnull) != len(arms):
                return self.resolve(nonnull[0], hint) + "?"
        primitives = {"string": "String", "integer": "Int", "number": "Double", "boolean": "Bool", "null": "JSONValue"}
        if typ in primitives and (not schema.get("enum") or typ != "string"):
            return primitives[typ]
        if typ == "array":
            return "[" + self.resolve(schema.get("items", {}), hint + "Item") + "]"
        if typ == "object" and schema.get("properties") and schema.get("additionalProperties", False) is not False:
            # Typed but explicitly open, like a tool's JSON Schema `parameters`: a
            # struct would drop every key it does not declare, so keep it whole.
            return "[String: JSONValue]"
        if typ == "object" and not schema.get("properties") and schema.get("additionalProperties", True) is not False:
            additional = schema.get("additionalProperties", {})
            return "[String: " + self.resolve(additional, hint + "Value") + "]"
        kind = "union" if arms else "enum" if schema.get("enum") else "object" if typ == "object" else None
        if kind is None:
            if not schema or set(schema) <= {"description", "title"}:
                return "JSONValue"
            raise ValueError(f"Unsupported shape at {hint}: {schema}")
        candidate = name(schema.get("title", hint))
        if candidate in RESERVED_TYPE_NAMES:
            candidate = "Qvac" + candidate
        owner = self.owners[-1] if self.owners else ""
        path = candidate if id(schema) in self.def_ids else candidate.removeprefix(owner)
        shape = fingerprint(schema, path)
        self.candidates.setdefault(shape, set()).add(candidate)
        if shape in self.by_shape:
            if not self.surveying or (shape, candidate) in self.visited:
                return self.by_shape[shape]
            self.visited.add((shape, candidate))
            typename, definition = candidate, Definition(candidate, schema, kind)
        else:
            self.visited.add((shape, candidate))
            typename = self.preferred.get(shape, candidate)
            if typename in self.types:
                if root:
                    raise ValueError(f"Duplicate root type name: {typename}")
                # Keep existing collision suffixes when fields or enum members change.
                suffix =self.type_names.get(typename, {}).get(kind)
                typename += suffix or hashlib.sha256(shape.encode()).hexdigest()[:8].upper()
                if typename in self.types:
                    raise ValueError(f"Duplicate inline type name: {typename}")
            definition = Definition(typename, schema, kind)
            self.types[typename] = definition
            self.by_shape[shape] = typename
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
                nullable = fieldtype.endswith("?")
                if not required and not nullable:
                    fieldtype += "?"
                definition.fields.append((key, identifier, fieldtype, required, prop))
        elif kind == "union":
            used_variants = set()
            for index, arm in enumerate(arms):
                armtype = self.resolve(arm, typename + f"Variant{index + 1}")
                armschema = self.dereference(arm)
                title = name(armschema.get("title", "")) if isinstance(armschema, dict) else ""
                names = [n for n in (title, armtype if armtype in self.types else "") if n]
                variant = next((n[len(prefix):] for n in names for prefix in (typename, candidate)
                                if n.startswith(prefix) and n != prefix), None)
                if variant is None:
                    variant = armtype if armtype in self.types else f"Variant{index + 1}"
                variant = lower_camel(name(variant or "Value"))
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
        # Structural selection only. Value and range validation stays in the worker.
        result = {k: schema[k] for k in ("type", "const", "enum", "required", "not") if k in schema}
        if "properties" in schema and property_depth < 2:
            result["properties"] = {k: self.shape(v, property_depth + 1, refs) for k, v in schema["properties"].items()}
        for key in ("oneOf", "anyOf"):
            if key in schema:
                result[key] = [self.shape(a, property_depth, refs) for a in schema[key]]
        if "items" in schema:
            result["items"] = self.shape(schema["items"], property_depth + 1, refs)
        return result

    def render(self, header):
        out = [header, "import Foundation", ""]
        for d in self.types.values():
            if d.kind == "object":
                out += render_object(d)
            elif d.kind == "enum":
                out += render_enum(d)
            else:
                out += render_union(d)
            out += [""]
        return "\n".join(out)


def const_default(prop, typ):
    value = prop["const"]
    if typ.rstrip("?") == "Double" and isinstance(value, (int, float)) and not isinstance(value, bool):
        return repr(float(value))
    return literal(value)


def render_object(d):
    if not d.fields:
        return [f"public struct {d.name}: Codable, Sendable, Hashable {{", "    public init() {}", "}"]
    out = [f"public struct {d.name}: Codable, Sendable, Hashable {{"]
    params = []
    for key, identifier, typ, required, prop in d.fields:
        out.append(f"    public var `{identifier}`: {typ}")
        if "const" in prop and required:
            params.append(f"`{identifier}`: {typ} = {const_default(prop, typ)}")
        elif typ.endswith("?") and not required:
            params.append(f"`{identifier}`: {typ} = nil")
        else:
            params.append(f"`{identifier}`: {typ}")
    out += ["", "    public init("]
    out += [f"        {p}," for p in params[:-1]] + [f"        {params[-1]}"]
    out += ["    ) {"]
    out += [f"        self.`{identifier}` = `{identifier}`" for _, identifier, _, _, _ in d.fields]
    out += ["    }", "", "    enum CodingKeys: String, CodingKey {"]
    out += [f"        case `{identifier}` = {literal(key)}" for key, identifier, _, _, _ in d.fields]
    out += ["    }", "", "    public init(from decoder: Decoder) throws {",
            "        let container = try decoder.container(keyedBy: CodingKeys.self)"]
    for _, identifier, typ, required, prop in d.fields:
        base = typ.rstrip("?")
        if "const" in prop and required:
            out.append(f"        self.`{identifier}` = try container.decodeIfPresent({base}.self, forKey: .`{identifier}`) ?? {const_default(prop, typ)}")
        elif not required:
            out.append(f"        self.`{identifier}` = try container.decodeIfPresent({base}.self, forKey: .`{identifier}`)")
        else:
            out.append(f"        self.`{identifier}` = try container.decode({typ}.self, forKey: .`{identifier}`)")
    out += ["    }", "", "    public func encode(to encoder: Encoder) throws {",
            "        var container = encoder.container(keyedBy: CodingKeys.self)"]
    for _, identifier, typ, required, _ in d.fields:
        method = "encode" if required else "encodeIfPresent"
        out.append(f"        try container.{method}(self.`{identifier}`, forKey: .`{identifier}`)")
    out += ["    }", "}"]
    return out


def render_enum(d):
    out = [f"public enum {d.name}: String, Codable, Sendable, Hashable, CaseIterable {{"]
    used = set()
    varnames = d.schema.get("x-enum-varnames", [])
    for i, value in enumerate(d.schema["enum"]):
        identifier = lower_camel(varnames[i] if i < len(varnames) else value)
        if identifier in used:
            raise ValueError(f"Enum collision: {d.name}.{identifier}")
        used.add(identifier)
        out.append(f"    case `{identifier}` = {literal(value)}")
    out.append("}")
    return out


def render_union(d):
    out = [f"public indirect enum {d.name}: Codable, Sendable, Hashable {{"]
    out += [f"    case `{variant}`({typ})" for variant, typ, _ in d.arms]
    shapes = json.dumps([shape for _, _, shape in d.arms], separators=(",", ":"), ensure_ascii=False)
    out += ["", f"    static let wireShapes = JSONValue.wireShapes({raw_literal(shapes)})", "",
            "    public init(from decoder: Decoder) throws {",
            "        let container = try decoder.singleValueContainer()",
            "        switch try selectWireVariant(try container.decode(JSONValue.self), Self.wireShapes) {"]
    for i, (variant, typ, _) in enumerate(d.arms):
        out.append(f"        case {i}: self = .`{variant}`(try container.decode({typ}.self))")
    out += [f'        default: throw DecodingError.dataCorruptedError(in: container, debugDescription: "No matching {d.name} variant")',
            "        }", "    }", "", "    public func encode(to encoder: Encoder) throws {",
            "        var container = encoder.singleValueContainer()", "        switch self {"]
    for variant, _, _ in d.arms:
        out.append(f"        case .`{variant}`(let value): try container.encode(value)")
    out += ["        }", "    }", "}"]
    return out


# Methods whose frames are normalized before they reach callers; the value is a hand-written method on the response type.
RESPONSE_NORMALIZERS = {
    "textToSpeech": "withDecodedPcm",
    "textToSpeechStream": "withDecodedPcm",
}


def render_methods(graph, manifest, header):
    out = [header, "import Foundation", "", "extension QvacClient {"]
    for method in manifest["methods"]:
        request = graph.roots[method["requestSchema"].split("/$defs/")[-1]]
        response = graph.roots[method["responseSchema"].split("/$defs/")[-1]]
        methodname = method["name"]
        shape = method["callShape"]
        normalizer = RESPONSE_NORMALIZERS.get(methodname)
        mapping = f"map: {{ (frame: {response}) in frame.{normalizer}() }}" if normalizer else "map: { $0 }"
        if shape == "request-reply":
            out += [f"    public func `{methodname}`(_ request: {request}) async throws -> {response} {{",
                    "        try await callTyped(request)", "    }"]
        elif shape == "server-stream":
            out += [f"    public func `{methodname}`(_ request: {request}) -> AsyncThrowingStream<{response}, Error> {{",
                    f"        streamTyped(request, {mapping})", "    }"]
        else:
            out += [f"    public func `{methodname}`(_ request: {request}, input: AsyncStream<Data>) -> AsyncThrowingStream<{response}, Error> {{",
                    f"        duplexTyped(request, input: input, {mapping})", "    }"]
        if "progress" in method:
            key = method["progress"]["responseSchema"].split("/$defs/")[-1]
            progress = graph.roots[key]
            discriminator = graph.defs[key]["properties"]["type"]["const"]
            out += ["",
                    f"    public func `{methodname}WithProgress`(_ request: {request}) -> AsyncThrowingStream<QvacProgressEvent<{progress}, {response}>, Error> {{",
                    f"        progressTyped(request, progressType: {literal(discriminator)})", "    }"]
        out += [""]
    out[-1] = "}"
    return "\n".join(out) + "\n"
