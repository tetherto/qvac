package io.tether.qvac.sdk

import io.tether.qvac.sdk.generated.ErrorCodes
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.QvacCallShape
import io.tether.qvac.sdk.generated.QvacMethods
import io.tether.qvac.sdk.generated.SDK_VERSION
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class GeneratedContractTest {
    @Test
    fun generatesEveryManifestOperation() {
        assertEquals(43, QvacMethods.all.size)
        assertEquals(
            setOf(QvacCallShape.REQUEST_REPLY, QvacCallShape.SERVER_STREAM, QvacCallShape.DUPLEX),
            QvacMethods.all.map { it.callShape }.toSet(),
        )
        assertTrue(QvacMethods.all.all { it.requestType.endsWith("Request") })
        assertTrue(QvacMethods.all.all { it.responseType.endsWith("Response") })
    }

    @Test
    fun generatesProgressMetadataForAllProgressOperations() {
        val progressMethods = QvacMethods.all.filter { it.progressResponseType != null }

        assertEquals(
            setOf("downloadAsset", "finetune", "loadModel", "rag"),
            progressMethods.map { it.name }.toSet(),
        )
        assertTrue(progressMethods.all { it.progressCondition != null })
    }

    @Test
    fun generatesModelCatalogAndVersion() {
        assertEquals("0.19.1", SDK_VERSION)
        assertTrue(Models.all.isNotEmpty())
        assertNotNull(Models.QWEN3_600M_INST_Q4)
    }

    @Test
    fun generatedErrorRegistryPreservesCollidingNames() {
        assertEquals(135, ErrorCodes.all.size)
        assertEquals(52002, ErrorCodes.lookup("MODEL_NOT_FOUND", 52002))
        assertEquals(19003, ErrorCodes.lookup("MODEL_NOT_FOUND", 19003))
        assertEquals(null, ErrorCodes.lookup("MODEL_NOT_FOUND"))
        assertEquals(50007, ErrorCodes.all["CLIENT_OCR_FAILED"])
        assertEquals(52412, ErrorCodes.all["SERVER_OCR_FAILED"])
    }
}
