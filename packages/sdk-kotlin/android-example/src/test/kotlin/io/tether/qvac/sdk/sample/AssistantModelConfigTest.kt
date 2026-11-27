package io.tether.qvac.sdk.sample

import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

class AssistantModelConfigTest {
    @Test
    fun qwenOffloadsAllLayersToGpu() {
        val config = AssistantModelConfig.qwen()

        assertEquals("gpu", config["device"]?.jsonPrimitive?.content)
        assertEquals(99, config["gpuLayers"]?.jsonPrimitive?.int)
        assertEquals(-1, config["reasoningBudget"]?.jsonPrimitive?.int)
        assertEquals(-1, AssistantModelConfig.qwenCpu()["reasoningBudget"]?.jsonPrimitive?.int)
        assertFalse("threads" in config)
    }

    @Test
    fun parakeetUsesItsStrictCpuConfiguration() {
        val config = AssistantModelConfig.parakeet()

        assertEquals(4, config["maxThreads"]?.jsonPrimitive?.int)
        assertFalse(config["useGpu"]?.jsonPrimitive?.boolean ?: true)
        assertFalse("threads" in config)
    }

    @Test
    fun smolVlmUsesCpuAndMatchingProjectionModel() {
        val config = AssistantModelConfig.smolVlm()

        assertEquals("cpu", config["device"]?.jsonPrimitive?.content)
        assertEquals(0, config["gpuLayers"]?.jsonPrimitive?.int)
        assertEquals(
            AssistantModelConfig.smolVlmProjectionSource,
            config["projectionModelSrc"]?.jsonPrimitive?.content,
        )
        assertFalse("threads" in config)
    }
}
