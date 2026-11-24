package app.penmoss.ai

import app.penmoss.ui.settings.AI_PROMPT_TOKENS
import app.penmoss.ui.settings.DEFAULT_AI_PROMPT
import app.penmoss.ui.settings.AI_TAG_PROMPT_TOKENS
import app.penmoss.ui.settings.DEFAULT_AI_TAG_PROMPT
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/**
 * The phone's AI Descriptions copy against core's (PEN-161 T6): `contract/ai-descriptions-v1.json`,
 * which the editor page's vitest writes from `packages/core/src/ai-description.ts`; and the words
 * both apps say about descriptions, and the longest tag description (A1677, A1646).
 */
class AiDescriptionsContractTest {
    private val contract: JsonObject = run {
        val file = System.getProperty("penmoss.contract")?.let { File(it).resolveSibling("ai-descriptions-v1.json") }
            ?: File("../contract/ai-descriptions-v1.json")
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    @Test
    fun theDefaultPromptAndItsTokensAreCores() {
        assertEquals(contract.getValue("defaultPrompt").jsonPrimitive.content, DEFAULT_AI_PROMPT)
        assertEquals(contract.getValue("tokens").jsonArray.map { it.jsonPrimitive.content }, AI_PROMPT_TOKENS)
    }

    @Test
    fun theTagPromptAndItsTokensAreCores() {
        assertEquals(contract.getValue("defaultTagPrompt").jsonPrimitive.content, DEFAULT_AI_TAG_PROMPT)
        assertEquals(contract.getValue("tagTokens").jsonArray.map { it.jsonPrimitive.content }, AI_TAG_PROMPT_TOKENS)
        assertEquals("ai.description.tagPrompt", AiKeys.TAG_PROMPT)
    }

    @Test
    fun theModelsAndPausesAreCores() {
        assertEquals(
            contract.getValue("models").jsonArray.map { it.jsonObject.getValue("id").jsonPrimitive.content to it.jsonObject.getValue("label").jsonPrimitive.content },
            AiKeys.MODELS,
        )
        assertEquals(contract.getValue("pauses").jsonArray.map { it.jsonPrimitive.int }, AiKeys.PAUSES)
    }

    @Test
    fun theWordsAreCores() {
        val copy = contract.getValue("copy").jsonObject.mapValues { it.value.jsonPrimitive.content }
        assertEquals(copy, AiDescriptionCopy.TEXT)
        for (sample in contract.getValue("generateAll").jsonArray.map { it.jsonObject }) {
            val count = sample.getValue("count").jsonPrimitive.int
            val replace = sample.getValue("replace").jsonPrimitive.boolean
            assertEquals("$count, $replace", sample.getValue("words").jsonPrimitive.content, AiDescriptionCopy.generateAllWords(count, replace))
        }
        assertEquals(contract.getValue("tagDescriptionMax").jsonPrimitive.int, TAG_DESCRIPTION_MAX)
    }
}
