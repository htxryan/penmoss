package app.penmoss.ui.keys

import android.view.KeyEvent
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The native key dispatcher (T40 P9, A494): Android's key presses named as the web names them,
 * the user's bindings over the defaults, and which keys it leaves alone (typing, the IME, the
 * editor page's own).
 */
@RunWith(AndroidJUnit4::class)
class AppKeysTest {
    private fun press(code: Int, meta: Int = 0, action: Int = KeyEvent.ACTION_DOWN, repeat: Int = 0) =
        KeyEvent(0L, 0L, action, code, repeat, meta)

    private val ctrl = KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON
    private val alt = KeyEvent.META_ALT_ON or KeyEvent.META_ALT_LEFT_ON
    private val shift = KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON

    /** AltGr on Android: the right Alt, with no Ctrl (review B1). */
    private val altGr = KeyEvent.META_ALT_ON or KeyEvent.META_ALT_RIGHT_ON

    /** The web's `KeyboardEvent.code` names in the contract's events, as Android's key codes. */
    private val codes = mapOf(
        "ArrowDown" to KeyEvent.KEYCODE_DPAD_DOWN,
        "ArrowUp" to KeyEvent.KEYCODE_DPAD_UP,
        "Backslash" to KeyEvent.KEYCODE_BACKSLASH,
        "Comma" to KeyEvent.KEYCODE_COMMA,
        "ControlLeft" to KeyEvent.KEYCODE_CTRL_LEFT,
        "Delete" to KeyEvent.KEYCODE_FORWARD_DEL,
        "Digit0" to KeyEvent.KEYCODE_0,
        "Digit1" to KeyEvent.KEYCODE_1,
        "Digit8" to KeyEvent.KEYCODE_8,
        "Enter" to KeyEvent.KEYCODE_ENTER,
        "F10" to KeyEvent.KEYCODE_F10,
        "F2" to KeyEvent.KEYCODE_F2,
        "KeyK" to KeyEvent.KEYCODE_K,
        "KeyN" to KeyEvent.KEYCODE_N,
        "Slash" to KeyEvent.KEYCODE_SLASH,
        "Space" to KeyEvent.KEYCODE_SPACE,
    )

    private fun contract(): JsonObject {
        val file = generateSequence(File("").absoluteFile) { it.parentFile }
            .map { File(it, "contract/shortcuts-v1.json") }.first { it.exists() }
        return Json.parseToJsonElement(file.readText()).jsonObject
    }

    @Test
    fun namesAKeyPressAsTheWebDoes() {
        val events = contract().getValue("events").jsonArray.map { it.jsonObject }
        for (event in events) {
            val code = event.getValue("code").jsonPrimitive.content
            val keyCode = codes[code] ?: error("No Android key code for $code: add it to the test")
            var meta = 0
            if (event.getValue("ctrl").jsonPrimitive.boolean) meta = meta or ctrl
            if (event.getValue("alt").jsonPrimitive.boolean) meta = meta or alt
            if (event.getValue("shift").jsonPrimitive.boolean) meta = meta or shift
            if (event.getValue("meta").jsonPrimitive.boolean) meta = meta or KeyEvent.META_META_ON
            val combo = event["combo"]?.takeIf { it is JsonPrimitive && it.isString }?.jsonPrimitive?.content
            assertEquals("$code with $event", combo, KeyNames.comboOf(press(keyCode, meta)))
        }
    }

    @Test
    fun aCombinationsKeyHasItsKeyCodeForTheShortcutHelper() {
        for (name in listOf("A", "Z", "0", "9", "F1", "F12", "/", ",", "\\", "Up", "Down", "Enter", "Escape", "Space")) {
            val code = KeyNames.codeOf(name) ?: error("No key code for $name")
            assertEquals(name, KeyNames.of(code))
        }
        assertNull(KeyNames.codeOf("F24"))
    }

    private fun commands(
        settings: Map<String, List<String>> = emptyMap(),
        layout: KeyChars = Layout.US,
    ): Pair<AppCommands, MutableList<String>> {
        val ran = mutableListOf<String>()
        val commands = AppCommands(chars = layout)
        commands.follow(JsonObject(settings.mapKeys { "keys.${it.key}" }.mapValues { (_, keys) -> JsonArray(keys.map(::JsonPrimitive)) }))
        for (id in listOf("app.search", "app.quickOpen", "note.new", "journal.today", "app.cheatsheet", "folder.new")) {
            commands.register(id, CommandHandler(run = { ran += id }))
        }
        return commands to ran
    }

    @Test
    fun runsTheCommandBoundToAKeyFromHomeOrANote() {
        val (commands, ran) = commands()
        assertTrue(commands.handle(press(KeyEvent.KEYCODE_P, ctrl), inEditor = false))
        assertTrue(commands.handle(press(KeyEvent.KEYCODE_N, alt), inEditor = false))
        assertTrue(commands.handle(press(KeyEvent.KEYCODE_D, ctrl), inEditor = false))
        assertTrue(commands.handle(press(KeyEvent.KEYCODE_SLASH, ctrl), inEditor = false))
        assertTrue(commands.handle(press(KeyEvent.KEYCODE_N, alt or shift), inEditor = false))
        assertEquals(listOf("app.quickOpen", "note.new", "journal.today", "app.cheatsheet", "folder.new"), ran)
    }

    @Test
    fun leavesTheKeysOfTheFocusedEditorToItsPage() {
        val (commands, ran) = commands()
        // The page dispatches these itself and sends back the app's commands (A493).
        assertFalse(commands.handle(press(KeyEvent.KEYCODE_P, ctrl), inEditor = true))
        assertEquals(emptyList<String>(), ran)
    }

    @Test
    fun neverTakesAKeyThatTypesOrThatTheKeyboardsIMENeeds() {
        val (commands, ran) = commands(mapOf("app.search" to listOf("Mod+P")))
        assertFalse(commands.handle(press(KeyEvent.KEYCODE_P), inEditor = false))
        assertFalse(commands.handle(press(KeyEvent.KEYCODE_P, shift), inEditor = false))
        assertFalse(commands.handle(press(KeyEvent.KEYCODE_ENTER), inEditor = false))
        assertFalse(commands.handle(press(KeyEvent.KEYCODE_CTRL_LEFT, ctrl), inEditor = false))
        // A key's release, and anything while Settings records a combination.
        assertFalse(commands.handle(press(KeyEvent.KEYCODE_P, ctrl, KeyEvent.ACTION_UP), inEditor = false))
        commands.recording = true
        assertFalse(commands.handle(press(KeyEvent.KEYCODE_P, ctrl), inEditor = false))
        assertEquals(emptyList<String>(), ran)
    }

    @Test
    fun theUsersBindingsReplaceTheDefaults() {
        val (commands, ran) = commands(mapOf("app.search" to listOf("Mod+Shift+S"), "note.new" to emptyList()))
        assertTrue(commands.handle(press(KeyEvent.KEYCODE_S, ctrl or shift), inEditor = false))
        assertFalse(commands.handle(press(KeyEvent.KEYCODE_F, ctrl or shift), inEditor = false))
        assertFalse(commands.handle(press(KeyEvent.KEYCODE_N, alt), inEditor = false))
        assertEquals(listOf("app.search"), ran)
        assertEquals(mapOf("app.search" to listOf("Mod+Shift+S"), "note.new" to emptyList<String>()), commands.raw.value)
    }

    @Test
    fun aBindingTheWebWouldRefuseKeepsTheDefault() {
        // Typed (no Ctrl or Alt), or kept for editing text: not usable here, so the default stays (A90).
        val (commands, ran) = commands(mapOf("app.search" to listOf("Shift+S"), "app.quickOpen" to listOf("Mod+C")))
        assertTrue(commands.handle(press(KeyEvent.KEYCODE_F, ctrl or shift), inEditor = false))
        assertTrue(commands.handle(press(KeyEvent.KEYCODE_P, ctrl), inEditor = false))
        assertEquals(listOf("app.search", "app.quickOpen"), ran)
    }

    @Test
    fun altGrTypesOnAPolishLayoutAndNeverRunsAnAltShortcut() {
        val (commands, ran) = commands(layout = Layout.POLISH)
        // AltGr+N types ń and AltGr+A ą: never New note, never anything bound to Alt+A.
        assertFalse(commands.handle(press(KeyEvent.KEYCODE_N, altGr), inEditor = false))
        assertFalse(commands.handle(press(KeyEvent.KEYCODE_A, altGr), inEditor = false))
        assertEquals(emptyList<String>(), ran)
        // The left Alt gives N no character there: Alt+N is New note.
        assertTrue(commands.handle(press(KeyEvent.KEYCODE_N, alt), inEditor = false))
        assertEquals(listOf("note.new"), ran)
    }

    @Test
    fun altGrTypesOnAGermanLayoutEvenWhereTheUserBoundTheKey() {
        val (commands, ran) = commands(mapOf("app.search" to listOf("Alt+Q"), "app.quickOpen" to listOf("Alt+7")), Layout.GERMAN)
        assertFalse(commands.handle(press(KeyEvent.KEYCODE_Q, altGr), inEditor = false))
        assertFalse(commands.handle(press(KeyEvent.KEYCODE_7, altGr), inEditor = false))
        assertEquals(emptyList<String>(), ran)
        assertTrue(commands.handle(press(KeyEvent.KEYCODE_Q, alt), inEditor = false))
        assertEquals(listOf("app.search"), ran)
    }

    @Test
    fun aDeadAccentPassesThroughToBeTyped() {
        // Android's generic layout: Alt+N is the dead ~ (then n types ñ), with either Alt.
        val (commands, ran) = commands(layout = Layout.GENERIC)
        assertFalse(commands.handle(press(KeyEvent.KEYCODE_N, alt), inEditor = false))
        assertFalse(commands.handle(press(KeyEvent.KEYCODE_N, altGr), inEditor = false))
        assertEquals(emptyList<String>(), ran)
        // Ctrl never types.
        assertTrue(commands.handle(press(KeyEvent.KEYCODE_P, ctrl), inEditor = false))
        assertEquals(listOf("app.quickOpen"), ran)
    }

    @Test
    fun aHeldKeyRunsItsCommandOnceAndItsRepeatsAreTaken() {
        val (commands, ran) = commands()
        assertTrue(commands.handle(press(KeyEvent.KEYCODE_N, alt), inEditor = false))
        assertTrue(commands.handle(press(KeyEvent.KEYCODE_N, alt, repeat = 1), inEditor = false))
        assertTrue(commands.handle(press(KeyEvent.KEYCODE_N, alt, repeat = 2), inEditor = false))
        assertEquals(listOf("note.new"), ran)
        // A repeat of a key nothing runs here goes on to the view.
        assertFalse(commands.handle(press(KeyEvent.KEYCODE_J, ctrl, repeat = 1), inEditor = false))
    }

    @Test
    fun keysAndroidAndItsTextFieldsKeepAreNeverTaken() {
        // Bound on the web, but on the phone Ctrl+← moves by word and Ctrl+Space switches language.
        val (commands, ran) = commands(mapOf("app.search" to listOf("Mod+Left"), "app.quickOpen" to listOf("Mod+Space")))
        assertFalse(commands.handle(press(KeyEvent.KEYCODE_DPAD_LEFT, ctrl), inEditor = false))
        assertFalse(commands.handle(press(KeyEvent.KEYCODE_SPACE, ctrl), inEditor = false))
        assertEquals(emptyList<String>(), ran)
    }

    @Test
    fun theKeyboardsOwnLayoutIsReadFromTheKeyPress() {
        // The real seam, on Robolectric's US map: no crash, and a plain letter types.
        assertTrue(typesCharacter(press(KeyEvent.KEYCODE_N), KeyChars.Layout))
        assertFalse(typesCharacter(press(KeyEvent.KEYCODE_N, ctrl), KeyChars.Layout))
    }

    @Test
    fun theScreenInFrontRunsTheCommandUntilItGoes() {
        val commands = AppCommands()
        val ran = mutableListOf<String>()
        commands.register("note.new", CommandHandler(run = { ran += "home" }))
        val undo = commands.register("note.new", CommandHandler(run = { ran += "folder" }))
        commands.dispatch("Alt+N")
        undo()
        commands.dispatch("Alt+N")
        var ready = false
        commands.register("note.delete", CommandHandler(run = { ran += "trash" }, enabled = { ready }))
        assertFalse(commands.run("note.delete"))
        assertFalse("note.delete" in commands.availableIds())
        ready = true
        assertTrue(commands.run("note.delete"))
        assertEquals(listOf("folder", "home", "trash"), ran)
    }

    @Test
    fun androidsShortcutHelperListsWhatRunsHere() {
        val (commands, _) = commands()
        val groups = commands.shortcutGroups()
        val items = groups.flatMap { group -> group.items.map { group.label.toString() to it.label.toString() } }
        assertTrue(items.toString(), items.any { it.second == "New Note" })
        val today = groups.flatMap { it.items }.first { it.label == "Today's Note" }
        assertEquals(KeyEvent.KEYCODE_D, today.keycode)
        assertTrue(today.modifiers and KeyEvent.META_CTRL_ON != 0)
        // The editor's are listed only while a note is open.
        assertFalse(groups.any { group -> group.items.any { it.label == "Bold" } })
        commands.editorOpen = true
        assertTrue(commands.shortcutGroups().any { group -> group.items.any { it.label == "Bold" } })
    }

    @Test
    fun androidsShortcutHelperNeverOffersAKeyThatTypesHere() {
        // Generic, a keyboard with no layout chosen (A557): Alt+N is the dead ~, so New note is
        // not listed with it, and This week, bound first to Alt+E (the dead ´), shows its next.
        val (commands, _) = commands(mapOf("journal.thisWeek" to listOf("Alt+E", "Mod+Shift+W")), layout = Layout.GENERIC)
        commands.register("journal.thisWeek", CommandHandler(run = {}))
        val items = commands.shortcutGroups().flatMap { it.items }
        assertFalse(items.toString(), items.any { it.label == "New Note" })
        val week = items.first { it.label == "This Week's Note" }
        assertEquals(KeyEvent.KEYCODE_W, week.keycode)
        assertTrue(week.modifiers and KeyEvent.META_CTRL_ON != 0)
        assertTrue(comboTypes("Alt+N", Layout.GENERIC))
        assertTrue(comboTypes("Alt+C", Layout.GENERIC))
        assertFalse(comboTypes("Mod+Alt+N", Layout.GENERIC))
        assertFalse(comboTypes("Alt+N", Layout.US))
    }
}
