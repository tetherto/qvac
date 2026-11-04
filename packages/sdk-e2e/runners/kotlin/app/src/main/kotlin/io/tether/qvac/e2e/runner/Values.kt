package io.tether.qvac.e2e.runner

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

// Test values stay plain Kotlin, compared as the JS and Python clients do: null, Boolean, Long or
// Double, String, List, Map, and ByteArray for fixtures and media.

/** An optional reference (`$name?`) that resolved to nothing. Dropped from call parameters. */
object Missing {
    override fun toString() = "<missing>"
}

fun fromJson(element: JsonElement?): Any? = when (element) {
    null, JsonNull -> null
    is JsonObject -> element.entries.associateTo(LinkedHashMap()) { (key, value) -> key to fromJson(value) }
    is JsonArray -> element.map(::fromJson)
    is JsonPrimitive -> when {
        element.isString -> element.content
        element.booleanOrNull != null -> element.booleanOrNull
        element.longOrNull != null -> element.longOrNull
        else -> element.doubleOrNull
    }
}

fun toJson(value: Any?): JsonElement = when (value) {
    null, Missing -> JsonNull
    is JsonElement -> value
    is Boolean -> JsonPrimitive(value)
    is Int -> JsonPrimitive(value.toLong())
    is Long -> JsonPrimitive(value)
    is Float -> toJson(value.toDouble())
    // JSON has no NaN or Infinity; JSON.stringify writes null for them, and so does this.
    is Double -> when {
        !value.isFinite() -> JsonNull
        value == Math.rint(value) && kotlin.math.abs(value) < 9.0e15 -> JsonPrimitive(value.toLong())
        else -> JsonPrimitive(value)
    }
    is Number -> JsonPrimitive(value.toDouble())
    is String -> JsonPrimitive(value)
    is ByteArray -> JsonArray(value.map { JsonPrimitive(it.toInt() and 0xFF) })
    is Map<*, *> -> JsonObject(
        value.entries.filter { it.value !== Missing }.associate { (key, item) -> key.toString() to toJson(item) },
    )
    is Iterable<*> -> JsonArray(value.map(::toJson))
    is Array<*> -> JsonArray(value.map(::toJson))
    else -> JsonPrimitive(value.toString())
}

fun isNumber(value: Any?): Boolean = value is Number

fun asDouble(value: Any?): Double? = (value as? Number)?.toDouble()

/** JS's `Number.isInteger`, so 2.0 counts and true does not. */
fun isInteger(value: Any?): Boolean {
    val number = asDouble(value) ?: return false
    return number.isFinite() && number == Math.rint(number)
}

/** A number the way JavaScript's `String(number)` prints it: no trailing `.0`. */
fun jsNumber(value: Double): String =
    if (value.isFinite() && value == Math.rint(value) && kotlin.math.abs(value) < 1e21) {
        value.toLong().toString()
    } else {
        value.toString()
    }

/** JavaScript's `String(value)`. */
fun jsString(value: Any?): String = when (value) {
    null -> "null"
    Missing -> "undefined"
    true -> "true"
    false -> "false"
    is Long, is Int -> value.toString()
    is Number -> jsNumber(value.toDouble())
    is String -> value
    is ByteArray -> value.joinToString(",") { (it.toInt() and 0xFF).toString() }
    is List<*> -> value.joinToString(",") { if (it == null) "" else jsString(it) }
    is Map<*, *> -> "[object Object]"
    else -> value.toString()
}

/** `typeof`, with arrays told apart the way the validators expect. Bytes are a typed array in JS: an object. */
fun jsType(value: Any?): String = when (value) {
    is List<*> -> "array"
    is Boolean -> "boolean"
    is Number -> "number"
    is String -> "string"
    else -> "object"
}

/** Strict equality across the number types JSON decoding can produce, recursively. */
fun jsEquals(left: Any?, right: Any?): Boolean = when {
    left == null || right == null -> left == right
    isNumber(left) && isNumber(right) -> asDouble(left) == asDouble(right)
    left is List<*> && right is List<*> ->
        left.size == right.size && left.indices.all { jsEquals(left[it], right[it]) }
    left is Map<*, *> && right is Map<*, *> ->
        left.keys == right.keys && left.keys.all { jsEquals(left[it], right[it]) }
    left is ByteArray && right is ByteArray -> left.contentEquals(right)
    else -> left == right
}

/** Python-style `repr`, for the messages that quote a value back. */
fun describe(value: Any?): String = when (value) {
    null -> "null"
    is String -> "'$value'"
    is ByteArray -> "<${value.size} bytes>"
    else -> jsString(value).take(200)
}

fun bytesOf(value: Any?): ByteArray = when (value) {
    is ByteArray -> value
    is List<*> -> ByteArray(value.size) { index -> ((value[index] as? Number)?.toInt() ?: 0).toByte() }
    else -> ByteArray(0)
}

/** How much data a value carries, whether it arrived as bytes or as a list. */
fun dataLength(value: Any?): Int = when (value) {
    is ByteArray -> value.size
    is List<*> -> value.size
    else -> 0
}

/** Keep the report small while still comparable across clients (same shape as Python's). */
fun summarise(value: Any?, depth: Int = 0, limit: Int = 64): Any? {
    if (depth > 3) return "…"
    return when (value) {
        null -> null
        is List<*> -> linkedMapOf(
            "kind" to "array",
            "length" to value.size,
            "head" to value.take(8).map { summarise(it, depth + 1, limit) },
        )
        is ByteArray -> linkedMapOf(
            "kind" to "bytes",
            "length" to value.size,
            "head" to value.take(8).joinToString("") { "%02x".format(it.toInt() and 0xFF) },
        )
        is String -> if (value.length <= limit * 8) value else value.take(limit * 8) + "…"
        is Map<*, *> -> value.entries.take(16).associateTo(LinkedHashMap()) { (key, item) ->
            key.toString() to summarise(item, depth + 1, limit)
        }
        is Boolean, is Number -> value
        else -> value.toString()
    }
}

@Suppress("UNCHECKED_CAST")
fun asMap(value: Any?): Map<String, Any?> = value as? Map<String, Any?> ?: emptyMap()

fun asList(value: Any?): List<Any?> = value as? List<Any?> ?: emptyList()
