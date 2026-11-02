package io.tether.qvac.e2e.runner

/** No assertion ran, as distinct from an assertion whose value was null. */
object NotAsserted

/** The outcome of a step or a test, from the client's side. */
data class StepResult(
    val passed: Boolean,
    val output: String = "",
    val incomplete: Boolean = false,
    val reason: String? = null,
    /** The value the assertion ran against; the cross-client comparison reads it. */
    val assertedValue: Any? = NotAsserted,
) {
    companion object {
        fun ok(output: String = "") = StepResult(passed = true, output = output)

        fun fail(output: String) = StepResult(passed = false, output = output)

        fun incomplete(reason: String) =
            StepResult(passed = false, output = reason, incomplete = true, reason = reason)
    }
}

/**
 * A step could not run. [incomplete] separates a gap in this client (the test applies, the client
 * has not implemented what it needs) from a failure of the SDK under test.
 */
class StepError(message: String, val incomplete: Boolean = false) : Exception(message)
