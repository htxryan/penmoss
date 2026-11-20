package app.penmoss.ai

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.security.SecretBox
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * AI Descriptions on the phone (PEN-161 T6): a key is kept only once Anthropic takes it, never
 * in the clear; a refusal stops calls until the key changes; nothing is sent without a provider.
 */
@RunWith(AndroidJUnit4::class)
class AiDescriptionsTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val prefs = context.getSharedPreferences(AiKeyStore.PREFS, Context.MODE_PRIVATE)

    /** Seals by reversing, so the stored bytes are never the key. */
    private val box = object : SecretBox {
        override fun seal(plain: ByteArray) = plain.reversedArray()

        override fun open(sealed: ByteArray) = sealed.reversedArray()
    }

    private val calls = mutableListOf<Triple<String, String, String?>>()
    private var answer = AiResponse(200, "{}")
    private var settings = JsonObject(mapOf(AiKeys.PROVIDER to JsonPrimitive(AiKeys.ANTHROPIC), AiKeys.GLOBAL to JsonPrimitive(true)))

    private fun ai() = AiDescriptions(
        AiKeyStore(prefs, box),
        AnthropicClient({ method, url, headers, body ->
            calls += Triple(method, url, body)
            assertEquals("sk-ant-good", headers["x-api-key"])
            answer
        }),
        { settings },
    )

    @Before
    fun clear() {
        prefs.edit().clear().commit()
    }

    @Test
    fun aKeyIsKeptOnlyOnceAnthropicTakesIt() = runBlocking {
        val ai = ai()
        answer = AiResponse(401, "{}")
        assertEquals("refused", (ai.saveKey("sk-ant-good") as AiResult.Failed).code)
        assertFalse(ai.key.value.saved)
        answer = AiResponse(200, "{}")
        assertTrue(ai.saveKey(" sk-ant-good ") is AiResult.Text)
        assertTrue(ai.key.value.saved)
        assertTrue(ai.ready)
        // Sealed: the stored value is not the key.
        assertFalse(prefs.all.values.any { it.toString().contains("sk-ant-good") })
        assertEquals("GET", calls.last().first)
        ai.removeKey()
        assertFalse(ai.ready)
    }

    @Test
    fun describesWithTheModelAndStopsAfterARefusal() = runBlocking {
        val ai = ai()
        ai.saveKey("sk-ant-good")
        answer = AiResponse(200, """{"content":[{"type":"text","text":" Plans for the week. "}]}""")
        val done = ai.describe("Describe it").jsonObject
        assertEquals("Plans for the week.", done.getValue("text").jsonPrimitive.content)
        val body = Json.parseToJsonElement(calls.last().third!!).jsonObject
        assertEquals("claude-haiku-5-5", body.getValue("model").jsonPrimitive.content)
        answer = AiResponse(401, "{}")
        assertEquals("refused", ai.describe("Describe it").jsonObject.getValue("code").jsonPrimitive.content)
        assertTrue(ai.key.value.refused)
        assertFalse(ai.ready)
        val before = calls.size
        assertEquals("no-provider", ai.describe("Describe it").jsonObject.getValue("code").jsonPrimitive.content)
        assertEquals(before, calls.size)
    }

    @Test
    fun sendsNothingWithoutAProvider() = runBlocking {
        val ai = ai()
        ai.saveKey("sk-ant-good")
        settings = JsonObject(mapOf(AiKeys.PROVIDER to JsonPrimitive(AiKeys.NONE)))
        val before = calls.size
        val config = ai.config().jsonObject
        assertEquals(false, config.getValue("ready").jsonPrimitive.content.toBoolean())
        assertEquals(120, config.getValue("pauseS").jsonPrimitive.content.toInt())
        assertEquals("no-provider", ai.describe("Describe it").jsonObject.getValue("code").jsonPrimitive.content)
        assertEquals(before, calls.size)
    }
}
