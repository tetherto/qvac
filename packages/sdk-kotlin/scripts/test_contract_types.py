import json
import unittest
from pathlib import Path
from contract_types import TypeGraph, literal, render_schema_methods


class ContractTypesTest(unittest.TestCase):
    def test_unsupported_composition_fails_loudly(self):
        with self.assertRaisesRegex(ValueError, "allOf"):
            TypeGraph({"$defs": {"A": {"allOf": [{"type": "string"}]}}})

    def test_open_maps_keep_arbitrary_values(self):
        graph = TypeGraph({"$defs": {"A": {"type": "object", "additionalProperties": True}}})
        self.assertEqual("Map<String, JsonElement>", graph.roots["A"])

    def test_unresolved_reference_fails(self):
        with self.assertRaisesRegex(ValueError, "Unresolved"):
            TypeGraph({"$defs": {"A": {"$ref": "#/$defs/missing"}}})

    def test_nested_objects_and_sealed_unions(self):
        graph = TypeGraph({"$defs": {"A": {"title": "A", "oneOf": [
            {"type": "object", "properties": {"type": {"type": "string", "const": "a"}, "config": {"type": "object", "properties": {"threads": {"type": "integer"}}}}, "required": ["type", "config"]},
            {"type": "object", "properties": {"type": {"type": "string", "const": "b"}}, "required": ["type"]}
        ]}}})
        text = graph.render()
        self.assertIn("sealed class A", text)
        self.assertIn("class AVariant1Config", text)
        self.assertIn("serializer<AVariant1>()", text)
        self.assertIn("@EncodeDefault(EncodeDefault.Mode.ALWAYS)", text)

    def test_interpolation_is_escaped(self):
        self.assertEqual('"hello \\$world"', literal("hello $world"))

    def test_entire_current_contract_is_deterministic(self):
        root = Path(__file__).resolve().parents[2] / "sdk" / "contract"
        schema = json.loads((root / "schema.json").read_text())
        graph = TypeGraph(schema)
        for definition in graph.types.values():
            for variant, _, _ in definition.arms:
                self.assertRegex(variant, r"^[A-Za-z_][A-Za-z0-9_]*$")
        self.assertEqual(graph.render(), TypeGraph(schema).render())
        self.assertGreater(len(graph.types), 400)
        methods = render_schema_methods(graph, json.loads((root / "manifest.json").read_text()))
        self.assertIn('progressType = "modelProgress"', methods)
        self.assertNotIn('progressType = "loadModel:progress"', methods)

    def test_forbidden_field_not_exposed(self):
        graph = TypeGraph({"$defs": {"A": {"title": "A", "type": "object", "properties": {"forbidden": {"not": {}}, "ok": {"type": "string"}}}}})
        self.assertNotIn("val `forbidden`", graph.render())

    def test_nullable_required_field_is_nullable(self):
        graph = TypeGraph({"$defs": {"A": {"title": "A", "type": "object", "properties": {"value": {"type": ["string", "null"]}}, "required": ["value"]}}})
        self.assertIn("val `value`: String?", graph.render())


if __name__ == "__main__":
    unittest.main()
