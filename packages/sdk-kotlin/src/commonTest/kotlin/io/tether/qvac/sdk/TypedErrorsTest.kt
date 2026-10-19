package io.tether.qvac.sdk

import io.tether.qvac.sdk.generated.QvacKnownException
import kotlinx.serialization.json.*
import kotlin.test.*

class TypedErrorsTest {
    @Test fun knownErrorsAreCatchableWithoutBreakingTheBaseType() {
        val payload = buildJsonObject { put("name", "CONTEXT_OVERFLOW"); put("code", 52421); put("message", "full") }
        val error = QvacException.from(payload)
        assertIs<QvacKnownException.ServerContextOverflow>(error)
        assertEquals(payload, error.payload)
        assertEquals(52421, error.code)
    }
    @Test fun unknownOrMismatchedCodesRemainGenericAndPreserveTheEnvelope() {
        val payload = buildJsonObject { put("name", "CONTEXT_OVERFLOW"); put("code", 999); put("message", "new") }
        assertFalse(QvacException.from(payload) is QvacKnownException)
        assertEquals(payload, QvacException.from(payload).payload)
    }
}
