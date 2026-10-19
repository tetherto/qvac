package io.tether.qvac.sdk

import io.tether.qvac.sdk.generated.ErrorCodes
import io.tether.qvac.sdk.generated.knownException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive

open class QvacException(
    val errorName: String,
    val code: Int?,
    override val message: String,
    val payload: JsonObject,
    cause: Throwable? = null,
) : Exception(message, cause) {
    val knownCode: Int? = ErrorCodes.lookup(errorName, code)

    companion object {
        fun from(payload: JsonObject): QvacException {
            val name = payload["name"]?.jsonPrimitive?.content ?: "QVAC_ERROR"
            val code = payload["code"]?.jsonPrimitive?.intOrNull
            val message = payload["message"]?.jsonPrimitive?.content ?: "QVAC worker error"
            knownException(name, code, message, payload)?.let { return it }
            return QvacException(
                errorName = name,
                code = code,
                message = message,
                payload = payload,
            )
        }
    }
}
