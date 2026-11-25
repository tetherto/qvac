package io.tether.qvac.e2e.runner

/** The framework's ValidationHelpers, as the Python client ports them. */
object Validation {
    fun validate(result: Any?, expectation: Map<String, Any?>): StepResult = try {
        when (val kind = expectation["validation"]) {
            "contains-all" -> containsAll(result, stringList(expectation["contains"]))
            "contains-any" -> containsAny(result, stringList(expectation["contains"]))
            "regex" -> regex(result, expectation["pattern"].toString())
            "numeric-range" -> numericRange(result, asDouble(expectation["min"]), asDouble(expectation["max"]))
            "type" -> type(result, expectation["expectedType"].toString(), asDouble(expectation["minLength"])?.toInt())
            "throws-error" -> throwsError(result, expectation["errorContains"].toString())
            "function" -> StepResult.incomplete(
                "expectation uses validation: 'function'; a JS closure cannot cross the wire. " +
                    "Migrate it to a named assertion.",
            )
            else -> StepResult.fail("Unknown validation type: $kind")
        }
    } catch (error: Exception) {
        StepResult.fail("Validation error: ${error.message}")
    }

    private fun stringList(value: Any?): List<String> = asList(value).map { it.toString() }

    private fun containsAll(result: Any?, contains: List<String>): StepResult {
        val text = jsString(result).lowercase()
        val missing = contains.filter { it.lowercase() !in text }
        return if (missing.isEmpty()) {
            StepResult.ok(text)
        } else {
            StepResult.fail("Missing required strings: ${missing.joinToString(", ")}. Got: ${text.take(200)}")
        }
    }

    private fun containsAny(result: Any?, contains: List<String>): StepResult {
        val text = jsString(result).lowercase()
        return if (contains.any { it.lowercase() in text }) {
            StepResult.ok(text)
        } else {
            StepResult.fail("None of the required strings found: ${contains.joinToString(", ")}. Got: ${text.take(200)}")
        }
    }

    private fun regex(result: Any?, pattern: String): StepResult {
        val text = jsString(result)
        return if (Regex(pattern).containsMatchIn(text)) {
            StepResult.ok(text)
        } else {
            StepResult.fail("Text does not match pattern $pattern. Got: ${text.take(200)}")
        }
    }

    private fun numericRange(result: Any?, minimum: Double?, maximum: Double?): StepResult {
        // JS `Number(result)`: null, a blank string and false are 0, true is 1.
        val number = when (result) {
            null -> 0.0
            is Boolean -> if (result) 1.0 else 0.0
            is Number -> result.toDouble()
            is String -> result.trim().let { if (it.isEmpty()) 0.0 else it.toDoubleOrNull() ?: Double.NaN }
            else -> Double.NaN
        }
        if (number.isNaN()) return StepResult.fail("Expected number, got: ${jsString(result)}")
        if (minimum != null && number < minimum) {
            return StepResult.fail("Value ${jsNumber(number)} is below minimum ${jsNumber(minimum)}")
        }
        if (maximum != null && number > maximum) {
            return StepResult.fail("Value ${jsNumber(number)} is above maximum ${jsNumber(maximum)}")
        }
        return StepResult.ok(jsNumber(number))
    }

    private fun type(result: Any?, expectedType: String, minLength: Int?): StepResult {
        val actual = jsType(result)
        if (actual != expectedType) return StepResult.fail("Expected $expectedType, got $actual")
        if (expectedType == "array") {
            val size = dataLength(result)
            if (minLength != null && minLength > 0 && size < minLength) {
                return StepResult.fail("Array has $size elements, expected at least $minLength")
            }
            return StepResult.ok("Array with $size elements")
        }
        return StepResult.ok("Type $actual matches")
    }

    private fun throwsError(result: Any?, errorContains: String): StepResult {
        val text = jsString(result).lowercase()
        return if (errorContains.lowercase() in text) {
            StepResult.ok("Error contains expected text: $errorContains")
        } else {
            StepResult.fail("Error does not contain \"$errorContains\". Got: ${jsString(result).take(200)}")
        }
    }
}
