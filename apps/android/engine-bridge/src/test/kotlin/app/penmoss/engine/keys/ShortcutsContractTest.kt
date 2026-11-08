package app.penmoss.engine.keys

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The keyboard-shortcuts contract (T40 P9, A492): `contract/shortcuts-v1.json` is the web's
 * command registry and its binding rules off Apple platforms, written by the web's vitest. The
 * phone's normaliser, the A90 rules, the stored form (A491), the display names and
 * `usableBindings` must answer each case exactly as the web does.
 */
class ShortcutsContractTest {
    private val contract: JsonObject = run {
        val file = System.getProperty("penmoss.contract")?.let { File(it).resolveSibling("shortcuts-v1.json") }
            ?: File("../contract/shortcuts-v1.json")
        Json.parseToJsonElement(file.readText()).jsonObject
    }
    private val catalogue = ShortcutCatalogue.bundled

    @Test
    fun bundlesTheRegistryTheContractHolds() {
        val fromFile = ShortcutCatalogue.parse(Json.encodeToString(JsonElement.serializer(), contract))
        assertEquals(fromFile.commands, catalogue.commands)
        assertEquals(contract.getValue("reserved").jsonArray.map { it.jsonPrimitive.content }.toSet(), catalogue.reserved)
        assertTrue(catalogue.commands.size > 100)
        assertNotNull(catalogue.command("app.search"))
        assertEquals(listOf("Alt+N"), catalogue.command("note.new")!!.keys)
        val limits = contract.getValue("limits").jsonObject
        assertEquals(limits.getValue("combosPerCommand").jsonPrimitive.int, Combos.MAX_PER_COMMAND)
        assertEquals(limits.getValue("comboChars").jsonPrimitive.int, Combos.MAX_CHARS)
    }

    /** The web's `code` as the key part Android's [Combos.of] is given (the app maps key codes the same way). */
    private fun keyOf(code: String, key: String): String? = when {
        code.startsWith("Control") || code.startsWith("Shift") || code.startsWith("Alt") || code.startsWith("Meta") -> null
        code.startsWith("Key") -> code.removePrefix("Key")
        code.startsWith("Digit") -> code.removePrefix("Digit")
        code.matches(Regex("^F\\d{1,2}$")) -> code
        else -> mapOf(
            "Slash" to "/", "Comma" to ",", "Backslash" to "\\", "Space" to "Space", "Enter" to "Enter",
            "Delete" to "Delete", "ArrowUp" to "Up", "ArrowDown" to "Down",
        )[code] ?: key
    }

    @Test
    fun readsKeysAsTheWebDoes() {
        for (case in contract.getValue("events").jsonArray.map { it.jsonObject }) {
            fun flag(name: String) = case.getValue(name).jsonPrimitive.boolean
            val code = case.getValue("code").jsonPrimitive.content
            val combo = Combos.of(keyOf(code, case.getValue("key").jsonPrimitive.content), flag("ctrl"), flag("alt"), flag("shift"), flag("meta"))
            val expected = case.getValue("combo").let { if (it is JsonNull) null else it.jsonPrimitive.content }
            assertEquals(code, expected, combo)
        }
    }

    @Test
    fun forbidsWhatA90Forbids() {
        for (case in contract.getValue("problems").jsonArray.map { it.jsonObject }) {
            val combo = case.getValue("combo").jsonPrimitive.content
            val expected = case.getValue("problem").let { if (it is JsonNull) null else it.jsonPrimitive.content }
            assertEquals(combo, expected, Combos.problem(combo, catalogue.reserved)?.wire)
        }
    }

    @Test
    fun namesCombinationsAsTheWebDoes() {
        for (case in contract.getValue("format").jsonArray.map { it.jsonObject }) {
            assertEquals(case.getValue("text").jsonPrimitive.content, Combos.format(case.getValue("combo").jsonPrimitive.content))
        }
    }

    @Test
    fun storesOnlyWhatTheServerTakes() {
        val stored = contract.getValue("stored").jsonObject
        for (value in stored.getValue("valid").jsonArray) assertNull(value.toString(), Combos.storedProblem(value))
        for (value in stored.getValue("invalid").jsonArray) assertNotNull(value.toString(), Combos.storedProblem(value))
        // Every command's defaults are storable, so Reset and a recorded default always go.
        for (command in catalogue.commands) {
            assertNull(command.id, Combos.storedProblem(JsonArray(command.keys.map(::JsonPrimitive))))
        }
    }

    @Test
    fun usesTheBindingsTheWebUses() {
        for (case in contract.getValue("usable").jsonArray.map { it.jsonObject }) {
            val raw = case.getValue("raw").jsonObject
            val expected = case.getValue("usable").jsonObject.mapValues { (_, list) -> list.jsonArray.map { it.jsonPrimitive.content } }
            assertEquals(raw.toString(), expected, Bindings(catalogue, raw).usable)
        }
    }

    @Test
    fun findsConflictsAsTheWebDoes() {
        val none = Bindings(catalogue, emptyMap())
        // Mod+K: Link yields to the palette by design (A42), so it is no conflict.
        assertEquals(emptyList<String>(), none.conflicts("editor.link", "Mod+K").map { it.id })
        // Mod+E is the recent-notes switcher's: binding it to Search clashes.
        assertEquals(listOf("app.recent"), none.conflicts("app.search", "Mod+E").map { it.id })
        // The tree's Alt+Up never acts with the editor's keys.
        assertEquals(emptyList<String>(), none.conflicts("editor.moveBlockUp", "Alt+Up").map { it.id })
        // The defaults have no clash.
        assertEquals(emptyList<Bindings.Clash>(), none.clashes())
        // One that arrives by sync is listed once.
        val synced = Bindings.of(catalogue, JsonObject(mapOf("keys.app.search" to JsonArray(listOf(JsonPrimitive("Mod+E"))))))
        assertEquals(listOf("Mod+E"), synced.clashes().map { it.combo })
        assertEquals(setOf("app.search", "app.recent"), synced.clashes().flatMap { listOf(it.first.id, it.second.id) }.toSet())
        assertTrue(synced.isCustom("app.search"))
        assertEquals(listOf("app.search", "app.recent").sorted(), synced.commandsFor("Mod+E").map { it.id }.sorted())
    }
}
