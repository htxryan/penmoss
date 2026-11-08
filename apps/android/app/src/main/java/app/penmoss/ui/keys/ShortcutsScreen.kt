package app.penmoss.ui.keys

import android.content.res.Configuration
import android.view.KeyEvent as AndroidKeyEvent
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import app.penmoss.ui.square.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import app.penmoss.ui.square.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.penmoss.AppGraph
import app.penmoss.engine.keys.Bindings
import app.penmoss.engine.keys.Combos
import app.penmoss.engine.keys.ShortcutCommand
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive

/** What recording a combination for a command came to (the web's `ShortcutsSettings` rules). */
sealed interface Recorded {
    /** Escape: nothing changes. */
    data object Cancelled : Recorded

    /** A combination that cannot be bound here, and why, in the web's words. */
    data class Refused(val text: String) : Recorded

    /** Another command has it: asks before moving it. */
    data class Conflict(val combo: String, val others: List<ShortcutCommand>) : Recorded

    /** Bound. */
    data class Assign(val combo: String) : Recorded
}

/** Decides what recording [combo] for [id] does, as the web's Settings → Keyboard shortcuts does. */
fun recorded(id: String, combo: String, bindings: Bindings, typed: Boolean = false): Recorded {
    if (combo == "Escape") return Recorded.Cancelled
    // Meta (the Search or Windows key) is Android's own, and no other client names it.
    if ("Meta" in combo.split('+').dropLast(1)) return Recorded.Refused("Shortcuts with the Meta key are kept by Android.")
    val shown = Combos.format(combo)
    val own = bindings.catalogue.command(id)?.keys.orEmpty()
    // A command's own default is always fine (Undo keeps Ctrl+Z); otherwise the rules of A90.
    val problem = if (combo in own) null else Combos.problem(combo, bindings.catalogue.reserved)
    when (problem) {
        Combos.Problem.TYPES -> return Recorded.Refused("$shown would type a character: add Ctrl or Alt.")
        Combos.Problem.ALTGR -> return Recorded.Refused("$shown is AltGr on many keyboards, which types a character: use Ctrl+Shift or Alt without Ctrl.")
        Combos.Problem.RESERVED -> return Recorded.Refused("$shown is kept for copying, pasting, finding and editing text.")
        null -> Unit
    }
    // AltGr, or an Alt the layout types with: this keyboard types a character (review B1).
    if (typed) return Recorded.Refused("$shown types a character on this keyboard: add Ctrl.")
    if (combo in ANDROID_RESERVED) return Recorded.Refused("$shown is kept by Android.")
    // What the server stores (A490): never offered a combination it would refuse.
    if (Combos.storedProblem(JsonArray(listOf(JsonPrimitive(combo)))) != null) {
        return Recorded.Refused("$shown cannot be a shortcut.")
    }
    val others = bindings.conflicts(id, combo)
    return if (others.isEmpty()) Recorded.Assign(combo) else Recorded.Conflict(combo, others)
}

/** The writes a combination makes: [id] gets it alone; with [replace], the others lose it. */
fun assignments(id: String, combo: String, replace: Boolean, bindings: Bindings): List<Pair<String, List<String>>> {
    val moved = if (!replace) emptyList() else bindings.conflicts(id, combo).map { other ->
        other.id to bindings.keysOf(other.id).filter { Combos.normalise(it) != combo }
    }
    return moved + (id to listOf(combo))
}

/** A row's message: an error, a confirmation, or a conflict to settle. */
private sealed interface RowNotice {
    val id: String

    data class Said(override val id: String, val text: String, val error: Boolean) : RowNotice

    data class Clash(override val id: String, val combo: String, val others: List<ShortcutCommand>) : RowNotice
}

/** Whether a hardware keyboard is connected now (bindings can only be recorded with one). */
@Composable
fun hasHardwareKeyboard(): Boolean {
    val configuration = LocalConfiguration.current
    return configuration.keyboard != Configuration.KEYBOARD_NOKEYS &&
        configuration.hardKeyboardHidden == Configuration.HARDKEYBOARDHIDDEN_NO
}

/** Settings → Keyboard shortcuts (T40 P9, ST8, A495), with the synced bindings. */
@Composable
fun ShortcutsRoute(graph: AppGraph, onBack: () -> Unit) {
    val commands = LocalAppCommands.current
    val bindings by commands.bindings.collectAsStateWithLifecycle()
    val settings by graph.settings.collectAsStateWithLifecycle()
    ShortcutsScreen(
        bindings = bindings,
        keyboard = hasHardwareKeyboard(),
        canChange = settings.known,
        onSet = { id, keys -> graph.changeSetting(Bindings.PREFIX + id, keys?.let { list -> JsonArray(list.map(::JsonPrimitive)) }) },
        onRecording = { commands.recording = it },
        onBack = onBack,
    )
}

/**
 * Settings → Keyboard shortcuts (ST8, _adapted_): every command the phone runs, grouped by area as
 * the web groups them, with its keys as Android names them (Ctrl, Alt). With a hardware keyboard
 * connected, **Change** records a combination and reports a problem or a conflict in the web's
 * words; without one, the screen says to connect a keyboard. Remove and Reset need no keyboard.
 * Changes are the synced `keys.<id>` settings, so they apply here at once and reach the web and
 * the Mac. A clash that arrives by sync is listed at the top.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ShortcutsScreen(
    bindings: Bindings,
    keyboard: Boolean,
    canChange: Boolean,
    onSet: (id: String, keys: List<String>?) -> Unit,
    onBack: () -> Unit,
    onRecording: (Boolean) -> Unit = {},
    /** The keyboard's layout, to know a combination that types (review B1). */
    chars: KeyChars = LocalAppCommands.current.chars,
    /** Where each command runs on Android (A497); a command still to come shows no keys (S4). */
    coverage: (id: String, scope: String) -> Coverage? = AndroidCommands::coverage,
) {
    var filter by rememberSaveable { mutableStateOf("") }
    var recording by rememberSaveable { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<RowNotice?>(null) }
    val catalogue = bindings.catalogue
    val title = { id: String -> catalogue.command(id)?.title ?: id }
    val shown = catalogue.commands.filter { !it.hidden && coverage(it.id, it.scope).let { c -> c != null && c !is Coverage.NotHere } }
    val query = filter.trim().lowercase()
    val rows = shown.filter { command ->
        query.isEmpty() || command.title.lowercase().contains(query) || command.area.lowercase().contains(query) ||
            bindings.keysOf(command.id).any { Combos.format(it).lowercase().contains(query) }
    }
    val clashes = bindings.clashes()
    // A default or synced combination this keyboard types with never runs here (review S5, A557).
    val device = remember(keyboard) { physicalKeyboard() }
    val types = { combo: String -> comboTypes(combo, chars, device) }

    fun assign(id: String, combo: String, replace: Boolean) {
        for ((command, keys) in assignments(id, combo, replace, bindings)) onSet(command, keys)
        notice = RowNotice.Said(id, "${title(id)} is now ${Combos.format(combo)}.", error = false)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Keyboard Shortcuts") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } },
            )
        },
    ) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding).imePadding().testTag("shortcutList")) {
            item(key = "intro") {
                Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        "Changes sync to your other devices. Shortcuts need Ctrl or Alt so typing never runs a command. " +
                            "Meta+/ lists the ones that work where you are.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (!keyboard) {
                        Text(
                            "Connect a keyboard to change a shortcut.",
                            Modifier.testTag("shortcutsNeedKeyboard"),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                    if (!canChange) {
                        Text(
                            "Shortcuts can be changed here once the phone has synced with Penmoss.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                    if (clashes.isNotEmpty()) {
                        Text(
                            clashes.joinToString("; ", postfix = ".") {
                                "${Combos.format(it.combo)} is bound to both “${it.first.title}” and “${it.second.title}”"
                            },
                            Modifier.testTag("shortcutClashes").semantics { liveRegion = LiveRegionMode.Polite },
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                    OutlinedTextField(
                        value = filter,
                        onValueChange = { filter = it },
                        label = { Text("Search ${shown.size} commands") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth().testTag("shortcutSearch"),
                    )
                }
            }
            if (rows.isEmpty()) {
                item(key = "none") {
                    Text(
                        "No commands match “${filter.trim()}”.",
                        Modifier.padding(16.dp).testTag("shortcutsNone"),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            for ((area, commands) in rows.groupBy { it.area }) {
                item(key = "area-$area") {
                    Text(
                        area,
                        Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 4.dp).semantics { heading() },
                        style = MaterialTheme.typography.titleSmall,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
                items(commands, key = { it.id }) { command ->
                    ShortcutRow(
                        command = command,
                        later = (coverage(command.id, command.scope) as? Coverage.Later)?.slice?.substringBefore(" ("),
                        keys = bindings.keysOf(command.id),
                        types = types,
                        custom = bindings.isCustom(command.id),
                        canRecord = keyboard && canChange,
                        canChange = canChange,
                        notice = notice?.takeIf { it.id == command.id },
                        onChange = {
                            notice = null
                            recording = command.id
                        },
                        onRemove = {
                            notice = null
                            onSet(command.id, emptyList())
                        },
                        onReset = {
                            notice = null
                            onSet(command.id, null)
                        },
                        onMove = { combo ->
                            notice = null
                            assign(command.id, combo, replace = true)
                        },
                        onDismiss = { notice = null },
                    )
                }
            }
        }
    }

    recording?.let { id ->
        DisposableEffect(id) {
            onRecording(true)
            onDispose { onRecording(false) }
        }
        RecordDialog(
            title = title(id),
            chars = chars,
            onCombo = { combo, typed ->
                recording = null
                when (val outcome = recorded(id, combo, bindings, typed)) {
                    Recorded.Cancelled -> Unit
                    is Recorded.Refused -> notice = RowNotice.Said(id, outcome.text, error = true)
                    is Recorded.Conflict -> notice = RowNotice.Clash(id, outcome.combo, outcome.others)
                    is Recorded.Assign -> assign(id, outcome.combo, replace = false)
                }
            },
            onDismiss = { recording = null },
        )
    }
}

@Composable
private fun ShortcutRow(
    command: ShortcutCommand,
    /** The slice that brings this command to Android, while it does nothing here (review S4). */
    later: String?,
    keys: List<String>,
    /** Whether a combination types a character on this keyboard, so never runs (A557). */
    types: (String) -> Boolean,
    custom: Boolean,
    canRecord: Boolean,
    canChange: Boolean,
    notice: RowNotice?,
    onChange: () -> Unit,
    onRemove: () -> Unit,
    onReset: () -> Unit,
    onMove: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val keysText = when {
        later != null -> "Not on Android yet: arrives with $later"
        keys.isEmpty() -> "No shortcut"
        else -> keys.joinToString(" or ") { combo ->
            Combos.format(combo) + if (types(combo)) " (types a character on this keyboard)" else ""
        }
    }
    Column(Modifier.testTag("shortcut-${command.id}")) {
        ListItem(
            headlineContent = {
                Text(if (command.pending != null) "${command.title} · arrives with ${command.pending}" else command.title)
            },
            supportingContent = { Text(keysText, Modifier.testTag("keys-${command.id}")) },
            trailingContent = {
                if (later == null) Row {
                    if (canRecord) {
                        IconButton(onClick = onChange, modifier = Modifier.testTag("change-${command.id}")) {
                            Icon(Icons.Default.Edit, contentDescription = "Change the shortcut for ${command.title}")
                        }
                    }
                    if (canChange && keys.isNotEmpty()) {
                        IconButton(onClick = onRemove, modifier = Modifier.testTag("remove-${command.id}")) {
                            Icon(Icons.Default.Close, contentDescription = "Remove the shortcut for ${command.title}")
                        }
                    }
                    if (canChange && custom) {
                        IconButton(onClick = onReset, modifier = Modifier.testTag("reset-${command.id}")) {
                            Icon(Icons.Default.Refresh, contentDescription = "Reset the shortcut for ${command.title}")
                        }
                    }
                }
            },
        )
        when (notice) {
            null -> Unit
            is RowNotice.Said -> Text(
                notice.text,
                Modifier.padding(horizontal = 16.dp, vertical = 4.dp).testTag("notice-${command.id}")
                    .semantics { liveRegion = LiveRegionMode.Polite },
                style = MaterialTheme.typography.bodyMedium,
                color = if (notice.error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            )
            is RowNotice.Clash -> Column(Modifier.padding(horizontal = 16.dp, vertical = 4.dp).testTag("conflict-${command.id}")) {
                Text(
                    "${Combos.format(notice.combo)} is used by ${notice.others.joinToString(" and ") { "“${it.title}”" }}.",
                    Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { onMove(notice.combo) }, modifier = Modifier.testTag("useHere")) { Text("Use It Here Instead") }
                    TextButton(onClick = onDismiss) { Text("Cancel") }
                }
            }
        }
    }
}

/** What the recorder does with a key press. */
sealed interface RecorderKey {
    /** Not its: Back, the volume and media keys, any key with no name (review S10). */
    data object Pass : RecorderKey

    /** Taken, and it keeps listening: a modifier alone, or a held key's repeat. */
    data object Listen : RecorderKey

    /** The combination pressed, and whether the layout types with it (review B1). */
    data class Combo(val combo: String, val typed: Boolean) : RecorderKey
}

/** How the recorder reads [event]. */
fun recorderKey(event: AndroidKeyEvent, chars: KeyChars): RecorderKey {
    if (event.action != AndroidKeyEvent.ACTION_DOWN) return RecorderKey.Pass
    val combo = KeyNames.comboOf(event)
        ?: return if (AndroidKeyEvent.isModifierKey(event.keyCode)) RecorderKey.Listen else RecorderKey.Pass
    if (event.repeatCount > 0) return RecorderKey.Listen
    return RecorderKey.Combo(combo, typesCharacter(event, chars))
}

/**
 * Records the next combination (the dispatcher stands aside meanwhile): a lone modifier keeps it
 * listening; Escape cancels; Back closes it. A dialog of its own, so the keys reach it and nothing else.
 */
@Composable
private fun RecordDialog(title: String, chars: KeyChars, onCombo: (combo: String, typed: Boolean) -> Unit, onDismiss: () -> Unit) {
    val focus = remember { FocusRequester() }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Change the shortcut") },
        text = {
            Text(
                "Press the new keys for “$title”. Esc cancels.",
                Modifier
                    .focusRequester(focus)
                    .focusable()
                    .onPreviewKeyEvent { event ->
                        val native = event.nativeKeyEvent
                        if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                        when (val key = recorderKey(native, chars)) {
                            RecorderKey.Pass -> false
                            RecorderKey.Listen -> true
                            is RecorderKey.Combo -> {
                                onCombo(key.combo, key.typed)
                                true
                            }
                        }
                    }
                    .testTag("shortcutRecorder")
                    .semantics { contentDescription = "Listening: press the new keys for $title" },
            )
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
    // The dialog's own window takes focus a frame or two after it opens: asked earlier, the
    // recorder would stay unfocused and miss the keys.
    val window = LocalWindowInfo.current
    LaunchedEffect(window) {
        runCatching { focus.requestFocus() }
        snapshotFlow { window.isWindowFocused }.first { it }
        focus.requestFocus()
    }
}
