package app.penmoss.analytics

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The phone records in core's format (PEN-137): `apps/android/contract/analytics-v1.json`, which
 * core writes from `packages/core/src/analytics`, holds the lists, states, patterns, limits, the
 * props each kind takes and the catalogue. The app ships the same file and checks each event
 * against it; here every constant the Kotlin side keeps is checked against it too, and every
 * prop type is tried both ways.
 */
class AnalyticsContractTest {
    private val contract: JsonObject = run {
        val file = System.getProperty("penmoss.contract")?.let { File(it).resolveSibling("analytics-v1.json") }
            ?: File("../contract/analytics-v1.json")
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    private fun strings(key: String) = contract.getValue(key).jsonArray.map { it.jsonPrimitive.content }

    private val catalogue = AnalyticsCatalogue.parse(contract.toString())

    @Test
    fun theListsAndStatesAreCores() {
        assertEquals(strings("kinds"), AnalyticsFormat.KINDS)
        assertEquals(strings("clients"), AnalyticsFormat.CLIENTS)
        assertEquals(strings("actors"), AnalyticsFormat.ACTORS)
        assertEquals(strings("channels"), AnalyticsFormat.CHANNELS)
        assertEquals(strings("oses"), AnalyticsFormat.OSES)
        assertEquals(strings("sizeClasses"), AnalyticsFormat.SIZE_CLASSES)
        assertEquals(strings("countBuckets"), AnalyticsFormat.COUNT_BUCKETS)
        assertEquals(strings("durationBuckets"), AnalyticsFormat.DURATION_BUCKETS)
        assertEquals(strings("agentClients"), AnalyticsCatalogue.AGENT_CLIENTS)
        val states = contract.getValue("states").jsonArray.map { it.jsonObject }
        assertEquals(states.map { it.getValue("name").jsonPrimitive.content }, EventState.entries.map { it.wire })
        assertEquals(states.map { it.getValue("code").jsonPrimitive.int }, EventState.entries.map { it.code })
        assertEquals(states.map { it.getValue("label").jsonPrimitive.content }, EventState.entries.map { it.label })
        assertEquals(strings("stateOrder"), EventState.ORDER.map { it.wire })
        val sending = contract.getValue("sending").jsonObject
        assertEquals(sending.getValue("maxBatchEvents").jsonPrimitive.int, AnalyticsFormat.MAX_BATCH_EVENTS)
        assertEquals(sending.getValue("maxBatchBytes").jsonPrimitive.int, AnalyticsFormat.MAX_BATCH_BYTES)
        assertEquals(sending.getValue("everyMs").jsonPrimitive.long, AnalyticsFormat.SEND_EVERY_MS)
        assertEquals(sending.getValue("atWaiting").jsonPrimitive.int, AnalyticsFormat.SEND_AT_WAITING)
        assertEquals(sending.getValue("timeoutMs").jsonPrimitive.long, AnalyticsFormat.SEND_TIMEOUT_MS)
        assertEquals(sending.getValue("maxBackoffMs").jsonPrimitive.long, AnalyticsFormat.MAX_BACKOFF_MS)
    }

    @Test
    fun theLimitsAreCores() {
        val limits = contract.getValue("limits").jsonArray.map { it.jsonObject }
        assertEquals(
            limits.map { listOf(it.getValue("key"), it.getValue("default"), it.getValue("min"), it.getValue("max"), it.getValue("unit"), it.getValue("group")).map { v -> v.jsonPrimitive.content } },
            Limits.SPECS.map { listOf(it.key, it.default, it.min, it.max, it.unit, it.group).map(Any::toString) },
        )
    }

    @Test
    fun thePatternsAreCores() {
        val patterns = contract.getValue("patterns").jsonObject.mapValues { Regex(it.value.jsonPrimitive.content) }
        for (keys in listOf("Mod+K", "Mod+Shift+P", "Ctrl+/", "Alt+ArrowUp", "F5", "Mod+[", "Mod+\\")) {
            assertTrue(keys, patterns.getValue("keys").matches(keys))
            assertTrue(keys, AnalyticsCatalogue.KEYS.matches(keys))
        }
        for (keys in listOf("Mod+Kk", "hello", "Mod+Shift+Alt+Ctrl+Meta+K", "Mod+ä")) {
            assertEquals(keys, patterns.getValue("keys").matches(keys), AnalyticsCatalogue.KEYS.matches(keys))
        }
        assertTrue(patterns.getValue("install").matches(AnalyticsFormat.newInstallId()))
        assertTrue(patterns.getValue("session").matches(AnalyticsFormat.newSessionId()))
        for (version in listOf("0.4.2", "0.4.2-alpha.1185", "0.1.0-debug")) {
            assertTrue(version, patterns.getValue("version").matches(AnalyticsFormat.eventVersion(version)))
        }
        // An Alpha build's debug variant still carries a version the format takes.
        assertEquals("0.4.2-alpha.3", AnalyticsFormat.eventVersion("0.4.2-alpha.3-debug"))
        assertTrue(patterns.getValue("osVersion").matches(AnalyticsFormat.majorMinor("17")))
    }

    private fun event(kind: String, name: String, props: Map<String, JsonElement> = emptyMap()) = AnalyticsEvent(
        "0123456789abcdef", 0, 1, "android", "person", "0.4.2", "stable", "android", "17", "compact", kind, name, JsonObject(props),
    )

    /** A value of [type] the format allows, and one it refuses. */
    private fun samples(type: JsonObject): Pair<JsonElement, JsonElement> = when (type.getValue("type").jsonPrimitive.content) {
        "count" -> JsonPrimitive("10–49") to JsonPrimitive("12")
        "duration" -> JsonPrimitive("2–5s") to JsonPrimitive(3000)
        "bool" -> JsonPrimitive(true) to JsonPrimitive("true")
        "enum" -> type.getValue("values").jsonArray.first() to JsonPrimitive("Zebracanary Title Q7")
        "keys" -> JsonPrimitive("Mod+Shift+K") to JsonPrimitive("pangolincanary")
        "screen" -> JsonPrimitive("settings.privacy") to JsonPrimitive("note/01HZX")
        "setting" -> JsonPrimitive(true) to JsonPrimitive("slothcanary")
        "flags" -> JsonArray(listOf(JsonPrimitive(strings("cliFlags").first()))) to JsonArray(listOf(JsonPrimitive("slothcanary")))
        "length" -> JsonPrimitive(1440) to JsonPrimitive(1441)
        else -> error("A prop type the phone does not know: $type")
    }

    @Test
    fun eachKindTakesExactlyCoresProps() {
        val props = contract.getValue("props").jsonObject
        assertEquals(AnalyticsFormat.KINDS.toSet(), props.keys)
        for ((kind, keys) in props) {
            val name = catalogue.names(kind).first()
            assertNull(kind, catalogue.problem(event(kind, name)))
            for ((key, type) in keys.jsonObject) {
                val (good, bad) = samples(type.jsonObject)
                assertNull("$kind.$key = $good", catalogue.problem(event(kind, name, mapOf(key to good))))
                assertNotNull("$kind.$key = $bad", catalogue.problem(event(kind, name, mapOf(key to bad))))
            }
            assertNotNull("$kind takes no other prop", catalogue.problem(event(kind, name, mapOf("title" to JsonPrimitive("x")))))
        }
    }

    @Test
    fun aNameWithPropsOfItsOwnTakesExactlyThose() {
        val nameProps = contract.getValue("nameProps").jsonObject
        assertEquals(setOf("app.window", "app.layout"), nameProps.keys)
        val kindProps = contract.getValue("props").jsonObject
        for ((key, keys) in nameProps) {
            val kind = key.substringBefore('.')
            val name = key.substringAfter('.')
            assertTrue(key, catalogue.has(kind, name))
            assertNull(key, catalogue.problem(event(kind, name)))
            for ((prop, type) in keys.jsonObject) {
                val (good, bad) = samples(type.jsonObject)
                assertNull("$key.$prop = $good", catalogue.problem(event(kind, name, mapOf(prop to good))))
                assertNotNull("$key.$prop = $bad", catalogue.problem(event(kind, name, mapOf(prop to bad))))
                // No other name of the kind takes it: app launch with a width is refused.
                assertNotNull("$kind.launch.$prop", catalogue.problem(event(kind, "launch", mapOf(prop to good))))
            }
            // Nor do these names take the kind's own props, or any other.
            for ((prop, type) in kindProps.getValue(kind).jsonObject) {
                assertNotNull("$key.$prop", catalogue.problem(event(kind, name, mapOf(prop to samples(type.jsonObject).first))))
            }
            assertNotNull("$key takes no other prop", catalogue.problem(event(kind, name, mapOf("x" to JsonPrimitive(20)))))
        }
    }

    @Test
    fun aLengthIsAWholeMultipleOf10UpToTheMost() {
        assertEquals(contract.getValue("maxLength").jsonPrimitive.int, AnalyticsFormat.MAX_LENGTH)
        val window = { width: JsonElement -> catalogue.problem(event("app", "window", mapOf("width" to width))) }
        for (good in listOf(0, 10, 1440, 10_000)) assertNull("$good", window(JsonPrimitive(good)))
        for (bad in listOf<JsonElement>(JsonPrimitive(1441), JsonPrimitive(-10), JsonPrimitive(10_010), JsonPrimitive("1440"), JsonPrimitive(1440.0), JsonPrimitive(true), JsonPrimitive(1.44e3))) {
            assertNotNull("$bad", window(bad))
        }
        // The values each enum takes.
        assertNotNull(catalogue.problem(event("app", "window", mapOf("window" to JsonPrimitive("settings")))))
        assertNotNull(catalogue.problem(event("app", "layout", mapOf("window" to JsonPrimitive("capture")))))
        assertNotNull(catalogue.problem(event("app", "layout", mapOf("tabs" to JsonPrimitive(3)))))
        assertNull(catalogue.problem(event("app", "layout", mapOf("tabs" to JsonPrimitive("2–4"), "sidebar" to JsonPrimitive("rail"), "themeMode" to JsonPrimitive("dark")))))
    }

    @Test
    fun aSettingsWordIsOneOfItsOwn() {
        val words = contract.getValue("settingValues").jsonObject
        for ((name, values) in words) {
            for (word in values.jsonArray) {
                assertNull("$name = $word", catalogue.problem(event("setting", name, mapOf("value" to word))))
            }
            assertNotNull(name, catalogue.problem(event("setting", name, mapOf("value" to JsonPrimitive("narwhalcanary")))))
        }
        // A limit's value is a number; a switch's a boolean; another setting's word is not this one's.
        assertNull(catalogue.problem(event("setting", "privacy.limits.events.days", mapOf("value" to JsonPrimitive(30)))))
        assertNull(catalogue.problem(event("setting", "privacy.share", mapOf("value" to JsonPrimitive(false)))))
        assertNotNull(catalogue.problem(event("setting", "theme.id", mapOf("value" to JsonPrimitive("dark")))))
        assertEquals(contract.getValue("maxFlags").jsonPrimitive.int, AnalyticsCatalogue.MAX_FLAGS)
        assertEquals(contract.getValue("maxSettingNumber").jsonPrimitive.long, AnalyticsCatalogue.MAX_SETTING_NUMBER)
    }

    @Test
    fun theAppShipsTheContractsCatalogue() {
        val shipped = AnalyticsCatalogue.bundled
        for (kind in AnalyticsFormat.KINDS) assertEquals(kind, catalogue.names(kind), shipped.names(kind))
        assertTrue(shipped.has("click", "privacy.share-log-file"))
        assertTrue(shipped.has("screen", "settings.privacy"))
        assertTrue(shipped.has("firstrun", "consent"))
        assertNull(shipped.problem(event("click", "privacy.view-data")))
        assertNotNull(shipped.problem(event("click", "privacy.nothing-like-this")))
    }

    @Test
    fun aBatchCarriesCoresFieldsInOrder() {
        val wire = event("click", "privacy.view-data", mapOf("state" to JsonPrimitive("on"))).wire()
        assertEquals(
            listOf("session", "seq", "at", "client", "actor", "version", "channel", "os", "osVersion", "sizeClass", "kind", "name", "props"),
            wire.keys.toList(),
        )
        val noSize = event("click", "privacy.view-data").copy(sizeClass = null).wire()
        assertTrue("sizeClass" !in noSize)
        assertEquals(buildJsonObject { }, noSize.getValue("props"))
    }
}
