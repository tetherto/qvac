// Kotlin port of packages/sdk/examples/abot-world.ts.
//
// ABot-World: build a world from a single image, then walk it. Each step
// generates one block of video under the keys held for it and streams the
// decoded frames.
//
// Runs on the machine hosting the worker; there is no remote route. The default
// 832x480 tier needs >= 20 GB free VRAM on a dedicated GPU (24 GB card in
// practice); pass 448 256 to use the low-VRAM tier, which runs on ~6 GB cards
// well below interactive frame rates.
//
// Kotlin specifics:
//
//   - `client.media.worldScene()` and `client.media.worldStep()` return a
//     `QvacMediaRun` whose `events` Flow carries typed responses: the scene
//     pack arrives as base64 `data` followed by `done` with `stats`; a block
//     arrives as one `data` per frame, then a tick carrying `step` and
//     `totalSteps`, then `done` with `stats`.
//   - Held keys are the generated `WorldStepStreamRequestKeysItem` enum, so an
//     invalid key fails at compile time.
//   - `image` is the base64 of the first frame, not its bytes.
//   - The cancel demo runs the canceller as a child coroutine (`launch`) of
//     `runBlocking`, and a cancelled block surfaces as the typed
//     `QvacKnownException.ServerInferenceCancelled`.
//
// RUN: ./gradlew run -Pexample=AbotWorld --args="<first-frame-image> [prompt] [output-dir] [blocks] [width] [height]"

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.cancel
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.QvacKnownException
import io.tether.qvac.sdk.generated.schema.CancelRequest
import io.tether.qvac.sdk.generated.schema.CancelRequestRequest
import io.tether.qvac.sdk.generated.schema.WorldSceneStreamRequest
import io.tether.qvac.sdk.generated.schema.WorldSceneStreamResponseStats
import io.tether.qvac.sdk.generated.schema.WorldStepStreamRequest
import io.tether.qvac.sdk.generated.schema.WorldStepStreamRequestKeysItem
import io.tether.qvac.sdk.generated.schema.WorldStepStreamResponseStats
import io.tether.qvac.sdk.media
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.qvacRequestId
import java.nio.file.Files
import java.nio.file.Path
import java.util.Base64
import kotlin.system.exitProcess
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

// A scripted walk: forward, forward while looking right, forward, idle.
private val TAPE: List<List<WorldStepStreamRequestKeysItem>> = listOf(
    listOf(WorldStepStreamRequestKeysItem.W),
    listOf(WorldStepStreamRequestKeysItem.W, WorldStepStreamRequestKeysItem.L),
    listOf(WorldStepStreamRequestKeysItem.W),
    emptyList(),
)

fun main(args: Array<String>): Unit = runBlocking {
    val firstFramePath = args.getOrNull(0)
    val prompt = args.getOrNull(1) ?: "| unknown | A realistic outdoor world scene with a navigable path."
    val outputDir = Path.of(args.getOrNull(2) ?: ".")
    val blocks = args.getOrNull(3)?.toInt() ?: 8
    val width = args.getOrNull(4)?.toLong() ?: 832
    val height = args.getOrNull(5)?.toLong() ?: 480

    if (firstFramePath.isNullOrEmpty()) {
        System.err.println("✖ first frame image path is required")
        System.err.println(
            "Usage: ./gradlew run -Pexample=AbotWorld " +
                "--args=\"<firstFrameImage> [prompt] [outputDir] [blocks] [width] [height]\"",
        )
        exitProcess(1)
    }

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        println("▸ Loading ABot-World session (DiT + taehv + scene encoders)...")
        val loaded = client.models.load(
            source = Models.ABOT_WORLD_0_5B_Q8_0.src,
            modelType = "sdcpp-generation",
            modelConfig = buildJsonObject {
                put("mode", "world")
                // Two different VAEs, and the names are close enough to swap
                // by accident:
                //   taehvModelSrc -- taew2_2, the tiny STREAMING decoder.
                //     Turns each block's latents into pixels during the walk.
                //     Used by every worldStep.
                //   vaeModelSrc   -- the full-precision Wan2.2 VAE. ENCODES
                //     the first frame during the scene stream, and is not
                //     touched again after that.
                // Swapping them loads at first and fails once the walk starts.
                put("taehvModelSrc", Models.ABOT_WORLD_0_5B_LF_TAEHV_VAE.src)
                put("t5XxlModelSrc", Models.UMT5_XXL_ENC_Q8_0.src)
                put("vaeModelSrc", Models.ABOT_WORLD_0_5B_LF_WAN_VAE.src)
                putJsonObject("world") {
                    put("seed", 42)
                    // ~3.7x fewer frame-passes per block. Without it, block
                    // times ramp from ~1.8 s to ~7.5 s as the recompute window
                    // fills.
                    put("kvCache", true)
                    // JPEG rather than PNG: a block is ~14 MB of raw pixels,
                    // and this example writes every frame to disk.
                    put("frameJpegQuality", 85)
                }
            },
        )
        val modelId = loaded.modelId ?: error(loaded.error ?: "loadModel failed")

        println("▸ Creating the world (umT5 prompt encode + Wan2.2 VAE first-frame encode)...")
        val creation = client.media.worldScene(
            WorldSceneStreamRequest(
                modelId = modelId,
                prompt = prompt,
                image = Base64.getEncoder().encodeToString(Files.readAllBytes(Path.of(firstFramePath))),
                width = width,
                height = height,
                // The world is live on the session without this; ask for the
                // bytes only because this example saves them to walk the same
                // world again later.
                returnPack = true,
            ),
        )

        var scene = ByteArray(0)
        var sceneStats: WorldSceneStreamResponseStats? = null
        creation.events.collect { response ->
            response.data?.let { scene = Base64.getDecoder().decode(it) }
            if (response.done == true) sceneStats = response.stats
        }

        val scenePath = outputDir.resolve("world.safetensors")
        Files.write(scenePath, scene)
        val sceneCreateMs = sceneStats?.sceneCreateMs ?: "?"
        println("  scene pack written to $scenePath (${scene.size} bytes, $sceneCreateMs ms)")
        println("  reuse it later with modelConfig.sceneSrc to walk this same world again")

        println("▸ Walking $blocks blocks...")
        var frameNumber = 0
        for (block in 0 until blocks) {
            val keys = TAPE[block % TAPE.size]
            // One block at a time: a second step while this one streams is
            // rejected, so drive the next call off this one rather than firing
            // them in parallel.
            val step = client.media.worldStep(WorldStepStreamRequest(modelId = modelId, keys = keys))

            var stats: WorldStepStreamResponseStats? = null
            step.events.collect { response ->
                response.data?.let {
                    val framePath = outputDir.resolve("frame-%04d.jpg".format(frameNumber))
                    Files.write(framePath, Base64.getDecoder().decode(it))
                    frameNumber += 1
                }
                if (response.done == true) stats = response.stats
            }

            val frames = stats?.frames ?: "?"
            val stepMs = stats?.stepMs ?: "?"
            val held = keys.joinToString("+").ifEmpty { "idle" }
            println("  block ${block + 1}/$blocks [$held] — $frames frames in $stepMs ms")
        }

        println("✔ Wrote $frameNumber frames to $outputDir")

        // Targeted cancellation. Cancel is block-granular: the engine has no
        // mid-block abort, so the current block finishes internally, delivery
        // stops, and the step fails rather than returning a truncated block. A
        // cancel that lands after the block already finished legitimately
        // succeeds instead -- both outcomes are correct, so handle each.
        println("▸ Cancelling a block mid-flight to show the contract...")
        val requestId = qvacRequestId()
        val cancelling = client.media.worldStep(
            WorldStepStreamRequest(
                modelId = modelId,
                requestId = requestId,
                keys = listOf(WorldStepStreamRequestKeysItem.W),
            ),
        )

        val canceller = launch {
            delay(200)
            // The block can finish before this lands, and cancelling a request
            // that is no longer in flight fails. The walk below reports
            // whichever outcome won.
            runCatching { client.cancel(CancelRequest.Request(CancelRequestRequest(requestId = requestId))) }
        }
        try {
            cancelling.events.collect { }
            println("  the block completed before the cancel landed (the tolerated race)")
        } catch (error: QvacKnownException.ServerInferenceCancelled) {
            println("  cancelled as expected: ${error.message}")
        } finally {
            canceller.cancel()
        }

        // A cancelled step is terminal for the native session, but the SDK
        // drops it for you: another worldStep on this same modelId would
        // transparently rebuild from the promoted pack, with no unload/load
        // cycle. Unloading here only because the example is finished.
        client.models.unload(modelId)
    } finally {
        client.close()
    }
}
