// Kotlin port of packages/sdk/examples/asr/parakeet-unified-coreml.ts.
//
// Transcribe a WAV file with Parakeet Unified and its Core ML encoder sidecar
// (macOS only). The GGUF must be a regenerated Unified artifact. The five
// compiled Core ML files are downloaded through the SDK registry and staged
// beside the GGUF in a temporary directory, which is removed afterwards.
//
// As in TypeScript, `client.speech.transcribe()` returns the joined text, and
// `client.models.info()` / `client.models.download()` take plain arguments and
// return the typed `GetModelInfoResponse` / `DownloadAssetResponse`.
//
// RUN: ./gradlew run -Pexample=TranscriptionParakeetUnifiedCoreml --args="<regenerated-unified-gguf> <16-kHz-wav-file>"

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacDataInput
import io.tether.qvac.sdk.generated.schema.GetModelInfoResponseModelInfo
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.speech
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import kotlin.system.exitProcess
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private const val MODEL_STEM = "parakeet-unified-en-0.6b"
private val COREML_FILES = listOf(
    "PARAKEET_UNIFIED_COREMLDATA" to "analytics/coremldata.bin",
    "PARAKEET_UNIFIED_COREMLDATA_1" to "coremldata.bin",
    "PARAKEET_UNIFIED_METADATA" to "metadata.json",
    "PARAKEET_UNIFIED_MODEL" to "model.mil",
    "PARAKEET_UNIFIED_WEIGHT" to "weights/weight.bin",
)

fun main(args: Array<String>): Unit = runBlocking {
    if (args.size < 2) {
        System.err.println(
            "Usage: ./gradlew run -Pexample=TranscriptionParakeetUnifiedCoreml " +
                "--args=\"<regenerated-unified-gguf> <16-kHz-wav-file>\"",
        )
        exitProcess(1)
    }
    val modelPath = Path.of(args[0])
    val audioPath = args[1]

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    var stagingDir: File? = null
    var modelId: String? = null
    try {
        val (modelSrc, staged) = client.stageModel(modelPath)
        stagingDir = staged
        println("▸ Loading Parakeet Unified with its Core ML encoder sidecar...")
        val loaded = client.models.load(
            source = modelSrc,
            modelType = "parakeet-transcription",
            modelConfig = buildJsonObject { put("useGPU", true) },
        )
        modelId = loaded.modelId ?: error(loaded.error ?: "loadModel failed")

        println("▸ Transcribing audio...")
        val text = client.speech.transcribe(modelId, QvacDataInput.FilePath(audioPath)).text

        if (text.isBlank()) error("Parakeet Unified returned an empty transcription")
        println(text)
    } finally {
        try {
            modelId?.let { client.models.unload(it) }
        } finally {
            stagingDir?.deleteRecursively()
            client.close()
        }
    }
}

private fun checkModel(path: Path) {
    val name = path.fileName.toString()
    require(Regex("""parakeet-unified-en-0\.6b\.(?:f16|q4_0|q8_0)\.gguf""").matches(name)) {
        "Expected a regenerated Unified GGUF, got: $name"
    }

    val header = Files.newInputStream(path).use { it.readNBytes(1024 * 1024) }
    require("parakeet.unified.left_context_frames" in String(header, Charsets.ISO_8859_1)) {
        "Unified GGUF lacks the new streaming metadata: $path"
    }
}

private suspend fun QvacClient.fetchInfo(name: String): GetModelInfoResponseModelInfo = models.info(name).modelInfo

private suspend fun QvacClient.stageModel(path: Path): Pair<String, File> {
    check(System.getProperty("os.name").startsWith("Mac")) { "Core ML requires macOS" }
    checkModel(path)

    val stagingDir = Files.createTempDirectory("qvac-unified-coreml-")
    try {
        val modelSrc = stagingDir.resolve(path.fileName)
        Files.createSymbolicLink(modelSrc, path.toRealPath())
        val bundleDir = stagingDir.resolve("$MODEL_STEM-encoder.mlmodelc")

        for ((name, relativePath) in COREML_FILES) {
            val info = fetchInfo(name)
            if (!info.isCached) {
                if (info.registrySource.isNullOrEmpty() || info.registryPath.isNullOrEmpty()) {
                    error("Registry location missing for $name")
                }
                println("▸ Downloading Core ML $relativePath...")
                models.download("registry://${info.registrySource}/${info.registryPath}")
            }

            val cached = fetchInfo(name)
            val sourcePath = cached.cacheFiles.firstOrNull { it.isCached }?.path
                ?: error("Core ML file is missing from the SDK cache: $name")

            val targetPath = bundleDir.resolve(relativePath)
            Files.createDirectories(targetPath.parent)
            Files.createLink(targetPath, Path.of(sourcePath))
        }

        return modelSrc.toString() to stagingDir.toFile()
    } catch (error: Throwable) {
        stagingDir.toFile().deleteRecursively()
        throw error
    }
}
