package io.tether.qvac.sdk

import io.tether.qvac.sdk.generated.schema.HeartbeatRequest
import io.tether.qvac.sdk.generated.schema.StartRpcServerRequest
import io.tether.qvac.sdk.generated.schema.DiscoverRpcServersRequest
import io.tether.qvac.sdk.generated.schema.LoadModelCustomPluginRequest
import io.tether.qvac.sdk.generated.schema.LoadModelRequest
import io.tether.qvac.sdk.generated.schema.LoadModelSrcRequest
import io.tether.qvac.sdk.generated.schema.RpcServerStatusStreamRequest
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.putJsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertFailsWith

class SchemaMethodsTest {
    @Test
    fun unaryMethodSerializesRequestAndResponse() = runTest {
        val transport = TypedRecordingTransport(
            unaryResponse = buildJsonObject {
                put("type", "heartbeat")
                put("number", 7)
            },
        )
        val client = QvacClient(transport)

        val response = client.heartbeat(HeartbeatRequest())

        assertEquals("heartbeat", transport.lastPayload?.get("type")?.toString()?.trim('"'))
        assertEquals(7.0, response.number)
    }

    @Test
    fun progressMethodDecodesProgressAndFinalFrames() = runTest {
        val transport = TypedRecordingTransport(
            streamResponses = flowOf(
                buildJsonObject {
                    put("type", "modelProgress")
                    put("downloadKey", "download")
                    put("downloaded", 50)
                    put("percentage", 50)
                    put("total", 100)
                },
                buildJsonObject {
                    put("type", "loadModel")
                    put("success", true)
                    put("modelId", "model")
                },
            ),
        )
        val client = QvacClient(transport)

        val events = client.loadModelWithProgress(
            LoadModelRequest.LoadModelSrcRequest(
                LoadModelSrcRequest.LoadModelCustomPluginRequest(
                    LoadModelCustomPluginRequest(modelSrc = "registry://model", modelType = "custom-plugin", withProgress = true),
                ),
            ),
        ).toList()

        assertIs<QvacProgressEvent.Progress<*>>(events[0])
        assertIs<QvacProgressEvent.Result<*>>(events[1])
        assertEquals("loadModel", transport.lastPayload?.get("type")?.toString()?.trim('"'))
    }

    @Test
    fun rpcServerStatusStreamPreservesFailuresAndNativeOwnership() = runTest {
        val originalCause = buildJsonObject {
            put("name", "Error")
            put("message", "send failed")
            putJsonObject("cause") { put("message", "link lost") }
        }
        fun status(advertisement: String, recovery: String) = buildJsonObject {
            put("type", "rpcServerStatusStream")
            put("serverId", "owned")
            put("url", "10.0.0.2:50052")
            put("nativeState", "owned")
            put("advertisement", advertisement)
            put("reason", "transport state changed")
            put("recovery", recovery)
            if (advertisement == "failed") {
                putJsonObject("error") {
                    put("type", "error")
                    put("name", "RPC_SERVER_OPERATION_FAILED")
                    put("message", "Advertising failed")
                    put("cause", originalCause)
                    putJsonObject("typedFields") {
                        put("operation", "advertise")
                        put("details", "send failed")
                    }
                }
            }
        }
        val transport = TypedRecordingTransport(
            streamResponses = flowOf(
                status("advertising", "none"),
                status("suspended", "resume"),
                status("failed", "restart"),
            ),
        )
        val events = QvacClient(transport)
            .rpcServerStatusStream(RpcServerStatusStreamRequest(serverId = "owned"))
            .toList()
        assertEquals(
            buildJsonObject { put("type", "rpcServerStatusStream"); put("serverId", "owned") },
            transport.lastPayload,
        )
        val frames = events.map { Json.encodeToJsonElement(it).jsonObject }
        assertEquals(
            listOf("advertising", "suspended", "failed"),
            frames.map { it["advertisement"]?.jsonPrimitive?.content },
        )
        assertEquals(
            listOf("none", "resume", "restart"),
            frames.map { it["recovery"]?.jsonPrimitive?.content },
        )
        assertEquals(
            listOf("owned", "owned", "owned"),
            frames.map { it["nativeState"]?.jsonPrimitive?.content },
        )
        assertEquals(originalCause, frames.last()["error"]?.jsonObject?.get("cause"))
    }

    @Test
    fun explicitLanAddressesReachServingAndDiscoveryInOrder() = runTest {
        val addresses = listOf("10.0.1.2", "10.0.0.2")
        val expected = buildJsonArray { addresses.forEach { add(it) } }
        val serving = TypedRecordingTransport(
            unaryResponse = buildJsonObject {
                put("type", "startRpcServer")
                put("serverId", "selected-interface")
                put("url", "10.0.0.2:50052")
                put("rdmaCapable", false)
            },
        )
        QvacClient(serving).startRpcServer(
            StartRpcServerRequest(
                host = "10.0.0.2",
                allowNonLoopbackHost = true,
                discoveryTopic = "renamed-adapter",
                lanAddresses = addresses,
            ),
        )
        assertEquals("10.0.0.2", serving.lastPayload?.get("host")?.jsonPrimitive?.content)
        assertEquals(expected, serving.lastPayload?.get("lanAddresses"))
        val discovery = TypedRecordingTransport(
            unaryResponse = buildJsonObject {
                put("type", "discoverRpcServers")
                put("servers", buildJsonArray {})
            },
        )
        QvacClient(discovery).discoverRpcServers(
            DiscoverRpcServersRequest(topic = "renamed-adapter", lanAddresses = addresses),
        )
        assertEquals(expected, discovery.lastPayload?.get("lanAddresses"))
    }

    @Test
    fun invalidNetworkSelectionPreservesTheWorkerError() = runTest {
        val refusal = buildJsonObject {
            put("type", "error")
            put("message", "lanAddresses must contain at least one address")
        }
        val transport = TypedRecordingTransport(unaryResponse = refusal)
        val error = assertFailsWith<QvacException> {
            QvacClient(transport).discoverRpcServers(
                DiscoverRpcServersRequest(topic = "selected", lanAddresses = emptyList()),
            )
        }
        assertEquals(buildJsonArray {}, transport.lastPayload?.get("lanAddresses"))
        assertEquals("lanAddresses must contain at least one address", error.message)
        assertEquals(refusal, error.payload)
    }

    private class TypedRecordingTransport(
        private val unaryResponse: JsonObject = JsonObject(emptyMap()),
        private val streamResponses: Flow<JsonObject> = flowOf(),
    ) : QvacTransport {
        var lastPayload: JsonObject? = null

        override suspend fun call(payload: JsonObject): JsonObject {
            lastPayload = payload
            return unaryResponse
        }

        override fun stream(payload: JsonObject): Flow<JsonObject> {
            lastPayload = payload
            return streamResponses
        }

        override fun duplex(payload: JsonObject, input: Flow<ByteArray>): Flow<JsonObject> {
            lastPayload = payload
            return streamResponses
        }

        override suspend fun close() = Unit
    }
}
