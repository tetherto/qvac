package io.tether.qvac.e2e.runner

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File

/**
 * Kotlin port of the shared step interpreter (packages/test-suite StepInterpreter,
 * runners/python/qvac_e2e/interpreter.py); keep operations, bindings and verdicts in sync.
 */
class Interpreter(
    private val resources: Resources,
    private val calls: Calls,
    /** Extracted fixtures: `<root>/images`, `<root>/audio`, ... */
    private val assetRoot: File,
    private val log: (String) -> Unit,
) {
    private class Pending(val task: Deferred<Outcome>)

    private class Outcome(val value: Any?, val error: Throwable?)

    suspend fun run(
        steps: List<Map<String, Any?>>,
        params: Map<String, Any?>,
        expectation: Map<String, Any?>,
        teardown: List<Map<String, Any?>> = emptyList(),
    ): StepResult = coroutineScope {
        // Evict undeclared models first so a result does not depend on test order.
        val declared = (steps + teardown).filter { "useModel" in it }
            .flatMap { step -> asList(asMap(step["useModel"])["deps"]).map(Any?::toString) }
            .toSet()
        resources.evictAllExcept(declared)

        val scope = Scope(this, mutableMapOf("params" to params))
        val body = try {
            runBody(steps, scope, expectation)
        } catch (cancelled: CancellationException) {
            cleanUp(teardown, scope, expectation)
            throw cancelled
        }
        val failedTeardown = cleanUp(teardown, scope, expectation)
        when {
            failedTeardown == null -> body
            // A body that passed cannot be claimed on a client that could not clean up after it.
            body.passed -> failedTeardown.copy(output = "teardown failed: ${failedTeardown.output}")
            else -> body.copy(output = "${body.output} [teardown also failed: ${failedTeardown.output}]")
        }
    }

    private class Scope(
        val coroutines: CoroutineScope,
        val values: MutableMap<String, Any?>,
        val started: MutableList<Pending> = mutableListOf(),
    ) {
        fun child(name: String, value: Any?) = Scope(coroutines, values.toMutableMap().apply { put(name, value) }, started)
        fun snapshot() = Scope(coroutines, values.toMutableMap(), started)
    }

    private fun failure(error: Throwable): StepResult = when (error) {
        is StepError -> if (error.incomplete) StepResult.incomplete(error.message ?: "") else StepResult.fail(error.message ?: "")
        else -> StepResult.fail("${error::class.simpleName}: ${error.message}")
    }

    private suspend fun runBody(steps: List<Map<String, Any?>>, scope: Scope, expectation: Map<String, Any?>): StepResult {
        val last = try {
            runSteps(steps, scope, expectation)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            return failure(error)
        }
        return last ?: StepResult.fail("test body ran but asserted nothing")
    }

    /**
     * Runs teardown and drains started calls even after a body timeout: a suspended worker or open
     * session would fail every later test. Bounded like the JS consumer's teardown.
     */
    private suspend fun cleanUp(teardown: List<Map<String, Any?>>, scope: Scope, expectation: Map<String, Any?>): StepResult? =
        withContext(NonCancellable) {
            val finished = withTimeoutOrNull(TEARDOWN_TIMEOUT_MS) {
                val failed = runTeardown(teardown, scope, expectation)
                scope.started.forEach { it.task.join() }
                // Wrapped: a clean teardown is null, which a timeout must not be mistaken for.
                Result.success(failed)
            }
            if (finished != null) return@withContext finished.getOrNull()
            scope.started.forEach { it.task.cancel() }
            StepResult.fail("teardown did not finish within ${TEARDOWN_TIMEOUT_MS}ms")
        }

    /** Runs the teardown steps, returning only a failure. */
    private suspend fun runTeardown(steps: List<Map<String, Any?>>, scope: Scope, expectation: Map<String, Any?>): StepResult? {
        if (steps.isEmpty()) return null
        // Teardown that asserts nothing is clean: `resume()` is a restoration, not a claim.
        val result = try {
            runSteps(steps, scope, expectation)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            failure(error)
        }
        return result?.takeIf { !it.passed }
    }

    private suspend fun runSteps(steps: List<Map<String, Any?>>, scope: Scope, expectation: Map<String, Any?>): StepResult? {
        var lastAssert: StepResult? = null
        for (step in steps) {
            val result = runStep(step, scope, expectation) ?: continue
            // The first failing check decides the test; a later passing one must not mask it.
            if (!result.passed) return result
            lastAssert = result
        }
        return lastAssert
    }

    private suspend fun runStep(step: Map<String, Any?>, scope: Scope, expectation: Map<String, Any?>): StepResult? {
        if (step.size != 1) throw StepError("a step must carry exactly one operation, got ${step.keys.sorted()}")
        val (op, raw) = step.entries.first()
        val body = asMap(raw)
        return when (op) {
            "useModel" -> useModel(body, scope)
            "modelSource" -> modelSource(body, scope)
            "asset" -> asset(body, scope)
            "call" -> { scope.values[body["as"]?.toString() ?: "result"] = callValue(body, scope); null }
            "start" -> start(body, scope)
            "settle" -> settle(body, scope)
            "callError" -> callError(body, scope)
            "repeat" -> repeat(body, scope, expectation)
            "project" -> project(body, scope)
            "assert" -> assert(body, scope, expectation)
            "compare" -> compare(body, scope)
            else -> throw StepError("step operation \"$op\" is not implemented by the Kotlin interpreter yet", incomplete = true)
        }
    }

    private fun compare(body: Map<String, Any?>, scope: Scope): StepResult {
        val named = body["named"].toString()
        val comparison = Assertions.comparisons[named]
            ?: throw StepError("named comparison \"$named\" is not in the Kotlin registry", incomplete = true)
        return comparison(resolve(body["left"], scope), resolve(body["right"], scope), asMap(resolve(body["with"] ?: emptyMap<String, Any?>(), scope)))
    }

    private suspend fun callError(body: Map<String, Any?>, scope: Scope): StepResult? {
        val method = body["method"].toString()
        val collect = body["collect"]?.toString()
        if (method !in calls.calls && collect == null) {
            throw StepError("SDK method \"$method\" is not wired into the Kotlin interpreter yet", incomplete = true)
        }
        val params = callParams(body["params"], scope)
        log("callError $method")
        try {
            invoke(method, params, collect)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            // A gap stays incomplete; any other refusal, client-side included, binds as in the JS interpreter.
            if (error is StepError && error.incomplete) throw error
            scope.values[body["as"].toString()] = Wire.errorBinding(error)
            return null
        }
        throw StepError("$method was expected to fail but resolved")
    }

    private suspend fun invoke(method: String, params: Map<String, Any?>, collect: String?): Any? {
        if (collect != null) {
            val fold = calls.streams[method]
                ?: throw StepError("SDK method \"$method\" has no stream fold in the Kotlin interpreter yet", incomplete = true)
            return fold(params, collect)
        }
        val call = calls.calls[method]
            ?: throw StepError("SDK method \"$method\" is not wired into the Kotlin interpreter yet", incomplete = true)
        return call(params)
    }

    private suspend fun repeat(body: Map<String, Any?>, scope: Scope, expectation: Map<String, Any?>): StepResult? {
        val items = resolve(body["over"], scope) as? List<*>
            ?: throw StepError("repeat.over \"${body["over"]}\" did not resolve to a list")
        val steps = asList(body["steps"]).map(::asMap)
        val collected = mutableListOf<Any?>()
        for (item in items) {
            // A child scope per item so bindings cannot leak into the next iteration.
            val inner = scope.child(body["as"].toString(), item)
            val failure = runSteps(steps, inner, expectation)
            if (failure != null && !failure.passed) {
                throw StepError(failure.output.ifEmpty { "repeat iteration failed" }, incomplete = failure.incomplete)
            }
            collected += inner.values[lastBinding(steps) ?: "result"]
        }
        scope.values[body["collectInto"].toString()] = collected
        return null
    }

    private fun asset(body: Map<String, Any?>, scope: Scope): StepResult? {
        val kind = resolve(body["kind"], scope).toString()
        val name = resolve(body["file"], scope).toString()
        val target = body["as"].toString()
        when (kind) {
            "bytes", "tone" -> {
                if (body["form"] == "path") throw StepError(if (kind == "tone") "a synthesized tone has no path" else "synthesized bytes have no path")
                scope.values[target] = if (kind == "tone") Media.synthesizeTone(name) else Media.synthesizeBytes(name)
                return null
            }
        }
        val absolute = assetPath(kind, name)
        when (body["form"]) {
            "path" -> scope.values[target] = absolute.absolutePath
            "text" -> scope.values[target] = absolute.readText(Charsets.UTF_8)
            else -> scope.values[target] = absolute.readBytes()
        }
        return null
    }

    /** A fixture of this kind, contained in its root: the name comes from shared data. */
    fun assetPath(kind: String, name: String): File {
        val root = ASSET_ROOTS[kind] ?: throw StepError("asset kind \"$kind\" is not known to the Kotlin client", incomplete = true)
        val base = File(assetRoot, root).canonicalFile
        val absolute = File(base, name).canonicalFile
        if (absolute != base && !absolute.path.startsWith(base.path + File.separator)) {
            throw StepError("asset \"$name\" resolves outside the \"$kind\" asset root")
        }
        // A missing fixture is a real failure, not a client gap.
        if (!absolute.exists()) throw StepError("asset not found: $absolute")
        return absolute
    }

    private fun modelSource(body: Map<String, Any?>, scope: Scope): StepResult? {
        scope.values[body["as"].toString()] = try {
            resources.sourceOf(resolve(body["dep"], scope).toString())
        } catch (error: UnknownResourceError) {
            throw StepError(error.message ?: "", incomplete = true)
        }
        return null
    }

    private suspend fun useModel(body: Map<String, Any?>, scope: Scope): StepResult? {
        val deps = asList(body["deps"]).map(Any?::toString)
        val modelIds = try {
            deps.map { resources.ensureLoaded(it) }
        } catch (error: UnknownResourceError) {
            throw StepError(error.message ?: "", incomplete = true)
        }
        body["as"]?.toString()?.let { scope.values[it] = if (modelIds.size == 1) modelIds[0] else modelIds }
        // The first declared model is addressable as $model.
        modelIds.firstOrNull()?.let { scope.values.putIfAbsent("model", it) }
        return null
    }

    private suspend fun callValue(body: Map<String, Any?>, scope: Scope): Any? {
        val method = body["method"].toString()
        // Not an SDK call: reload tests evict through the resource manager so it can reload the model.
        if (method == "evictResource") {
            resources.evict(callParams(body["params"], scope)["dep"].toString())
            return mapOf("evicted" to true)
        }
        if (method in SCRATCH) return calls.scratch(method, callParams(body["params"], scope))
        val collect = body["collect"]?.toString()
        if (method !in calls.calls && collect == null) {
            throw StepError("SDK method \"$method\" is not wired into the Kotlin interpreter yet", incomplete = true)
        }
        val params = callParams(body["params"], scope)
        log("call $method")
        return invoke(method, params, collect)
    }

    private suspend fun start(body: Map<String, Any?>, scope: Scope): StepResult? {
        log("start ${body["method"]}")
        val snapshot = scope.snapshot()
        val task = scope.coroutines.async {
            try {
                Outcome(callValue(body, snapshot), null)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                Outcome(null, error)
            }
        }
        val pending = Pending(task)
        scope.values[body["as"].toString()] = pending
        scope.started += pending
        // Long enough for the request to leave before the next step runs.
        delay(START_ON_WIRE_MS)
        return null
    }

    /** Waits for a call begun by `start`, re-raising its rejection here. */
    private suspend fun settle(body: Map<String, Any?>, scope: Scope): StepResult? {
        val handle = resolve(body["of"], scope) as? Pending ?: throw StepError("settle: \"${body["of"]}\" is not a started call")
        val withinMs = asDouble(body["withinMs"])?.toLong()
        // A missed deadline fails the step, but the call is still drained at the end of the run.
        val outcome = if (withinMs == null) outcomeOf(handle.task) else withTimeoutOrNull(withinMs) { outcomeOf(handle.task) }
            ?: throw StepError("${body["of"]} did not settle within ${withinMs}ms")
        val target = body["as"]?.toString() ?: "result"
        if (body["expect"] == "reject") {
            val error = outcome.error ?: throw StepError("${body["of"]} was expected to fail but resolved")
            if (error is StepError && error.incomplete) throw error
            scope.values[target] = Wire.errorBinding(error)
            return null
        }
        outcome.error?.let { throw it }
        scope.values[target] = outcome.value
        return null
    }

    /**
     * A started call's outcome. One cancelled with the body that started it settles as an error, so
     * a teardown that settles it still runs to the end; this coroutine's own cancellation propagates.
     */
    private suspend fun outcomeOf(task: Deferred<Outcome>): Outcome = try {
        task.await()
    } catch (cancelled: CancellationException) {
        currentCoroutineContext().ensureActive()
        Outcome(null, cancelled)
    }

    private fun project(body: Map<String, Any?>, scope: Scope): StepResult? {
        var value = walk(resolve(body["from"], scope), body["path"].toString())
        val join = body["join"]
        if (join != null && value is List<*>) value = value.joinToString(join.toString()) { jsString(it) }
        if (body["count"] == true) {
            if (value !is List<*> && value !is ByteArray) throw StepError("project count: \"${body["path"]}\" is not a list")
            value = dataLength(value)
        }
        scope.values[body["as"].toString()] = value
        return null
    }

    private fun assert(body: Map<String, Any?>, scope: Scope, expectation: Map<String, Any?>): StepResult {
        val value = resolve(body["on"], scope)
        val named = body["named"]?.toString()
        val result = if (named != null) {
            val assertion = Assertions.named[named]
                ?: throw StepError("named assertion \"$named\" is not in the Kotlin registry yet", incomplete = true)
            assertion(value, asMap(resolve(body["with"] ?: emptyMap<String, Any?>(), scope)))
        } else {
            Validation.validate(value, expectation)
        }
        // An optional reference that resolved to nothing is not a value the assertion ran against.
        return if (value === Missing) result else result.copy(assertedValue = value)
    }

    /** Resolve a call's parameters, dropping the ones that resolved to nothing. */
    private fun callParams(params: Any?, scope: Scope): Map<String, Any?> =
        asMap(resolve(params ?: emptyMap<String, Any?>(), scope)).filterValues { it !== Missing }

    /** Replace `$name` / `$params.x` references, recursively. */
    private fun resolve(value: Any?, scope: Scope): Any? = when (value) {
        is String -> when {
            !value.startsWith("$") -> value
            value.endsWith("?") -> try {
                walk(scope.values, value.substring(1, value.length - 1))
            } catch (_: StepError) {
                Missing
            }
            else -> walk(scope.values, value.substring(1))
        }
        is Map<*, *> -> value.entries.associateTo(LinkedHashMap()) { (key, item) -> key.toString() to resolve(item, scope) }
        is List<*> -> value.map { resolve(it, scope) }
        else -> value
    }

    companion object {
        /** Asset family -> directory, mirroring ASSET_ROOTS in the JS and Python clients. */
        val ASSET_ROOTS = mapOf("image" to "images", "audio" to "audio", "document" to "documents", "neural" to "neural")

        private val SCRATCH = setOf("scratchDirectory", "producedFile", "discardScratchDirectory")
        private const val START_ON_WIRE_MS = 50L

        /** Matches DEFAULT_TEARDOWN_TIMEOUT_MS in consumer-base.ts. */
        private const val TEARDOWN_TIMEOUT_MS = 120_000L
        private val INDEX = Regex("""^(.*?)\[(\d+)]$""")
        private val WILDCARD = Regex("""^(.*?)\[\*]$""")

        /** Name the last value a nested step list bound, for `repeat.collectInto`. */
        fun lastBinding(steps: List<Map<String, Any?>>): String? {
            for (step in steps.asReversed()) {
                val (op, raw) = step.entries.firstOrNull() ?: continue
                val body = asMap(raw)
                when (op) {
                    "project", "asset", "modelSource" -> return body["as"]?.toString()
                    "call", "settle" -> return body["as"]?.toString() ?: "result"
                }
            }
            return null
        }

        /** Resolve a dotted path with optional `[i]` indexes and a `[*]` fan-out. */
        fun walk(source: Any?, path: String): Any? {
            var current = source
            val segments = path.split(".")
            for ((position, rawSegment) in segments.withIndex()) {
                WILDCARD.matchEntire(rawSegment)?.let { match ->
                    val name = match.groupValues[1]
                    if (name.isNotEmpty()) current = stepInto(current, name, path)
                    val list = current as? List<*>
                        ?: throw StepError("path \"$path\" used [*] on a ${if (current == null) "null" else jsType(current)}")
                    val rest = segments.drop(position + 1).joinToString(".")
                    return if (rest.isEmpty()) list else list.map { walk(it, rest) }
                }
                var segment = rawSegment
                var index: Int? = null
                INDEX.matchEntire(rawSegment)?.let { match ->
                    segment = match.groupValues[1]
                    index = match.groupValues[2].toInt()
                }
                if (segment.isNotEmpty()) current = stepInto(current, segment, path)
                // Out of range reads as nothing, the way a JS index does.
                index?.let { position ->
                    current = when (val container = current) {
                        is List<*> -> container.getOrNull(position)
                        is ByteArray -> container.getOrNull(position)?.let { it.toInt() and 0xFF }
                        else -> throw StepError("path \"$path\" has no index $position")
                    }
                }
            }
            return current
        }

        private fun stepInto(current: Any?, segment: String, path: String): Any? {
            if (current == null) throw StepError("path \"$path\" walked off a null at \"$segment\"")
            if (current is Map<*, *>) {
                if (segment !in current) throw StepError("path \"$path\" has no \"$segment\"")
                return current[segment]
            }
            if (segment == "length") {
                when (current) {
                    is List<*> -> return current.size
                    is ByteArray -> return current.size
                    is String -> return current.length
                }
            }
            throw StepError("path \"$path\" has no \"$segment\"")
        }
    }
}
