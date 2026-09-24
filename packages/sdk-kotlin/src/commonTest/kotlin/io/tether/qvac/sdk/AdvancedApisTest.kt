package io.tether.qvac.sdk

import io.tether.qvac.sdk.generated.schema.TranscribeStreamRequest
import io.tether.qvac.sdk.generated.schema.TextToSpeechStreamRequest
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import kotlin.test.*

class AdvancedApisTest {
    @Test fun cancellationAlwaysIncludesTheRequestDiscriminator() = runTest {
        val transport = AdvancedTransport()
        val client = QvacClient(transport)
        try {
            val completion = client.completion.run("model", listOf(QvacMessage.user("hello")))
            assertTrue(completion.cancel())
            // cancel() is a unary call; assert on the last call() payload so the
            // run's background stream pump can't race it on the shared `last`.
            assertEquals("request", transport.lastCall!!.getValue("operation").jsonPrimitive.content)
            assertEquals(completion.requestId, transport.lastCall!!.getValue("requestId").jsonPrimitive.content)
            val translation = client.translation.run("model", "hello", "llamacpp-completion")
            assertTrue(translation.cancel())
            assertEquals("request", transport.lastCall!!.getValue("operation").jsonPrimitive.content)
        } finally { client.close() }
    }

    @Test fun lifecycleAndResourceHelpersUseTheWorkerVocabulary() = runTest {
        val transport = AdvancedTransport()
        val client = QvacClient(transport)
        try {
            client.system.pause()
            assertEquals("suspend", transport.last!!.getValue("type").jsonPrimitive.content)
            client.system.resume()
            assertEquals("resume", transport.last!!.getValue("type").jsonPrimitive.content)
            assertEquals("active", client.system.state().state.toString().lowercase())
        } finally { client.close() }
    }

    @Test fun logsAreColdAndCancellationUnsubscribes() = runTest {
        val transport = AdvancedTransport()
        val client = QvacClient(transport)
        try {
            val logs = client.serverLogs()
            assertFalse(transport.collecting)
            assertEquals("hello", logs.first().message)
            assertFalse(transport.collecting)
            assertEquals("__all__", transport.last!!.getValue("id").jsonPrimitive.content)
        } finally { client.close() }
    }

    @Test fun speechDuplexPreservesInputAndEmitsWithoutAggregating() = runTest {
        val transport = AdvancedTransport()
        val client = QvacClient(transport)
        try {
            val audio = client.speech.transcribeStream(TranscribeStreamRequest(modelId = "asr"), flowOf(byteArrayOf(1, 2))).single()
            assertEquals("hello", audio.text)
            assertContentEquals(byteArrayOf(1, 2), transport.input.single())
            val speech = client.speech.synthesizeStream(TextToSpeechStreamRequest(modelId = "tts"), flowOf("hello".encodeToByteArray())).single()
            assertEquals(listOf(0.5), speech.buffer)
            assertEquals("hello", transport.input.single().decodeToString())
        } finally { client.close() }
    }
}

private class AdvancedTransport : QvacTransport {
    var last: JsonObject? = null
    var lastCall: JsonObject? = null
    var collecting = false
    var input = emptyList<ByteArray>()
    override suspend fun call(payload: JsonObject): JsonObject {
        last = payload
        lastCall = payload
        return buildJsonObject {
            put("type", payload.getValue("type"))
            put("success", true)
            put("cancelled", 1)
            put("state", "active")
        }
    }
    override fun stream(payload: JsonObject): Flow<JsonObject> = flow {
        last = payload
        collecting = true
        try {
            if (payload.getValue("type").jsonPrimitive.content == "loggingStream") {
                emit(buildJsonObject {
                    put("type", "loggingStream"); put("id", "model"); put("level", "info")
                    put("namespace", "sdk:server"); put("timestamp", 1); put("message", "hello")
                })
            }
        } finally { collecting = false }
    }
    override fun duplex(payload: JsonObject, input: Flow<ByteArray>): Flow<JsonObject> = flow {
        last = payload
        this@AdvancedTransport.input = input.toList()
        emit(buildJsonObject {
            put("type", payload.getValue("type")); put("done", true)
            put("text", "hello"); put("buffer", JsonArray(listOf(JsonPrimitive(0.5))))
        })
    }
    override suspend fun close() = Unit
}
