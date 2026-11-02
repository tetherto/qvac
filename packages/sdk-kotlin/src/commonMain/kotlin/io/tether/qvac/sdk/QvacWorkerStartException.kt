package io.tether.qvac.sdk

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

class QvacWorkerStartException(
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause)

fun requireSuccessfulWorkerControlResponse(
    operation: String,
    response: JsonObject,
) {
    val success = response["success"]?.jsonPrimitive?.booleanOrNull
    if (success == true) return
    val detail = response["error"]?.jsonPrimitive?.contentOrNull
        ?: if (success == false) "worker rejected the request" else "worker returned an invalid response"
    throw QvacWorkerStartException("QVAC worker $operation failed: $detail")
}
