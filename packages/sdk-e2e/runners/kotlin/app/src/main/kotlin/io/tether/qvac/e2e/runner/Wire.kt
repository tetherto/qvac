package io.tether.qvac.e2e.runner

import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacException
import io.tether.qvac.sdk.generated.ErrorCodes
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.Base64
import java.util.UUID

/**
 * The SDK's raw request surface in plain values. Payloads mirror the JS client's
 * (packages/sdk/src/client/api), so a cross-client difference points at the SDKs.
 */
class Wire(private val client: QvacClient) {
    suspend fun send(payload: Map<String, Any?>): Map<String, Any?> = asMap(fromJson(client.call(encode(payload))))

    fun stream(payload: Map<String, Any?>): Flow<Map<String, Any?>> =
        client.stream(encode(payload)).map { asMap(fromJson(it)) }

    fun duplex(payload: Map<String, Any?>, input: Flow<ByteArray>): Flow<Map<String, Any?>> =
        client.duplex(encode(payload), input).map { asMap(fromJson(it)) }

    private fun encode(payload: Map<String, Any?>): JsonObject =
        toJson(payload.filterValues { it != null && it !== Missing }) as JsonObject

    companion object {
        private val NOT_DETAILS = setOf("type", "code", "message", "stack", "cause", "typedFields")

        fun requestId(): String = UUID.randomUUID().toString()

        /** A `success: false` reply, as the error the JS client raises for it. */
        fun refusal(name: String, message: String?): QvacException {
            val text = message?.takeIf { it.isNotEmpty() } ?: "request failed"
            val code = ErrorCodes.lookup(name)
            return QvacException(
                errorName = name,
                code = code,
                message = text,
                payload = JsonObject(
                    buildMap {
                        put("name", JsonPrimitive(name))
                        put("message", JsonPrimitive(text))
                        code?.let { put("code", JsonPrimitive(it)) }
                    },
                ),
            )
        }

        fun requireSuccess(response: Map<String, Any?>, name: String, fallback: String? = null): Map<String, Any?> {
            if (response["success"] == false) throw refusal(name, (response["error"] as? String) ?: fallback)
            return response
        }

        /** What a rejection binds: `{ code, message, hasCause, details }`, as every client binds it. */
        fun errorBinding(error: Throwable): Map<String, Any?> {
            val details = LinkedHashMap<String, Any?>()
            var code = ""
            if (error is QvacException) {
                code = error.code?.toString() ?: ""
                // As errorDetails in step-interpreter.ts: envelope fields, plus `typedFields`
                // (e.g. context-overflow token counts) lifted to the top.
                for ((key, value) in error.payload) {
                    if (key in NOT_DETAILS) continue
                    details[key] = fromJson(value)
                }
                (error.payload["typedFields"] as? JsonObject)?.forEach { (key, value) -> details[key] = fromJson(value) }
            }
            return linkedMapOf(
                "code" to code,
                "message" to (error.message ?: error.toString()),
                // The worker's envelope carries the original error's cause, which the JS client keeps.
                "hasCause" to (error.cause != null || (error as? QvacException)?.payload?.get("cause").let { it != null && it !is JsonNull }),
                "details" to details,
            )
        }

        fun base64(data: ByteArray): String = Base64.getEncoder().encodeToString(data)

        /** A path stays a path; bytes travel inline. The `{ type, value }` union the worker reads. */
        fun fileOrBase64(value: Any?): Map<String, Any?> = when (value) {
            is String -> mapOf("type" to "filePath", "value" to value)
            else -> mapOf("type" to "base64", "value" to base64(bytesOf(value)))
        }
    }
}
