package io.tether.qvac.sdk

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertFailsWith

class QvacWorkerStartExceptionTest {
    @Test
    fun rejectsFailedWorkerInitialization() {
        assertFailsWith<QvacWorkerStartException> {
            requireSuccessfulWorkerControlResponse(
                "configuration",
                buildJsonObject {
                    put("success", false)
                    put("error", "invalid config")
                },
            )
        }
    }

    @Test
    fun acceptsSuccessfulWorkerInitialization() {
        requireSuccessfulWorkerControlResponse(
            "configuration",
            buildJsonObject { put("success", true) },
        )
    }
}
