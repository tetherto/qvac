package io.tether.qvac.sdk

import io.tether.qvac.sdk.generated.PluginInvokeRequest
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

const val QVAC_VLA_DEFAULT_IMAGE_SIZE = 512

val QvacClient.vla: QvacVla get() = QvacVla(this)

data class QvacVlaHparams(
    val chunkSize: Int,
    val actionDim: Int,
    val maxActionDim: Int,
    val maxStateDim: Int,
    val tokenizerMaxLength: Int,
    val visionImageSize: Int,
    val numCameras: Int? = null,
    val stateInputMode: String? = null,
    val imageInputMode: String? = null,
    val imagePatchElems: Int? = null,
    val selectedEmbodimentTag: String? = null,
    val selectedEmbodimentCatId: Int? = null,
)

data class QvacVlaHparamsResult(
    val hparams: QvacVlaHparams,
    val backendName: String?,
)

data class QvacVlaRunResult(
    val actions: FloatArray,
    val actionDim: Int,
    val chunkSize: Int,
    val stats: JsonObject? = null,
)

sealed interface QvacVlaEmbodiment {
    fun toJson(): JsonElement

    data class Tag(val value: String, val numCameras: Int? = null) : QvacVlaEmbodiment {
        override fun toJson(): JsonElement {
            require(value.isNotBlank() && value.length <= 256) { "VLA embodiment tag must contain 1..256 characters" }
            validateCameraCount(numCameras)
            return if (numCameras == null) JsonPrimitive(value) else buildJsonObject {
                put("tag", value)
                put("numCameras", numCameras)
            }
        }
    }

    data class CategoryId(val value: Int, val numCameras: Int? = null) : QvacVlaEmbodiment {
        override fun toJson(): JsonElement {
            require(value in 0..31) { "VLA embodiment category id must be in 0..31" }
            validateCameraCount(numCameras)
            return if (numCameras == null) JsonPrimitive(value) else buildJsonObject {
                put("catId", value)
                put("numCameras", numCameras)
            }
        }
    }
}

class QvacVla internal constructor(private val client: QvacClient) {
    suspend fun hparams(modelId: String): QvacVlaHparamsResult {
        val result = invoke(
            modelId = modelId,
            handler = "vlaHparams",
            params = buildJsonObject {
                put("type", "vlaHparams")
                put("modelId", modelId)
            },
        ).jsonObject
        return QvacVlaHparamsResult(
            hparams = result.requiredObject("hparams").toVlaHparams(),
            backendName = result["backendName"]?.takeUnless { it is JsonNull }?.jsonPrimitive?.contentOrNull,
        )
    }

    suspend fun run(
        modelId: String,
        images: List<FloatArray>,
        imgWidth: Int,
        imgHeight: Int,
        state: FloatArray,
        tokens: IntArray,
        mask: ByteArray,
        noise: FloatArray? = null,
    ): QvacVlaRunResult {
        require(images.isNotEmpty()) { "VLA requires at least one camera image" }
        require(imgWidth > 0 && imgHeight > 0) { "VLA image width and height must be positive" }
        require(tokens.isNotEmpty()) { "VLA tokens must not be empty" }
        val result = invoke(
            modelId = modelId,
            handler = "vlaRun",
            params = buildJsonObject {
                put("type", "vlaRun")
                put("modelId", modelId)
                put("images", JsonArray(images.map { JsonPrimitive(it.toBase64()) }))
                put("imgWidth", imgWidth)
                put("imgHeight", imgHeight)
                put("state", state.toBase64())
                put("tokens", tokens.toBase64())
                put("mask", Base64.Default.encode(mask))
                noise?.let { put("noise", it.toBase64()) }
            },
        ).jsonObject
        val actionDim = result.requiredInt("actionDim")
        val chunkSize = result.requiredInt("chunkSize")
        if (actionDim <= 0 || chunkSize <= 0) {
            throw QvacFeatureException("VLA returned non-positive action dimensions")
        }
        val actions = result.requiredString("actions").base64ToFloatArray()
        require(actions.size == actionDim * chunkSize) {
            "VLA returned ${actions.size} actions, expected ${actionDim * chunkSize}"
        }
        return QvacVlaRunResult(
            actions = actions,
            actionDim = actionDim,
            chunkSize = chunkSize,
            stats = result["stats"] as? JsonObject,
        )
    }

    suspend fun setEmbodiment(modelId: String, embodiment: QvacVlaEmbodiment): QvacVlaHparams {
        val result = invoke(
            modelId = modelId,
            handler = "vlaSetEmbodiment",
            params = buildJsonObject {
                put("type", "vlaSetEmbodiment")
                put("modelId", modelId)
                put("embodiment", embodiment.toJson())
            },
        ).jsonObject
        return result.requiredObject("hparams").toVlaHparams()
    }

    private suspend fun invoke(modelId: String, handler: String, params: JsonObject): JsonElement =
        client.pluginInvoke(
            PluginInvokeRequest(
                handler = handler,
                modelId = modelId,
                params = params,
                type = "pluginInvoke",
            ),
        ).result
}

enum class QvacVlaImageLayout { HWC, CHW }

fun qvacVlaPadState(state: FloatArray, targetDim: Int = 32): FloatArray {
    require(targetDim > 0) { "VLA target state dimension must be positive" }
    require(state.size <= targetDim) { "VLA state length ${state.size} exceeds target dimension $targetDim" }
    return FloatArray(targetDim).also { state.copyInto(it) }
}

fun qvacVlaPreprocessImage(
    pixels: FloatArray,
    width: Int,
    height: Int,
    size: Int = QVAC_VLA_DEFAULT_IMAGE_SIZE,
    layout: QvacVlaImageLayout = QvacVlaImageLayout.HWC,
    scale: Float? = null,
): FloatArray {
    require(width > 0 && height > 0 && size > 0) { "VLA image dimensions must be positive" }
    require(pixels.size == width * height * 3) {
        "VLA expected ${width * height * 3} pixel values, got ${pixels.size}"
    }
    val normalization = scale?.takeIf { it == 1f || it == 1f / 255f } ?: run {
        var maximum = 0f
        for (index in 0 until min(pixels.size, 256)) maximum = max(maximum, pixels[index])
        if (maximum > 1.001f) 1f / 255f else 1f
    }
    val ratio = max(width.toFloat() / size, height.toFloat() / size)
    val newWidth = max(1, floor(width / ratio).toInt())
    val newHeight = max(1, floor(height / ratio).toInt())
    val padLeft = size - newWidth
    val padTop = size - newHeight
    val xScale = width.toFloat() / newWidth
    val yScale = height.toFloat() / newHeight
    val output = FloatArray(3 * size * size) { -1f }
    val outputPlane = size * size
    val inputPlane = width * height

    for (yy in 0 until newHeight) {
        val yInput = (yy + 0.5f) * yScale - 0.5f
        val y0 = max(0, floor(yInput).toInt())
        val y1 = min(height - 1, y0 + 1)
        val dy = min(1f, max(0f, yInput - y0))
        for (xx in 0 until newWidth) {
            val xInput = (xx + 0.5f) * xScale - 0.5f
            val x0 = max(0, floor(xInput).toInt())
            val x1 = min(width - 1, x0 + 1)
            val dx = min(1f, max(0f, xInput - x0))
            val w00 = (1 - dx) * (1 - dy)
            val w10 = dx * (1 - dy)
            val w01 = (1 - dx) * dy
            val w11 = dx * dy
            val outputIndex = (yy + padTop) * size + xx + padLeft
            for (channel in 0..2) {
                val sample = if (layout == QvacVlaImageLayout.HWC) {
                    val i00 = (y0 * width + x0) * 3 + channel
                    val i10 = (y0 * width + x1) * 3 + channel
                    val i01 = (y1 * width + x0) * 3 + channel
                    val i11 = (y1 * width + x1) * 3 + channel
                    pixels[i00] * w00 + pixels[i10] * w10 + pixels[i01] * w01 + pixels[i11] * w11
                } else {
                    val plane = channel * inputPlane
                    pixels[plane + y0 * width + x0] * w00 +
                        pixels[plane + y0 * width + x1] * w10 +
                        pixels[plane + y1 * width + x0] * w01 +
                        pixels[plane + y1 * width + x1] * w11
                }
                output[channel * outputPlane + outputIndex] = sample * normalization * 2f - 1f
            }
        }
    }
    return output
}

private fun validateCameraCount(count: Int?) {
    require(count == null || count in 1..64) { "VLA camera count must be in 1..64" }
}

private fun JsonObject.toVlaHparams(): QvacVlaHparams {
    val value = QvacVlaHparams(
        chunkSize = requiredInt("chunkSize"),
        actionDim = requiredInt("actionDim"),
        maxActionDim = requiredInt("maxActionDim"),
        maxStateDim = requiredInt("maxStateDim"),
        tokenizerMaxLength = requiredInt("tokenizerMaxLength"),
        visionImageSize = requiredInt("visionImageSize"),
        numCameras = get("numCameras")?.jsonPrimitive?.intOrNull,
        stateInputMode = get("stateInputMode")?.jsonPrimitive?.contentOrNull,
        imageInputMode = get("imageInputMode")?.jsonPrimitive?.contentOrNull,
        imagePatchElems = get("imagePatchElems")?.jsonPrimitive?.intOrNull,
        selectedEmbodimentTag = get("selectedEmbodimentTag")?.jsonPrimitive?.contentOrNull,
        selectedEmbodimentCatId = get("selectedEmbodimentCatId")?.jsonPrimitive?.intOrNull,
    )
    if (
        value.chunkSize < 0 || value.actionDim < 0 || value.maxActionDim < 0 ||
        value.maxStateDim < 0 || value.tokenizerMaxLength < 0 || value.visionImageSize < 0 ||
        (value.imagePatchElems != null && value.imagePatchElems < 0)
    ) {
        throw QvacFeatureException("VLA returned negative hyperparameters")
    }
    if (value.numCameras != null && value.numCameras <= 0) {
        throw QvacFeatureException("VLA returned a non-positive camera count")
    }
    if (value.selectedEmbodimentCatId != null && value.selectedEmbodimentCatId !in 0..31) {
        throw QvacFeatureException("VLA returned an invalid embodiment category id")
    }
    return value
}

private fun JsonObject.requiredInt(name: String) =
    get(name)?.jsonPrimitive?.intOrNull ?: throw QvacFeatureException("VLA response is missing integer '$name'")

private fun JsonObject.requiredString(name: String) =
    get(name)?.jsonPrimitive?.contentOrNull ?: throw QvacFeatureException("VLA response is missing string '$name'")

private fun JsonObject.requiredObject(name: String) =
    get(name) as? JsonObject ?: throw QvacFeatureException("VLA response is missing object '$name'")

@OptIn(ExperimentalEncodingApi::class)
private fun FloatArray.toBase64() = Base64.Default.encode(toLittleEndianBytes { this[it].toRawBits() })

@OptIn(ExperimentalEncodingApi::class)
private fun IntArray.toBase64() = Base64.Default.encode(toLittleEndianBytes { this[it] })

private inline fun <T> T.toLittleEndianBytes(size: T.() -> Int, value: T.(Int) -> Int): ByteArray =
    ByteArray(size() * 4) { byteIndex ->
        val bits = value(byteIndex / 4)
        (bits ushr ((byteIndex % 4) * 8)).toByte()
    }

private fun FloatArray.toLittleEndianBytes(value: FloatArray.(Int) -> Int) =
    toLittleEndianBytes(FloatArray::size, value)

private fun IntArray.toLittleEndianBytes(value: IntArray.(Int) -> Int) =
    toLittleEndianBytes(IntArray::size, value)

@OptIn(ExperimentalEncodingApi::class)
private fun String.base64ToFloatArray(): FloatArray {
    val bytes = Base64.Default.decode(this)
    if (bytes.size % 4 != 0) throw QvacFeatureException("VLA returned an invalid Float32 buffer")
    return FloatArray(bytes.size / 4) { index ->
        val offset = index * 4
        Float.fromBits(
            (bytes[offset].toInt() and 0xff) or
                ((bytes[offset + 1].toInt() and 0xff) shl 8) or
                ((bytes[offset + 2].toInt() and 0xff) shl 16) or
                ((bytes[offset + 3].toInt() and 0xff) shl 24),
        )
    }
}
