package io.tether.qvac.sdk.generated.schema

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.*

/** Select by discriminator/required-field structure, never by Kotlin class name.
 * Overlapping anyOf arms use the most specific matching shape, then schema order.
 * Validation of numeric ranges and engine semantics remains in the QVAC worker.
 */
internal fun selectWireVariant(element: JsonElement, shapes: List<JsonObject>): Int =
    shapes.mapIndexed { index, shape -> index to wireShapeScore(element, shape) }
        .filter { it.second >= 0 }.maxByOrNull { it.second }?.first
        ?: throw SerializationException("JSON does not match any QVAC wire variant")

private fun wireShapeScore(value: JsonElement, shape: JsonObject): Int {
    if (shape["not"] == JsonObject(emptyMap())) return -1
    shape["const"]?.let { if (!sameWireLiteral(value, it)) return -1 }
    shape["enum"]?.jsonArray?.let { if (it.none { literal -> sameWireLiteral(value, literal) }) return -1 }
    val types = when (val type = shape["type"]) {
        is JsonArray -> type.map { it.jsonPrimitive.content }
        is JsonPrimitive -> listOf(type.content)
        else -> emptyList()
    }
    if (types.isNotEmpty() && types.none { type ->
        when (type) {
            "null" -> value is JsonNull
            "object" -> value is JsonObject
            "array" -> value is JsonArray
            "string" -> value is JsonPrimitive && value !is JsonNull && value.isString
            "boolean" -> value is JsonPrimitive && !value.isString && value.booleanOrNull != null
            "number" -> value is JsonPrimitive && !value.isString && value.doubleOrNull != null
            "integer" -> value is JsonPrimitive && !value.isString && value.doubleOrNull?.let { it.isFinite() && it % 1.0 == 0.0 } == true
            else -> false
        }
    }) return -1
    var score = if ("const" in shape) 100 else if ("enum" in shape) 10 else 0
    for (union in listOf("oneOf", "anyOf")) {
        shape[union]?.jsonArray?.let { arms ->
            val best = arms.maxOfOrNull { wireShapeScore(value, it.jsonObject) } ?: -1
            if (best < 0) return -1
            score += best
        }
    }
    if (value is JsonObject) {
        val required = shape["required"]?.jsonArray.orEmpty().map { it.jsonPrimitive.content }
        if (required.any { it !in value }) return -1
        score += required.size
        for ((key, child) in shape["properties"]?.jsonObject.orEmpty()) {
            if (key !in value) continue
            val match = wireShapeScore(value.getValue(key), child.jsonObject)
            if (match < 0) return -1
            score += 1 + match
        }
    }
    if (value is JsonArray) shape["items"]?.jsonObject?.let { item ->
        if (value.any { wireShapeScore(it, item) < 0 }) return -1
    }
    return score
}

// JSON Schema treats -1 and -1.0 as the same numeric literal.
private fun sameWireLiteral(value: JsonElement, expected: JsonElement): Boolean {
    if (value == expected) return true
    if (value !is JsonPrimitive || expected !is JsonPrimitive || value.isString || expected.isString) return false
    val actual = value.doubleOrNull ?: return false
    val number = expected.doubleOrNull ?: return false
    return actual.isFinite() && number.isFinite() && actual == number
}
