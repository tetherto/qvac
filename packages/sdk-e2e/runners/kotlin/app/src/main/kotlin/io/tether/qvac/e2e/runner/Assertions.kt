package io.tether.qvac.e2e.runner

import java.util.Locale
import kotlin.math.abs
import kotlin.math.max

typealias Assertion = (value: Any?, args: Map<String, Any?>) -> StepResult
typealias Comparison = (left: Any?, right: Any?, args: Map<String, Any?>) -> StepResult

/**
 * Named assertions ported from runners/python/qvac_e2e/assertions.py; keep verdicts and messages
 * identical. A name missing here makes the step incomplete.
 */
object Assertions {
    private fun text(value: Any?): String = if (value == null) "" else jsString(value)

    private fun fields(args: Map<String, Any?>, key: String = "fields"): List<String> =
        asList(args[key]).map { it.toString() }

    private fun number(value: Any?): Double? = if (isNumber(value)) asDouble(value) else null

    private fun lengthIs(value: Any?, args: Map<String, Any?>): StepResult {
        if (value !is List<*>) return StepResult.fail("expected an array, got ${jsType(value)}")
        val expected = asDouble(args["length"])?.toInt() ?: -1
        if (value.size != expected) return StepResult.fail("expected $expected element(s), got ${value.size}")
        return StepResult.ok("${value.size} element(s)")
    }

    private fun lengthAtLeast(value: Any?, args: Map<String, Any?>): StepResult {
        if (value !is List<*>) return StepResult.fail("expected an array, got ${jsType(value)}")
        val minimum = asDouble(args["length"])?.toInt() ?: 0
        if (value.size < minimum) return StepResult.fail("expected at least $minimum, got ${value.size}")
        return StepResult.ok("${value.size} element(s)")
    }

    private fun numbersInRange(value: Any?, args: Map<String, Any?>): StepResult {
        val field = args["field"]?.toString()
        val low = asDouble(args["min"]) ?: 0.0
        val high = asDouble(args["max"]) ?: 1.0
        val integer = args["integer"] == true
        val items = value as? List<*> ?: listOf(value)
        val label = field ?: "value"
        for (item in items) {
            val measured = if (field == null) item else asMap(item)[field]
            val reading = number(measured)
            if (reading == null || reading < low || reading > high) {
                return StepResult.fail("$label is outside [${jsNumber(low)}, ${jsNumber(high)}]: ${describe(measured)}")
            }
            if (integer && !isInteger(measured)) return StepResult.fail("$label is not an integer: ${jsString(measured)}")
        }
        return StepResult.ok("${items.size} value(s) within [${jsNumber(low)}, ${jsNumber(high)}]")
    }

    private fun equalsJoined(value: Any?, args: Map<String, Any?>): StepResult {
        val parts = asList(args["parts"]).map { jsString(it) }
        val expected = parts.joinToString((args["separator"] ?: "\n").toString())
        if (value != expected) return StepResult.fail("expected ${describe(expected)}, got ${describe(value)}")
        return StepResult.ok("${parts.size} part(s) joined")
    }

    private fun framesAre(value: Any?, args: Map<String, Any?>): StepResult {
        val frames = asList(value)
        val expected = asDouble(args["count"])?.toInt() ?: 0
        if (frames.size != expected) return StepResult.fail("expected $expected frame(s), got ${frames.size}")
        val width = asDouble(args["width"])?.toInt() ?: 0
        val height = asDouble(args["height"])?.toInt() ?: 0
        frames.forEachIndexed { index, frame ->
            val dims = Media.frameDimensions(bytesOf(frame)) ?: return StepResult.fail("frame $index is undecodable")
            if (dims != width to height) {
                return StepResult.fail("frame $index is ${dims.first}x${dims.second}, expected ${width}x$height")
            }
        }
        return StepResult.ok("$expected frame(s) at ${width}x$height")
    }

    private fun safetensorsContainer(value: Any?, args: Map<String, Any?>): StepResult {
        val data = bytesOf(value)
        val floor = asDouble(args["minBytes"])?.toInt() ?: 1024
        if (data.size < floor) return StepResult.fail("pack is ${data.size} bytes, expected at least $floor")
        var headerLength = 0L
        for (index in 7 downTo 0) headerLength = (headerLength shl 8) or (data[index].toLong() and 0xFF)
        if (headerLength <= 0 || headerLength + 8 > data.size || data[8].toInt() != 0x7B) {
            return StepResult.fail("not a safetensors container (header length $headerLength)")
        }
        return StepResult.ok("${data.size} bytes, header $headerLength")
    }

    private fun noProgressBatchGaps(value: Any?, @Suppress("UNUSED_PARAMETER") args: Map<String, Any?>): StepResult {
        val events = asList(value)
        if (events.isEmpty()) return StepResult.fail("no progress events received")
        val phases = LinkedHashMap<String, Pair<MutableSet<Any?>, Int>>()
        for (raw in events) {
            val event = raw as? Map<*, *> ?: continue
            val key = (if (event["is_train"] == true) "train" else "val") + ":epoch${jsString(event["current_epoch"])}"
            val total = asDouble(event["total_batches"])?.toInt() ?: 0
            val phase = phases.getOrPut(key) { mutableSetOf<Any?>() to total }
            phase.first.add(event["current_batch"]?.let { asDouble(it) })
            if (total > phase.second) phases[key] = phase.first to total
        }
        val drops = phases.mapNotNull { (key, phase) ->
            if (phase.first.size < phase.second) {
                val received = phase.first.filterNotNull().map { (it as Double).toLong() }.sorted()
                "$key: ${received.size}/${phase.second} (received=[${received.joinToString(",")}])"
            } else {
                null
            }
        }
        if (drops.isNotEmpty()) return StepResult.fail("progress events dropped: ${drops.joinToString("; ")}")
        return StepResult.ok("${events.size} event(s) across ${phases.size} phase(s), no batch gaps")
    }

    private fun sortedAscendingBy(value: Any?, args: Map<String, Any?>): StepResult {
        val items = asList(value)
        val field = args["field"].toString()
        val minimum = asDouble(args["minimum"])?.toInt() ?: 2
        if (items.size < minimum) return StepResult.fail("need at least $minimum element(s), got ${items.size}")
        for (index in 1 until items.size) {
            val current = asDouble(asMap(items[index])[field]) ?: 0.0
            val previous = asDouble(asMap(items[index - 1])[field]) ?: 0.0
            if (current < previous) return StepResult.fail("out of order by $field at index $index")
        }
        return StepResult.ok("${items.size} element(s) in order")
    }

    private fun anyElementPositive(value: Any?, args: Map<String, Any?>): StepResult {
        val items = asList(value)
        val field = args["field"].toString()
        val found = items.count { item -> (number(asMap(item)[field]) ?: 0.0) > 0 }
        if (found == 0) return StepResult.fail("no finite positive $field across ${items.size} element(s)")
        return StepResult.ok("$found of ${items.size} had a positive $field")
    }

    private fun atLeast(value: Any?, args: Map<String, Any?>): StepResult {
        val minimum = asDouble(args["value"]) ?: 0.0
        val reading = number(value) ?: return StepResult.fail("expected a number, got ${describe(value)}")
        if (reading < minimum) return StepResult.fail("expected at least ${jsNumber(minimum)}, got ${jsString(value)}")
        return StepResult.ok(jsString(value))
    }

    private fun isAbsent(value: Any?, @Suppress("UNUSED_PARAMETER") args: Map<String, Any?>): StepResult =
        if (value != null && value !== Missing) StepResult.fail("expected nothing, got ${describe(value)}") else StepResult.ok("(absent)")

    private fun belowBudget(value: Any?, args: Map<String, Any?>): StepResult {
        val budget = asDouble(args["budget"]) ?: 0.0
        val reading = number(value) ?: return StepResult.fail("expected a number, got ${describe(value)}")
        if (reading >= budget) {
            return StepResult.fail(
                "expected fewer than the ${jsNumber(budget)} budgeted (boundary, not prediction cutoff), got ${jsString(value)}",
            )
        }
        return StepResult.ok("${jsString(value)} of ${jsNumber(budget)}")
    }

    private fun atLeastField(value: Any?, args: Map<String, Any?>): StepResult {
        val record = asMap(value)
        val left = number(record[args["field"].toString()])
        val right = number(record[args["atLeast"].toString()])
        if (left == null || right == null) {
            return StepResult.fail(
                "expected numbers, got ${args["field"]}=${describe(record[args["field"].toString()])} " +
                    "${args["atLeast"]}=${describe(record[args["atLeast"].toString()])}",
            )
        }
        if (left < right) {
            return StepResult.fail("expected ${args["field"]} >= ${args["atLeast"]}, got ${jsNumber(left)} < ${jsNumber(right)}")
        }
        return StepResult.ok("${jsNumber(left)} >= ${jsNumber(right)}")
    }

    private fun jsonObjectShape(value: Any?, args: Map<String, Any?>): StepResult {
        val raw = text(value)
        val parsed = try {
            fromJson(kotlinx.serialization.json.Json.parseToJsonElement(raw))
        } catch (error: Exception) {
            return StepResult.fail("not valid JSON: ${error.message}. Output: ${raw.take(200)}")
        }
        if (parsed !is Map<*, *>) {
            return StepResult.fail("expected a JSON object, got ${if (parsed is List<*>) "array" else jsType(parsed)}")
        }
        for ((field, kind) in asMap(args["fields"])) {
            val measured = parsed[field]
            when (kind) {
                "string" -> if (measured !is String || measured.isEmpty()) {
                    return StepResult.fail("$field must be a non-empty string, got ${describe(measured)}")
                }
                "integer" -> if (!isInteger(measured) || measured is Boolean) {
                    return StepResult.fail("$field must be an integer, got ${describe(measured)}")
                }
                "number" -> if (!isNumber(measured)) {
                    return StepResult.fail("$field must be a number, got ${describe(measured)}")
                }
            }
        }
        val exact = asList(args["exactKeys"]).map { it.toString() }
        if (exact.isNotEmpty()) {
            val actual = parsed.keys.map { it.toString() }.sorted()
            val expected = exact.sorted()
            if (actual != expected) {
                return StepResult.fail(
                    "additionalProperties:false violated. Expected exactly [${expected.joinToString(",")}], " +
                        "got [${actual.joinToString(",")}]",
                )
            }
        }
        return StepResult.ok("object with keys [${parsed.keys.joinToString(",")}]")
    }

    private fun pngDimensions(value: Any?, args: Map<String, Any?>): StepResult {
        val raw = if (value is List<*> && value.isNotEmpty() && value.first() !is Number) value.first() else value
        val data = bytesOf(raw)
        val dims = Media.pngDimensions(data) ?: return StepResult.fail("not a valid PNG (${data.size} bytes)")
        val width = asDouble(args["width"])?.toInt() ?: 0
        val height = asDouble(args["height"])?.toInt() ?: 0
        if (dims != width to height) {
            return StepResult.fail("expected ${width}x$height, got ${dims.first}x${dims.second}")
        }
        return StepResult.ok("${dims.first}x${dims.second}")
    }

    private fun nonNegativeNumbers(value: Any?, args: Map<String, Any?>): StepResult {
        val record = asMap(value)
        val names = fields(args)
        for (field in names) {
            val measured = number(record[field])
            if (measured == null || measured < 0) {
                return StepResult.fail("$field is not a non-negative number (got ${describe(record[field])})")
            }
        }
        return StepResult.ok("${names.size} field(s) non-negative")
    }

    private fun fieldsSumTo(value: Any?, args: Map<String, Any?>): StepResult {
        val record = asMap(value)
        val total = fields(args).sumOf { asDouble(record[it]) ?: 0.0 }
        val expected = number(record[args["total"].toString()])
            ?: return StepResult.fail("${args["total"]} is missing from the record")
        val tolerance = max(asDouble(args["minTolerance"]) ?: 2.0, expected * (asDouble(args["ratio"]) ?: 0.01))
        val delta = abs(total - expected)
        if (delta > tolerance) {
            return StepResult.fail(
                "phases sum to ${"%.2f".format(Locale.ROOT, total)}, ${args["total"]}=${jsNumber(expected)}, " +
                    "delta ${"%.2f".format(Locale.ROOT, delta)}ms exceeds ${"%.2f".format(Locale.ROOT, tolerance)}ms",
            )
        }
        return StepResult.ok("phases reconcile within ${"%.2f".format(Locale.ROOT, delta)}ms")
    }

    private fun noPartialDownloads(value: Any?, @Suppress("UNUSED_PARAMETER") args: Map<String, Any?>): StepResult {
        val events = asList(value)
        val partials = events.mapNotNull { it as? Map<*, *> }.filter { event ->
            val total = asDouble(event["total"]) ?: 0.0
            total > 0 && (asDouble(event["downloaded"]) ?: 0.0) < total
        }
        if (partials.isNotEmpty()) {
            val keys = partials.map { jsString(it["downloadKey"]) }.toSet()
            val sample = partials.take(3).joinToString(", ") {
                "${jsString(it["downloadKey"])}@${"%.0f".format(Locale.ROOT, asDouble(it["percentage"]) ?: 0.0)}%"
            }
            return StepResult.fail("re-downloaded ${keys.size} file(s), ${partials.size} partial event(s). First: $sample")
        }
        return StepResult.ok("${events.size} cache-hit notification(s)")
    }

    private fun transcriptSegmentsShape(value: Any?, args: Map<String, Any?>): StepResult {
        val flags = fields(args, "flags")
        if (value !is List<*>) return StepResult.fail("expected an array, got ${jsType(value)}")
        if (value.isEmpty()) return StepResult.fail("expected at least one segment")
        var previousStart = Double.NEGATIVE_INFINITY
        var previousId = Double.NEGATIVE_INFINITY
        value.forEachIndexed { index, raw ->
            val segment = raw as? Map<*, *> ?: return StepResult.fail("segment $index: not an object")
            if (segment["text"] !is String) return StepResult.fail("segment $index: missing/invalid text")
            val start = number(segment["startMs"]) ?: return StepResult.fail("segment $index: missing/invalid startMs")
            val end = number(segment["endMs"]) ?: return StepResult.fail("segment $index: missing/invalid endMs")
            if (end < start) {
                return StepResult.fail("segment $index: endMs ${jsNumber(end)} < startMs ${jsNumber(start)}")
            }
            if (segment["append"] !is Boolean) return StepResult.fail("segment $index: missing/invalid append")
            if (!isInteger(segment["id"]) || segment["id"] is Boolean) {
                return StepResult.fail("segment $index: missing/invalid id")
            }
            for (flag in flags) {
                if (segment[flag] !is Boolean) return StepResult.fail("segment $index: missing/invalid $flag")
            }
            if (start < previousStart) {
                return StepResult.fail("segment $index: out-of-order startMs ${jsNumber(start)} < ${jsNumber(previousStart)}")
            }
            val id = asDouble(segment["id"])!!
            if (id < previousId) {
                return StepResult.fail("segment $index: out-of-order id ${jsNumber(id)} < ${jsNumber(previousId)}")
            }
            previousStart = start
            previousId = id
        }
        val carried = if (flags.isEmpty()) "" else ", all carrying ${flags.joinToString(" / ")}"
        return StepResult.ok("${value.size} segment(s) in order$carried")
    }

    private fun eventTypeCounts(value: Any?, args: Map<String, Any?>): StepResult {
        val counts = sortedMapOf<String, Int>()
        for (event in asList(value)) {
            val kind = asMap(event)["type"]?.toString() ?: "unknown"
            counts[kind] = (counts[kind] ?: 0) + 1
        }
        val summary = counts.entries.joinToString(", ", "{", "}") { "\"${it.key}\": ${it.value}" }
        for ((kind, minimum) in asMap(args["atLeast"])) {
            val floor = asDouble(minimum)?.toInt() ?: 0
            if ((counts[kind] ?: 0) < floor) return StepResult.fail("expected at least $floor $kind event(s), got $summary")
        }
        for (kind in fields(args, "absent")) {
            if ((counts[kind] ?: 0) > 0) return StepResult.fail("$kind event(s) were emitted but must not be: $summary")
        }
        return StepResult.ok(summary)
    }

    private fun eventShape(value: Any?, args: Map<String, Any?>): StepResult {
        val kind = args["type"].toString()
        val equals = asMap(args["equals"])
        val absent = fields(args, "absent")
        for (raw in asList(value)) {
            val event = raw as? Map<*, *> ?: continue
            if (event["type"] != kind) continue
            for ((field, expected) in equals) {
                if (!jsEquals(event[field], expected)) {
                    return StepResult.fail("$kind event has $field=${describe(event[field])}, expected ${describe(expected)}: $event")
                }
            }
            for (field in absent) {
                if (event[field] != null) return StepResult.fail("$kind event must omit $field: $event")
            }
        }
        return StepResult.ok("$kind events well formed")
    }

    private fun containsAll(value: Any?, args: Map<String, Any?>): StepResult {
        val haystack = text(value).lowercase()
        val terms = fields(args, "terms")
        val missing = terms.filter { it.lowercase() !in haystack }
        if (missing.isNotEmpty()) return StepResult.fail("missing $missing in: ${text(value).take(200)}")
        return StepResult.ok("${terms.size} term(s) present")
    }

    private fun containsAny(value: Any?, args: Map<String, Any?>): StepResult {
        val haystack = text(value).lowercase()
        val terms = fields(args, "terms")
        if (terms.none { it.lowercase() in haystack }) return StepResult.fail("none of $terms in: ${text(value).take(200)}")
        return StepResult.ok("matched")
    }

    private fun anyFieldPresent(value: Any?, args: Map<String, Any?>): StepResult {
        val record = asMap(value)
        val names = fields(args)
        val found = names.filter { isPresent(record, it) }
        if (found.isEmpty()) return StepResult.fail("none of ${names.joinToString(", ")} are present")
        return StepResult.ok("${found.joinToString(", ")} present")
    }

    /** A key the record carries, null or not: what JS `record[field] !== undefined` asks. */
    private fun isPresent(record: Map<*, *>, field: String): Boolean = field in record && record[field] !== Missing

    private fun isEmptyText(value: Any?, @Suppress("UNUSED_PARAMETER") args: Map<String, Any?>): StepResult {
        if (value != null && value !is String) return StepResult.fail("expected a string, got ${jsType(value)}")
        val body = value as String? ?: ""
        if (body.isNotBlank()) return StepResult.fail("expected no text, got: ${body.take(120)}")
        return StepResult.ok("(empty)")
    }

    private fun sortedDescendingBy(value: Any?, args: Map<String, Any?>): StepResult {
        val items = asList(value)
        val field = args["field"].toString()
        for (index in 1 until items.size) {
            val current = asDouble(asMap(items[index])[field]) ?: 0.0
            val previous = asDouble(asMap(items[index - 1])[field]) ?: 0.0
            if (current > previous) return StepResult.fail("not sorted by $field at index $index")
        }
        return StepResult.ok("${items.size} element(s) in order")
    }

    private fun sumsTo(value: Any?, args: Map<String, Any?>): StepResult {
        val field = args["field"].toString()
        val total = asList(value).sumOf { asDouble(asMap(it)[field]) ?: 0.0 }
        val expected = asDouble(args["total"]) ?: 1.0
        val tolerance = asDouble(args["tolerance"]) ?: 1e-3
        if (abs(total - expected) > tolerance) {
            return StepResult.fail("$field sums to $total, not within $tolerance of ${jsNumber(expected)}")
        }
        return StepResult.ok("$field sums to $total")
    }

    private fun systemResourcesShape(value: Any?, args: Map<String, Any?>): StepResult {
        val problems = mutableListOf<String>()
        val record = asMap(value)

        fun metric(raw: Any?, label: String): Map<String, Any?> {
            val measured = asMap(raw)
            if (measured["status"] == "supported") {
                if (asMap(measured["provenance"])["source"] == null) problems += "$label has no provenance source"
            } else if ("value" in measured) {
                problems += "$label exposes a value with status ${measured["status"]}"
            }
            return measured
        }

        fun utilization(raw: Any?, label: String) {
            val measured = metric(raw, label)
            val reading = number(measured["value"])
            if (measured["status"] == "supported" && reading != null && (reading < 0 || reading > 1)) {
                problems += "$label is outside 0..1: ${jsNumber(reading)}"
            }
        }

        val capabilities = asMap(record["capabilities"])
        if (record["capabilities"] == null) problems += "capabilities are missing"
        metric(capabilities["cpu"], "capabilities.cpu")
        metric(asMap(capabilities["memory"])["totalBytes"], "capabilities.memory.totalBytes")
        val capabilityGpus = metric(capabilities["gpus"], "capabilities.gpus")
        val rawIdentity = listOf("vendorId", "deviceId", "subsystemId", "revision")
        var capabilityIds: List<String>? = null
        if (capabilityGpus["status"] == "supported") {
            val gpus = asList(capabilityGpus["value"]).map(::asMap)
            capabilityIds = gpus.map { jsString(it["id"]) }
            for (gpu in gpus) {
                if (gpu["id"] == null || gpu["id"] == "") problems += "GPU has no opaque ID"
                for (field in rawIdentity) if (field in gpu) problems += "GPU exposes private identity field $field"
            }
        }

        if (args["sample"] != true) {
            if (record["sample"] != null) problems += "sample returned when it was not requested"
            return if (problems.isEmpty()) StepResult.ok("capabilities valid; sample omitted")
            else StepResult.fail(problems.joinToString("; "))
        }

        val sample = record["sample"]
        if (sample == null) {
            problems += "requested sample is missing"
            return StepResult.fail(problems.joinToString("; "))
        }
        val sampled = asMap(sample)
        utilization(sampled["cpu"], "sample.cpu")
        val memory = asMap(sampled["memory"])
        metric(memory["usedBytes"], "sample.memory.usedBytes")
        metric(memory["totalBytes"], "sample.memory.totalBytes")
        metric(memory["processUsedBytes"], "sample.memory.processUsedBytes")
        val allowance = metric(memory["processAvailableBytes"], "sample.memory.processAvailableBytes")
        if (allowance["status"] == "supported") {
            val reading = number(allowance["value"])
            if (reading != null && reading <= 0) {
                problems += "sample.memory.processAvailableBytes is not positive: ${jsNumber(reading)}"
            }
            val scope = asMap(allowance["provenance"])["scope"]
            if (scope != "process") problems += "sample.memory.processAvailableBytes carries scope $scope"
        } else if (args["platform"] == "ios") {
            problems += "sample.memory.processAvailableBytes is ${allowance["status"]} on iOS"
        }
        val sampleGpus = metric(sampled["gpus"], "sample.gpus")
        if (capabilityIds != null && sampleGpus["status"] == "supported") {
            val gpus = asList(sampleGpus["value"]).map(::asMap)
            if (capabilityIds != gpus.map { jsString(it["id"]) }) problems += "capability and sample GPU IDs do not correlate"
            for (gpu in gpus) {
                val label = "sample.gpus.${jsString(gpu["id"])}"
                utilization(gpu["compute"], "$label.compute")
                utilization(gpu["encode"], "$label.encode")
                utilization(gpu["decode"], "$label.decode")
            }
        }
        return if (problems.isEmpty()) StepResult.ok("capabilities valid; sample valid")
        else StepResult.fail(problems.joinToString("; "))
    }

    private fun textsById(value: Any?, args: Map<String, Any?>): StepResult {
        val byId = asList(value).mapNotNull { it as? Map<*, *> }.associate {
            it["id"] to (asMap(it["final"])["contentText"] as? String ?: "")
        }
        val expected = asMap(args["expect"])
        val anyMode = args["mode"] == "any"
        for ((promptId, raw) in expected) {
            val terms = asList(raw).map { it.toString() }
            val body = byId[promptId] ?: return StepResult.fail("no result for id \"$promptId\": got ${byId.keys}")
            val hits = terms.filter { it.lowercase() in body.lowercase() }
            val failed = if (anyMode) hits.isEmpty() else hits.size != terms.size
            if (failed) {
                val missing = terms.filter { it !in hits }
                return StepResult.fail("\"$promptId\" is missing ${if (anyMode) "any of " else ""}$missing: ${body.take(160)}")
            }
        }
        return StepResult.ok("${expected.size} id(s) matched")
    }

    private fun streamedEachId(value: Any?, args: Map<String, Any?>): StepResult {
        val counts = LinkedHashMap<Any?, Int>()
        for (raw in asList(value)) {
            val item = raw as? Map<*, *> ?: continue
            val promptId = item["id"] ?: continue
            val event = asMap(item["event"])
            if (event["type"] == "contentDelta" && (event["text"] as? String).orEmpty().isNotEmpty()) {
                counts[promptId] = (counts[promptId] ?: 0) + 1
            }
        }
        val missing = asList(args["ids"]).filter { (counts[it] ?: 0) == 0 }
        if (missing.isNotEmpty()) return StepResult.fail("no streamed content for: ${missing.joinToString(", ")}")
        return StepResult.ok("streamed ${counts.values.joinToString("/")} delta(s)")
    }

    private fun noToolCallsFor(value: Any?, args: Map<String, Any?>): StepResult {
        val results = asList(value)
        val ids = asList(args["ids"])
        for (promptId in ids) {
            val calls = results.mapNotNull { it as? Map<*, *> }.firstOrNull { it["id"] == promptId }
                ?.let { asList(asMap(it["final"])["toolCalls"]) }
                ?: emptyList()
            if (calls.isNotEmpty()) {
                val names = calls.joinToString(", ") { jsString(asMap(it)["name"]) }
                return StepResult.fail("\"$promptId\" was expected to make no tool call, made: $names")
            }
        }
        return StepResult.ok("${ids.size} id(s) stayed quiet")
    }

    private fun fieldsPresent(value: Any?, args: Map<String, Any?>): StepResult {
        if (value !is Map<*, *>) return StepResult.fail("expected an object, got ${jsType(value)}")
        val names = fields(args)
        // Key absence, not falsiness: JS checks `=== undefined`, so an explicit null is present.
        val missing = names.filter { it !in value.keys }
        if (missing.isNotEmpty()) return StepResult.fail("missing fields: ${missing.joinToString(", ")}")
        return StepResult.ok("${names.size} field(s) present")
    }

    private fun fieldsMatch(value: Any?, args: Map<String, Any?>): StepResult {
        val left = asMap(value)
        val right = asMap(args["expected"])
        val names = fields(args)
        val mismatched = names.filter { jsString(left[it]) != jsString(right[it]) }
        if (mismatched.isNotEmpty()) {
            return StepResult.fail(mismatched.joinToString("; ") { "$it: ${jsString(left[it])} != ${jsString(right[it])}" })
        }
        return StepResult.ok("${names.size} field(s) match")
    }

    private fun errorIsStructured(value: Any?, @Suppress("UNUSED_PARAMETER") args: Map<String, Any?>): StepResult {
        val error = asMap(value)
        val code = (error["code"] as? String).orEmpty()
        if (code.isEmpty() && error["hasCause"] != true) {
            return StepResult.fail("rejection carried neither a code nor a cause: ${error["message"] ?: "(no message)"}")
        }
        return StepResult.ok("hasCause=${error["hasCause"] == true}, code=${code.ifEmpty { "(none)" }}")
    }

    private fun nonEmptyText(value: Any?, @Suppress("UNUSED_PARAMETER") args: Map<String, Any?>): StepResult {
        if (value !is String) return StepResult.fail("expected a string, got ${jsType(value)}")
        if (value.isBlank()) return StepResult.fail("expected text, got an empty string")
        return StepResult.ok("${value.length} character(s)")
    }

    private fun errorMatches(value: Any?, args: Map<String, Any?>): StepResult {
        val error = asMap(value)
        val message = (error["message"] as? String).orEmpty()
        val expectedCode = args["code"]
        if (expectedCode != null && jsString(error["code"]) != jsString(expectedCode)) {
            return StepResult.fail("expected code ${jsString(expectedCode)}, got ${error["code"]}")
        }
        val contains = args["messageContains"]
        if (contains != null && contains.toString().lowercase() !in message.lowercase()) {
            return StepResult.fail("message does not contain \"$contains\": $message")
        }
        val forbidden = args["messageNotMatching"]
        if (forbidden != null && Regex(forbidden.toString(), RegexOption.IGNORE_CASE).containsMatchIn(message)) {
            return StepResult.fail("message matched the forbidden pattern: $message")
        }
        return StepResult.ok("code=${(error["code"] as? String).orEmpty().ifEmpty { "(none)" }}: ${message.take(120)}")
    }

    private fun toolCallShape(value: Any?, args: Map<String, Any?>): StepResult {
        val calls = asList(value).map(::asMap)
        if (calls.isEmpty()) return StepResult.fail("expected a structured tool call but the model made none")
        val declared = asList(args["declared"]).map { it.toString() }.toSet()
        val valid = calls.filter { it["name"] in declared }
        if (valid.isEmpty()) {
            val got = calls.joinToString(", ") { (it["name"] as? String)?.ifEmpty { null } ?: "<unnamed>" }
            return StepResult.fail(
                "no tool call matched a declared tool. Got: [$got], declared: [${declared.sorted().joinToString(", ")}]",
            )
        }
        val match = valid.firstOrNull { it["name"] == args["name"] }
        if (match != null) {
            val callArgs = asMap(match["arguments"])
            for (key in asList(args["argKeys"]).map { it.toString() }) {
                if (key !in callArgs) {
                    return StepResult.fail("tool call '${args["name"]}' is missing argument '$key': $callArgs")
                }
            }
        }
        return StepResult.ok("tool call(s): " + valid.joinToString(", ") { jsString(it["name"]) })
    }

    private fun textBlockShape(value: Any?, @Suppress("UNUSED_PARAMETER") args: Map<String, Any?>): StepResult {
        val blocks = asList(value)
        blocks.forEachIndexed { index, raw ->
            val block = asMap(raw)
            if (block["text"] !is String) return StepResult.fail("block[$index].text is not a string")
            val bbox = block["bbox"] as? List<*>
            if (bbox == null || bbox.size != 4) return StepResult.fail("block[$index].bbox is not a 4-element array")
            bbox.forEachIndexed { position, coordinate ->
                if (!isNumber(coordinate)) return StepResult.fail("block[$index].bbox[$position] is not a number")
            }
            if (!isNumber(block["confidence"])) return StepResult.fail("block[$index].confidence is not a number")
        }
        return StepResult.ok("${blocks.size} well-formed block(s)")
    }

    private fun timingStatsPresent(value: Any?, args: Map<String, Any?>): StepResult {
        if (value !is Map<*, *>) return StepResult.fail("stats is undefined, expected timing data")
        val field = (args["field"] ?: "totalTime").toString()
        val measured = number(value[field])
        if (measured == null || measured <= 0) {
            return StepResult.fail("expected stats.$field > 0, got ${describe(value[field])}")
        }
        return StepResult.ok("$field=${jsString(value[field])}")
    }

    private fun producedAudio(value: Any?, args: Map<String, Any?>): StepResult {
        val samples = dataLength(value)
        val floor = asDouble(args["minSamples"])?.toInt() ?: 1
        if (samples < floor) return StepResult.fail("expected at least $floor sample(s), got $samples")
        return StepResult.ok("$samples sample(s)")
    }

    private fun isTrue(value: Any?, @Suppress("UNUSED_PARAMETER") args: Map<String, Any?>): StepResult =
        if (value != true) StepResult.fail("expected true, got ${describe(value)}") else StepResult.ok("true")

    private fun positiveIntegers(value: Any?, args: Map<String, Any?>): StepResult {
        val record = asMap(value)
        val names = fields(args)
        for (field in names) {
            val measured = record[field]
            if (!isInteger(measured) || measured is Boolean || asDouble(measured)!! <= 0) {
                return StepResult.fail("$field is not a positive integer (got ${describe(measured)})")
            }
        }
        return StepResult.ok("${names.size} field(s) positive")
    }

    private fun valueIn(value: Any?, args: Map<String, Any?>): StepResult {
        if (value == null && args["allowNull"] == true) return StepResult.ok("null")
        val allowed = asList(args["values"])
        if (allowed.none { jsEquals(it, value) }) return StepResult.fail("${describe(value)} is not one of $allowed")
        return StepResult.ok(jsString(value))
    }

    private fun fieldEquals(value: Any?, args: Map<String, Any?>): StepResult {
        val record = asMap(value)
        val left = record[args["field"].toString()]
        val right = record[args["other"].toString()]
        if (!jsEquals(left, right)) {
            return StepResult.fail("${args["field"]}=${describe(left)} != ${args["other"]}=${describe(right)}")
        }
        return StepResult.ok("${args["field"]} == ${args["other"]}")
    }

    private fun loadedModelInfoShape(value: Any?, args: Map<String, Any?>): StepResult {
        if (value !is Map<*, *>) return StepResult.fail("expected an object, got ${jsType(value)}")
        val checks = linkedMapOf(
            "modelIdMatches" to (value["modelId"] == args["expectedModelId"]),
            "handlersIsList" to (value["handlers"] is List<*>),
            "modelTypePresent" to ((value["modelType"] as? String).orEmpty().isNotEmpty()),
        )
        args["handlerIncludes"]?.let { checks["handlerPresent"] = it in asList(value["handlers"]) }
        val failed = checks.filterValues { !it }.keys
        if (failed.isNotEmpty()) {
            return StepResult.fail(
                "loadedModelInfoShape failed: ${failed.joinToString(", ")} (modelId=${value["modelId"]}, " +
                    "modelType=${value["modelType"]}, handlers=${value["handlers"]})",
            )
        }
        return StepResult.ok("modelType=${value["modelType"]}, handlers=${asList(value["handlers"]).size}")
    }

    private fun emptyArray(value: Any?, @Suppress("UNUSED_PARAMETER") args: Map<String, Any?>): StepResult {
        val valid = value is List<*> && value.isEmpty()
        return if (valid) StepResult.ok("empty PCM") else StepResult.fail("expected empty PCM")
    }

    private fun mossSoundEffect(value: Any?, args: Map<String, Any?>): StepResult {
        val run = asMap(value)
        val pcm = asList(run["pcm"])
        val expected = (asDouble(args["seconds"]) ?: 0.0) * 48000
        val valid = run["done"] == true &&
            asDouble(run["sampleRate"]) == 48000.0 &&
            abs(pcm.size - expected) <= 480 &&
            pcm.all { (asDouble(it) ?: Double.NaN).isFinite() } &&
            pcm.any { asDouble(it) != 0.0 }
        val output = "${pcm.size} samples at ${jsString(run["sampleRate"])} Hz; expected ${jsNumber(expected)}"
        return if (valid) StepResult.ok(output) else StepResult.fail(output)
    }

    val named: Map<String, Assertion> = mapOf(
        "lengthIs" to ::lengthIs,
        "lengthAtLeast" to ::lengthAtLeast,
        "anyFieldPresent" to ::anyFieldPresent,
        "containsAll" to ::containsAll,
        "eventTypeCounts" to ::eventTypeCounts,
        "transcriptSegmentsShape" to ::transcriptSegmentsShape,
        "noPartialDownloads" to ::noPartialDownloads,
        "anyElementPositive" to ::anyElementPositive,
        "sortedAscendingBy" to ::sortedAscendingBy,
        "noProgressBatchGaps" to ::noProgressBatchGaps,
        "framesAre" to ::framesAre,
        "safetensorsContainer" to ::safetensorsContainer,
        "atLeast" to ::atLeast,
        "isAbsent" to ::isAbsent,
        "belowBudget" to ::belowBudget,
        "atLeastField" to ::atLeastField,
        "jsonObjectShape" to ::jsonObjectShape,
        "pngDimensions" to ::pngDimensions,
        "nonNegativeNumbers" to ::nonNegativeNumbers,
        "fieldsSumTo" to ::fieldsSumTo,
        "eventShape" to ::eventShape,
        "containsAny" to ::containsAny,
        "equalsJoined" to ::equalsJoined,
        "isEmptyText" to ::isEmptyText,
        "numbersInRange" to ::numbersInRange,
        "sortedDescendingBy" to ::sortedDescendingBy,
        "sumsTo" to ::sumsTo,
        "systemResourcesShape" to ::systemResourcesShape,
        "textsById" to ::textsById,
        "streamedEachId" to ::streamedEachId,
        "noToolCallsFor" to ::noToolCallsFor,
        "fieldsPresent" to ::fieldsPresent,
        "fieldsMatch" to ::fieldsMatch,
        "errorIsStructured" to ::errorIsStructured,
        "nonEmptyText" to ::nonEmptyText,
        "errorMatches" to ::errorMatches,
        "toolCallShape" to ::toolCallShape,
        "textBlockShape" to ::textBlockShape,
        "timingStatsPresent" to ::timingStatsPresent,
        "producedAudio" to ::producedAudio,
        "isTrue" to ::isTrue,
        "positiveIntegers" to ::positiveIntegers,
        "valueIn" to ::valueIn,
        "fieldEquals" to ::fieldEquals,
        "loadedModelInfoShape" to ::loadedModelInfoShape,
        "emptyArray" to ::emptyArray,
        "mossSoundEffect" to ::mossSoundEffect,
    )

    private fun greaterThan(left: Any?, right: Any?, @Suppress("UNUSED_PARAMETER") args: Map<String, Any?>): StepResult {
        val a = number(left)
        val b = number(right)
        if (a == null || b == null) return StepResult.fail("expected numbers, got ${describe(left)} and ${describe(right)}")
        if (a <= b) return StepResult.fail("expected ${jsNumber(a)} > ${jsNumber(b)}")
        return StepResult.ok("${jsNumber(a)} > ${jsNumber(b)}")
    }

    /** The warm prompt is the cold one minus exactly the primed tokens. */
    private fun prefillReuse(left: Any?, right: Any?, args: Map<String, Any?>): StepResult {
        val values = listOf(left, right, args["primedTokens"])
        val message = values.map { v -> number(v)?.let(::jsNumber) ?: describe(v) }
            .let { (cold, warm, primed) -> "cold=$cold, warm=$warm, primed=$primed" }
        val (cold, warm, primed) = values.map { number(it)?.takeIf(Double::isFinite) ?: return StepResult.fail(message) }
        if (primed <= 0 || warm <= 0 || cold - warm != primed) return StepResult.fail(message)
        return StepResult.ok(message)
    }

    private fun equalStrings(left: Any?, right: Any?, @Suppress("UNUSED_PARAMETER") args: Map<String, Any?>): StepResult {
        val a = jsString(left)
        val b = jsString(right)
        if (a != b) return StepResult.fail("differ:\n  ${describe(a.take(200))}\n  ${describe(b.take(200))}")
        return StepResult.ok("identical, ${a.length} char(s)")
    }

    private fun identicalBytes(left: Any?, right: Any?, @Suppress("UNUSED_PARAMETER") args: Map<String, Any?>): StepResult {
        if (!bytesOf(left).contentEquals(bytesOf(right))) {
            return StepResult.fail(
                "expected identical output, got ${dataLength(left)} and ${dataLength(right)} byte(s) that differ",
            )
        }
        return StepResult.ok("identical, ${dataLength(left)} byte(s)")
    }

    private fun differentBytes(left: Any?, right: Any?, @Suppress("UNUSED_PARAMETER") args: Map<String, Any?>): StepResult {
        if (dataLength(left) == 0 || dataLength(right) == 0) {
            return StepResult.fail("one side produced nothing (${dataLength(left)} and ${dataLength(right)} byte(s))")
        }
        if (bytesOf(left).contentEquals(bytesOf(right))) {
            return StepResult.fail("expected the outputs to differ, they are identical")
        }
        return StepResult.ok("differ, ${dataLength(left)} vs ${dataLength(right)} byte(s)")
    }

    private fun imageDivergesFrom(left: Any?, right: Any?, args: Map<String, Any?>): StepResult {
        val a = bytesOf(left)
        val b = bytesOf(right)
        if (a.isEmpty() || b.isEmpty()) return StepResult.fail("missing output (${a.size} and ${b.size} bytes)")
        val da = Media.pngDimensions(a)
        val db = Media.pngDimensions(b)
        if (da == null || db == null) return StepResult.fail("one of the outputs is not a valid PNG")
        if (da != db) {
            return StepResult.fail(
                "dimensions differ: ${da.first}x${da.second} vs ${db.first}x${db.second} -- the comparison is only " +
                    "meaningful at equal size",
            )
        }
        val longest = max(a.size, b.size)
        var changed = abs(a.size - b.size)
        for (index in 0 until minOf(a.size, b.size)) if (a[index] != b[index]) changed++
        val ratio = changed.toDouble() / longest
        val minimum = asDouble(args["minRatio"]) ?: 0.01
        if (ratio <= minimum) {
            return StepResult.fail(
                "outputs are ${"%.2f".format(Locale.ROOT, ratio * 100)}% apart, at or below the ${"%.2f".format(Locale.ROOT, minimum * 100)}% " +
                    "floor -- the input was probably dropped",
            )
        }
        return StepResult.ok("${"%.2f".format(Locale.ROOT, ratio * 100)}% byte delta")
    }

    private fun lengthRatioAtLeast(left: Any?, right: Any?, args: Map<String, Any?>): StepResult {
        val leftSize = dataLength(left)
        val rightSize = dataLength(right)
        if (leftSize == 0 || rightSize == 0) {
            return StepResult.fail("comparison produced empty output ($leftSize and $rightSize)")
        }
        val minimum = asDouble(args["ratio"]) ?: 1.0
        val ratio = leftSize.toDouble() / rightSize
        if (ratio < minimum) {
            return StepResult.fail("ratio too low: ${"%.2f".format(Locale.ROOT, ratio)} < ${jsNumber(minimum)} ($leftSize vs $rightSize)")
        }
        return StepResult.ok("ratio ${"%.2f".format(Locale.ROOT, ratio)} ($leftSize vs $rightSize)")
    }

    val comparisons: Map<String, Comparison> = mapOf(
        "equalStrings" to ::equalStrings,
        "greaterThan" to ::greaterThan,
        "prefillReuse" to ::prefillReuse,
        "identicalBytes" to ::identicalBytes,
        "differentBytes" to ::differentBytes,
        "lengthRatioAtLeast" to ::lengthRatioAtLeast,
        "imageDivergesFrom" to ::imageDivergesFrom,
    )
}
