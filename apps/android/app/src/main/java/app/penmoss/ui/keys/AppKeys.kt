package app.penmoss.ui.keys

import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.KeyboardShortcutGroup
import android.view.KeyboardShortcutInfo
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.staticCompositionLocalOf
import app.penmoss.engine.keys.Bindings
import app.penmoss.engine.keys.Combos
import app.penmoss.engine.keys.ShortcutCatalogue
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Android's key codes by the names the web's combinations use (T40 P9, A494): letters and digits
 * by the key, punctuation by its US position (as `KeyboardEvent.code`), F-keys, and the named keys.
 * A modifier alone has no name. Checked against `contract/shortcuts-v1.json`'s events.
 */
object KeyNames {
    private val NAMED: Map<Int, String> = mapOf(
        KeyEvent.KEYCODE_SLASH to "/",
        KeyEvent.KEYCODE_PERIOD to ".",
        KeyEvent.KEYCODE_COMMA to ",",
        KeyEvent.KEYCODE_BACKSLASH to "\\",
        KeyEvent.KEYCODE_LEFT_BRACKET to "[",
        KeyEvent.KEYCODE_RIGHT_BRACKET to "]",
        KeyEvent.KEYCODE_SEMICOLON to ";",
        KeyEvent.KEYCODE_APOSTROPHE to "'",
        KeyEvent.KEYCODE_MINUS to "-",
        KeyEvent.KEYCODE_EQUALS to "=",
        KeyEvent.KEYCODE_GRAVE to "`",
        KeyEvent.KEYCODE_SPACE to "Space",
        KeyEvent.KEYCODE_ENTER to "Enter",
        KeyEvent.KEYCODE_NUMPAD_ENTER to "Enter",
        KeyEvent.KEYCODE_ESCAPE to "Escape",
        KeyEvent.KEYCODE_TAB to "Tab",
        KeyEvent.KEYCODE_DEL to "Backspace",
        KeyEvent.KEYCODE_FORWARD_DEL to "Delete",
        KeyEvent.KEYCODE_MOVE_HOME to "Home",
        KeyEvent.KEYCODE_MOVE_END to "End",
        KeyEvent.KEYCODE_PAGE_UP to "PageUp",
        KeyEvent.KEYCODE_PAGE_DOWN to "PageDown",
        KeyEvent.KEYCODE_DPAD_UP to "Up",
        KeyEvent.KEYCODE_DPAD_DOWN to "Down",
        KeyEvent.KEYCODE_DPAD_LEFT to "Left",
        KeyEvent.KEYCODE_DPAD_RIGHT to "Right",
    )

    /** The name of [keyCode], or null for a modifier or a key the web never names. */
    fun of(keyCode: Int): String? = when (keyCode) {
        in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z -> ('A' + (keyCode - KeyEvent.KEYCODE_A)).toString()
        in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> ('0' + (keyCode - KeyEvent.KEYCODE_0)).toString()
        in KeyEvent.KEYCODE_NUMPAD_0..KeyEvent.KEYCODE_NUMPAD_9 -> ('0' + (keyCode - KeyEvent.KEYCODE_NUMPAD_0)).toString()
        in KeyEvent.KEYCODE_F1..KeyEvent.KEYCODE_F12 -> "F${keyCode - KeyEvent.KEYCODE_F1 + 1}"
        else -> NAMED[keyCode]
    }

    /** The key code for a combination's key, for Android's shortcut helper; null when it has none. */
    fun codeOf(name: String): Int? = when {
        name.length == 1 && name[0] in 'A'..'Z' -> KeyEvent.KEYCODE_A + (name[0] - 'A')
        name.length == 1 && name[0] in '0'..'9' -> KeyEvent.KEYCODE_0 + (name[0] - '0')
        name.matches(Regex("^F([1-9]|1[0-2])$")) -> KeyEvent.KEYCODE_F1 + name.drop(1).toInt() - 1
        else -> NAMED.entries.firstOrNull { it.value == name }?.key
    }

    /** The combination a key press stands for, as the web reads it off Apple platforms; null for a modifier. */
    fun comboOf(event: KeyEvent): String? =
        Combos.of(of(event.keyCode), event.isCtrlPressed, event.isAltPressed, event.isShiftPressed, event.isMetaPressed)
}

/**
 * The character a key press types on its keyboard's layout, or 0 for none (T40 P9 review B1):
 * `KeyEvent.getUnicodeChar` with the press's own meta state, through the device's
 * `KeyCharacterMap`. A seam, so tests can give a Polish or German layout.
 */
fun interface KeyChars {
    fun of(event: KeyEvent): Int

    companion object {
        /** The keyboard's own layout. */
        val Layout = KeyChars { event -> runCatching { event.getUnicodeChar(event.metaState) }.getOrDefault(0) }
    }
}

/**
 * Whether [event] types rather than commands (A494, review B1): a press without Ctrl that the
 * layout gives a character. On Android, AltGr is the right Alt key (`META_ALT_RIGHT_ON`, no
 * Ctrl), so AltGr+N on a Polish layout types ń, and Alt+N on Android's generic layout is the
 * dead ~ for ñ: neither is ever Alt+N. A US layout gives Alt+N no character, so there it is a
 * shortcut.
 */
fun typesCharacter(event: KeyEvent, chars: KeyChars): Boolean = !event.isCtrlPressed && chars.of(event) != 0

/**
 * Whether [combo], pressed on the keyboard [deviceId], types a character instead of running
 * (T40 P9 review S5, A557): Alt+N and Alt+C on Android's Generic layout, the one a keyboard with
 * no layout chosen gets. Pressed with the left Alt, as a combination's Alt means.
 */
fun comboTypes(combo: String, chars: KeyChars, deviceId: Int = physicalKeyboard()): Boolean {
    val (modifiers, key) = Combos.parse(combo)
    val code = KeyNames.codeOf(key) ?: return false
    var meta = 0
    if ("Mod" in modifiers || "Ctrl" in modifiers) meta = meta or KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON
    if ("Alt" in modifiers) meta = meta or KeyEvent.META_ALT_ON or KeyEvent.META_ALT_LEFT_ON
    if ("Shift" in modifiers) meta = meta or KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON
    return typesCharacter(KeyEvent(0L, 0L, KeyEvent.ACTION_DOWN, code, 0, meta, deviceId, 0), chars)
}

/** The connected hardware keyboard, whose layout a combination is typed on; else the virtual one. */
fun physicalKeyboard(): Int = InputDevice.getDeviceIds().firstOrNull { id ->
    InputDevice.getDevice(id)?.let { !it.isVirtual && it.keyboardType == InputDevice.KEYBOARD_TYPE_ALPHABETIC } == true
} ?: KeyCharacterMap.VIRTUAL_KEYBOARD

/**
 * Combinations Android keeps for itself or its text fields with a hardware keyboard (T40 P9,
 * A495): Ctrl+Space switches the keyboard's language and Alt+Tab the apps, and Ctrl+←/→,
 * Ctrl+Backspace and the like move and delete by word in a text field (review N8). Never
 * recorded here, and never dispatched ahead of the focused view.
 */
val ANDROID_RESERVED: Set<String> = setOf(
    "Mod+Space",
    "Mod+Shift+Space",
    "Alt+Tab",
    "Alt+Shift+Tab",
    "Mod+Left",
    "Mod+Right",
    "Mod+Shift+Left",
    "Mod+Shift+Right",
    "Mod+Backspace",
    "Mod+Delete",
    "Alt+Backspace",
)

/** What runs a command now, and whether it can (absent: always while registered). */
class CommandHandler(val run: () -> Unit, val enabled: () -> Boolean = { true })

/**
 * The app's commands at run time (T40 P9, PL9, A494), as the web's `CommandCenter` has them:
 * which commands can run now (handlers registered by the screen in front, a stack, so the latest
 * wins until it goes), the user's bindings over the defaults, and the one native dispatcher.
 * Editor commands are the page's (it dispatches its own keys while the note has focus, A493);
 * folder-row commands are their rows'. Every other key with Ctrl, Alt or an F-key is tried here
 * first, ahead of the focused view, unless the editor's WebView has focus.
 */
class AppCommands(
    val catalogue: ShortcutCatalogue = ShortcutCatalogue.bundled,
    /** The keyboard's layout: a press it gives a character types (review B1). */
    val chars: KeyChars = KeyChars.Layout,
) {
    private val handlers = HashMap<String, ArrayList<CommandHandler>>()
    private val takers = java.util.concurrent.CopyOnWriteArrayList<(KeyEvent) -> Boolean>()
    private val _bindings = MutableStateFlow(Bindings(catalogue, emptyMap()))
    private val _revision = MutableStateFlow(0)
    private val _raw = MutableStateFlow<Map<String, List<String>>>(emptyMap())

    /** The bindings in effect (A90 applied), from the synced settings. */
    val bindings: StateFlow<Bindings> = _bindings.asStateFlow()

    /** The user's `keys.*` lists as synced, for the page, which applies A90 itself. */
    val raw: StateFlow<Map<String, List<String>>> = _raw.asStateFlow()

    /** Bumped whenever a handler comes or goes. */
    val revision: StateFlow<Int> = _revision.asStateFlow()

    /** While Settings → Keyboard shortcuts records a combination, the dispatcher stands aside. */
    @Volatile
    var recording = false

    /** A note's editor is open in front: its commands are listed in the shortcut helper. */
    @Volatile
    var editorOpen = false

    /** Follows the synced settings (the settings channel, ST2): `keys.<id>` over the defaults. */
    fun follow(settings: JsonObject) {
        val next = Bindings.of(catalogue, settings)
        if (next.usable != _bindings.value.usable) _bindings.value = next
        val lists = settings.filterKeys { it.startsWith(Bindings.PREFIX) }.mapNotNull { (key, value) ->
            val list = (value as? JsonArray)?.map { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content ?: return@mapNotNull null }
                ?: return@mapNotNull null
            key.removePrefix(Bindings.PREFIX) to list
        }.toMap()
        if (lists != _raw.value) _raw.value = lists
    }

    /** Registers what runs [id]; the latest registration wins until the returned undo runs. */
    fun register(id: String, handler: CommandHandler): () -> Unit {
        require(catalogue.command(id) != null) { "Unknown command $id" }
        synchronized(handlers) { handlers.getOrPut(id) { ArrayList() }.add(handler) }
        _revision.update { it + 1 }
        return {
            synchronized(handlers) {
                val stack = handlers[id]
                val at = stack?.lastIndexOf(handler) ?: -1
                if (stack != null && at >= 0) stack.removeAt(at)
            }
            _revision.update { it + 1 }
        }
    }

    /**
     * Adds a modal key-taker (T40 P6's key router, folded in here): the recent-notes switcher
     * (FD7), which while open takes every key, a key's release and the note's page's keys
     * included. Takers see each key first, in the order added; the returned function removes it.
     */
    fun take(taker: (KeyEvent) -> Boolean): () -> Unit {
        takers += taker
        return { takers -= taker }
    }

    private fun handlerOf(id: String): CommandHandler? = synchronized(handlers) { handlers[id]?.lastOrNull() }

    /** Whether [id] can run now. */
    fun available(id: String): Boolean = handlerOf(id)?.let { it.enabled() } == true

    /** The commands that can run now, by id. */
    fun availableIds(): List<String> = synchronized(handlers) { handlers.keys.toList() }.filter(::available).sorted()

    /** Runs [id]; false when nothing can run it now. */
    fun run(id: String): Boolean {
        val handler = handlerOf(id)?.takeIf { it.enabled() } ?: return false
        handler.run()
        return true
    }

    /**
     * The native dispatcher (A494), from the activity's `dispatchKeyEvent`: true when a command
     * took the key. Only key presses with Ctrl or Alt, or F-keys, are considered (A90: never a key
     * that types or that the IME needs); a key whose editor WebView has focus is the page's
     * ([inEditor]), which dispatches it and sends the app's commands back. A modal taker ([take])
     * sees every key before that.
     */
    fun handle(event: KeyEvent, inEditor: Boolean): Boolean {
        if (recording) return false
        if (takers.any { it(event) }) return true
        if (inEditor || event.action != KeyEvent.ACTION_DOWN) return false
        val function = event.keyCode in KeyEvent.KEYCODE_F1..KeyEvent.KEYCODE_F12
        if (!event.isCtrlPressed && !event.isAltPressed && !function) return false
        if (!mayTake(event)) return false
        val combo = KeyNames.comboOf(event) ?: return false
        // A held key repeats: the command ran once, on the first press (review S11). The repeats
        // are still taken, so they do not reach the view either.
        if (event.repeatCount > 0) return runnable(combo) != null
        return dispatch(combo)
    }

    /**
     * Whether [event] may be a command at all: not a press the layout types with (AltGr and Alt
     * that type ń, @ or a dead accent, review B1), nor a combination Android keeps. Every command
     * gets this check, the recent-notes switcher's keys too while it is closed (review S3, A556).
     */
    fun mayTake(event: KeyEvent): Boolean {
        if (typesCharacter(event, chars)) return false
        val combo = KeyNames.comboOf(event) ?: return true
        return combo !in ANDROID_RESERVED
    }

    private fun runnable(combo: String): String? =
        bindings.value.commandsFor(combo).firstOrNull { it.scope == "global" && available(it.id) }?.id

    /** Runs what [combo] means here: the first available global command bound to it. */
    fun dispatch(combo: String): Boolean {
        val id = runnable(combo) ?: return false
        return run(id)
    }

    /**
     * Android's own Meta+/ keyboard-shortcuts helper (FD8, A495): the commands that can run now,
     * grouped by the web's areas, each with its first combination this keyboard can type, and the
     * editor's while a note is open.
     */
    fun shortcutGroups(): List<KeyboardShortcutGroup> {
        val bindings = bindings.value
        val now = availableIds().toSet()
        val keyboard = physicalKeyboard()
        val listed = catalogue.commands.filter { command ->
            command.pending == null && !command.hidden &&
                (command.id in now || (editorOpen && command.scope == "editor"))
        }
        return listed.groupBy { it.area }.mapNotNull { (area, commands) ->
            val items = commands.mapNotNull { command ->
                // Never one this keyboard types with (A557): it would not run.
                val combo = bindings.keysOf(command.id).firstOrNull { !comboTypes(it, chars, keyboard) } ?: return@mapNotNull null
                infoOf(command.title, combo)
            }
            items.takeIf { it.isNotEmpty() }?.let { KeyboardShortcutGroup(area, it) }
        }
    }

    private fun infoOf(title: String, combo: String): KeyboardShortcutInfo? {
        val (modifiers, key) = Combos.parse(combo)
        val code = KeyNames.codeOf(key) ?: return null
        var meta = 0
        if ("Mod" in modifiers) meta = meta or KeyEvent.META_CTRL_ON
        if ("Alt" in modifiers) meta = meta or KeyEvent.META_ALT_ON
        if ("Shift" in modifiers) meta = meta or KeyEvent.META_SHIFT_ON
        if ("Ctrl" in modifiers) return null
        return KeyboardShortcutInfo(title, code, meta)
    }
}

/** The activity's [AppCommands]; a fresh one where none is provided (screen tests). */
val LocalAppCommands = staticCompositionLocalOf { AppCommands() }

/**
 * Registers what runs [id] while this composable is shown (T40 P9): the latest registration wins,
 * so a screen in front overrides the root's (a folder's New note files there). [enabled] is read
 * whenever the command is tried; [run] is the latest passed.
 */
@Composable
fun RegisterCommand(id: String, enabled: () -> Boolean = { true }, run: () -> Unit) {
    val commands = LocalAppCommands.current
    val latest by rememberUpdatedState(run)
    val can by rememberUpdatedState(enabled)
    DisposableEffect(commands, id) {
        val undo = commands.register(id, CommandHandler(run = { latest() }, enabled = { can() }))
        onDispose(undo)
    }
}
